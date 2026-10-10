/**
 * FACTURAS DE COMPRA LEÍDAS CON IA (0153, 9/10/2026, pedido del dueño)
 * ============================================================================
 * «Meter tu IA en mi sistema para que cargue mis facturas de compra, lo más
 * optimizado, dinámico y lógico posible.» Decisiones del dueño:
 *
 *   · TODO pasa por la IA (PDF, fotos, escaneos). La lectura de PDF anterior
 *     (recetas, estructuras, lectura automática) se eliminó.
 *   · Primero el modelo barato (Haiku). Si la cuenta NO cierra, se reintenta
 *     solo con el fuerte (Sonnet) y queda la lectura que mejor cierra.
 *   · Los productos los reconoce el SISTEMA con lo aprendido de cada
 *     proveedor; lo desconocido se mapea a mano entre candidatos, o se le
 *     pide a la IA que elija entre esos candidatos. La IA NUNCA crea nada.
 *   · Siempre queda para revisar: nada se carga solo.
 *   · Se lee sola al subir (también en tandas), con un tope de gasto por mes.
 *
 * LA COLA: las lecturas corren de a dos, en segundo plano, en este proceso.
 * Una lectura se «toma» con un UPDATE condicional (en_cola → leyendo): dos
 * pedidos sobre la misma factura no la leen dos veces. Si el servidor se
 * reinicia en el medio, al arrancar se vuelve a encolar lo que quedó.
 *
 * Solo el superadmin y el admin (lo controla el controlador).
 */
import { BadRequestException, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { DRIZZLE, Database } from '../../db/drizzle';
import {
  configuracion, facturaArchivos, facturaLecturas, facturasIaConfig, facturasIaUsos, productoProveedores, productos,
  proveedorArticulos, proveedores,
} from '../../db/schema';
import { clave, fechaDeTexto, r2, soloDigitos } from '../comun';
import { ErrorIa, IA, llamarIa, type Uso } from './anthropic';
import { candidatos, elegido, tokensDe } from './candidatos';
import { controlar, descuentoEquivalente, factorDescuentos } from './control';
import { ESQUEMA, SISTEMA, contenidoDe, limpiar } from './lectura';
import { costoUsd } from './precios';

const ZONA = 'America/Argentina/Buenos_Aires';
const CONCURRENCIA = 2;
/** Salida máxima de una lectura: ~60 tokens por renglón, con aire para 250 renglones. */
const MAX_TOKENS_LECTURA = 16_000;
/** El aviso del consumo: al 80 % del tope. */
const AVISO_TOPE = 0.8;

const SISTEMA_ELEGIR = `Para cada renglón de una factura de compra, elegís cuál de los productos CANDIDATOS de nuestro catálogo es el MISMO artículo (misma marca, mismo producto, mismo tamaño o presentación). Si ninguno es claramente el mismo, devolvé 0: es mejor dejarlo sin producto que elegir uno parecido. No adivines.`;
const ESQUEMA_ELEGIR = {
  type: 'object', additionalProperties: false, required: ['elecciones'],
  properties: {
    elecciones: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['renglon', 'productoId'], properties: { renglon: { type: 'integer' }, productoId: { type: 'integer' } } },
    },
  },
};

/** El código con el que se aprende un renglón: el del papel, o la descripción si no trae código. */
export const codigoDeRenglon = (r: { codigo: string; descripcion: string }) => r.codigo || `D:${clave(r.descripcion).slice(0, 38)}`;

@Injectable()
export class FacturasIaService implements OnModuleInit {
  private readonly log = new Logger('FacturasIA');
  private readonly cola: number[] = [];
  private corriendo = 0;

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** Lo que quedó en cola o a medio leer cuando se apagó el servidor vuelve a la cola. */
  onModuleInit() {
    setTimeout(() => {
      if (!IA.configurado) return;
      this.db.update(facturaLecturas).set({ iaEstado: 'en_cola' })
        .where(and(eq(facturaLecturas.estado, 'pendiente'), inArray(facturaLecturas.iaEstado, ['en_cola', 'leyendo'])))
        .returning({ id: facturaLecturas.id })
        .then((r) => { for (const x of r) this.meter(x.id); })
        .catch((e) => this.log.warn(`no se pudo reanudar la cola: ${e.message}`));
    }, 5_000).unref?.();
  }

  /* ============================ consumo y tope ============================ */

  private async config() {
    const [c] = await this.db.select().from(facturasIaConfig).where(eq(facturasIaConfig.id, 1)).limit(1);
    return { topeMensualUsd: Number(c?.topeMensualUsd ?? 5), leerAlSubir: c?.leerAlSubir ?? true };
  }

  private async gastadoMes() {
    const r: any = await this.db.execute(sql`
      select coalesce(sum(costo_usd), 0) as usd, count(*)::int as llamadas,
        count(distinct lectura_id) filter (where tarea = 'leer' and ok)::int as leidas
      from facturas_ia_usos
      where fecha >= (date_trunc('month', now() at time zone ${ZONA}) at time zone ${ZONA})`);
    const f = (r.rows ?? r)[0] ?? {};
    return { usd: Number(f.usd) || 0, llamadas: Number(f.llamadas) || 0, leidas: Number(f.leidas) || 0 };
  }

  private async registrar(o: { lecturaId: number | null; tarea: 'leer' | 'elegir'; modelo: string; uso?: Uso; ok: boolean; error?: string; usuarioId?: number | null }) {
    const u = o.uso ?? { entrada: 0, salida: 0, cacheEscritura: 0, cacheLectura: 0 };
    const costo = costoUsd(o.modelo, u);
    await this.db.insert(facturasIaUsos).values({
      lecturaId: o.lecturaId, tarea: o.tarea, modelo: o.modelo,
      tokensEntrada: u.entrada, tokensSalida: u.salida, tokensCacheEscritura: u.cacheEscritura, tokensCacheLectura: u.cacheLectura,
      costoUsd: costo, ok: o.ok, error: (o.error ?? '').slice(0, 300), usuarioId: o.usuarioId ?? null,
    });
    return costo;
  }

  /** El tablero de la pestaña «Lectura con IA»: si está andando, cuánto se gastó y en qué. */
  async estado() {
    const [cfg, mes, enCola, ultimos] = await Promise.all([
      this.config(), this.gastadoMes(),
      this.db.select({ n: sql<number>`count(*)::int` }).from(facturaLecturas)
        .where(and(eq(facturaLecturas.estado, 'pendiente'), inArray(facturaLecturas.iaEstado, ['en_cola', 'leyendo']))),
      this.db.select().from(facturasIaUsos).orderBy(desc(facturasIaUsos.id)).limit(30),
    ]);
    return {
      configurado: IA.configurado,
      modeloRapido: IA.modeloRapido, modeloFuerte: IA.modeloFuerte,
      ...cfg,
      gastadoMesUsd: r2(mes.usd * 10_000) / 10_000,
      llamadasMes: mes.llamadas, leidasMes: mes.leidas,
      promedioPorFacturaUsd: mes.leidas ? Math.round((mes.usd / mes.leidas) * 1_000_000) / 1_000_000 : null,
      usoTope: cfg.topeMensualUsd > 0 ? Math.round((mes.usd / cfg.topeMensualUsd) * 1000) / 10 : 100,
      avisoTope: cfg.topeMensualUsd <= 0 || mes.usd >= cfg.topeMensualUsd * AVISO_TOPE,
      enCola: Number(enCola[0]?.n) || 0,
      ultimos,
    };
  }

  async guardarConfig(dto: { topeMensualUsd?: number; leerAlSubir?: boolean }) {
    const patch: any = { actualizadoEn: new Date() };
    if (dto.topeMensualUsd != null) patch.topeMensualUsd = Math.round(dto.topeMensualUsd * 100) / 100;
    if (dto.leerAlSubir != null) patch.leerAlSubir = dto.leerAlSubir;
    await this.db.update(facturasIaConfig).set(patch).where(eq(facturasIaConfig.id, 1));
    /* Si se subió el tope, lo que había quedado frenado por el tope vuelve a la cola. */
    if (dto.topeMensualUsd != null) await this.encolarPendientes({ soloTope: true });
    return this.estado();
  }

  /* ============================ la cola ============================ */

  private meter(id: number) {
    if (!this.cola.includes(id)) this.cola.push(id);
    this.bombear();
  }

  private bombear() {
    while (this.corriendo < CONCURRENCIA && this.cola.length) {
      const id = this.cola.shift()!;
      this.corriendo++;
      this.leerUna(id)
        .catch((e) => this.log.error(`lectura ${id}: ${e?.message ?? e}`))
        .finally(() => { this.corriendo--; this.bombear(); });
    }
  }

  /** Pone a leer estas facturas (pendientes, con papel, que no estén ya en la cola). */
  async encolar(ids: number[]) {
    if (!IA.configurado) throw new BadRequestException('La lectura con IA no está configurada: falta la clave (ANTHROPIC_API_KEY) en el servidor.');
    if (!ids.length) return { encoladas: 0 };
    const r = await this.db.update(facturaLecturas).set({ iaEstado: 'en_cola' })
      .where(and(
        inArray(facturaLecturas.id, ids), eq(facturaLecturas.estado, 'pendiente'),
        sql`${facturaLecturas.iaEstado} not in ('en_cola', 'leyendo')`,
        sql`exists (select 1 from ${facturaArchivos} a where a.lectura_id = ${facturaLecturas.id})`,
      ))
      .returning({ id: facturaLecturas.id });
    for (const x of r) this.meter(x.id);
    return { encoladas: r.length };
  }

  /** «Leer todas»: las pendientes sin leer, con error o frenadas por el tope. */
  async encolarPendientes(o: { soloTope?: boolean } = {}) {
    if (!IA.configurado) return { encoladas: 0 };
    const filas = await this.db.select({ id: facturaLecturas.id }).from(facturaLecturas).where(and(
      eq(facturaLecturas.estado, 'pendiente'),
      o.soloTope ? eq(facturaLecturas.iaEstado, 'tope') : inArray(facturaLecturas.iaEstado, ['', 'error', 'tope']),
    )).orderBy(asc(facturaLecturas.id));
    return this.encolar(filas.map((f) => f.id));
  }

  /** Al subir una factura: se lee sola si está configurado (y encendido). */
  async alSubir(id: number) {
    if (!IA.configurado) return;
    if ((await this.config()).leerAlSubir) await this.encolar([id]).catch(() => undefined);
  }

  /** Cambiaron las páginas: lo leído ya no vale. Se vuelve a leer si se lee al subir. */
  async invalidar(id: number) {
    await this.db.update(facturaLecturas).set({ iaEstado: '', ia: null })
      .where(and(eq(facturaLecturas.id, id), sql`${facturaLecturas.iaEstado} <> 'leyendo'`));
    await this.alSubir(id);
  }

  /* ============================ leer una factura ============================ */

  private async receptor() {
    const [c] = await this.db.select().from(configuracion).where(eq(configuracion.clave, 'empresa')).limit(1);
    const v: any = c?.valor ?? {};
    return { nombre: String(v.razonSocial || v.nombre || ''), cuit: soloDigitos(v.cuit) };
  }

  private async intento(modelo: string, contenido: any[], lecturaId: number, totalQr: number, propio: string) {
    try {
      const r = await llamarIa({ modelo, sistema: SISTEMA, contenido, esquema: ESQUEMA, maxTokens: MAX_TOKENS_LECTURA });
      const costo = await this.registrar({ lecturaId, tarea: 'leer', modelo, uso: r.uso, ok: true });
      const leida = limpiar(r.json, propio);
      return { modelo, costo, uso: r.uso, leida, control: controlar(leida, totalQr), error: null as string | null };
    } catch (e) {
      const err = e as ErrorIa & { uso?: Uso };
      const costo = await this.registrar({ lecturaId, tarea: 'leer', modelo, uso: err.uso, ok: false, error: err.message });
      return { modelo, costo, uso: err.uso ?? null, leida: null, control: null, error: err.message || 'Error al leer con la IA.', reintentable: !!err.reintentable };
    }
  }

  private async leerUna(id: number) {
    /* La toma: solo una corrida lee cada factura. */
    const tomada = await this.db.update(facturaLecturas).set({ iaEstado: 'leyendo' })
      .where(and(eq(facturaLecturas.id, id), eq(facturaLecturas.estado, 'pendiente'), eq(facturaLecturas.iaEstado, 'en_cola')))
      .returning();
    const l = tomada[0];
    if (!l) return;
    const fin = (iaEstado: string, ia: any) => this.db.update(facturaLecturas).set({ iaEstado, ia })
      .where(and(eq(facturaLecturas.id, id), eq(facturaLecturas.iaEstado, 'leyendo')));

    const cfg = await this.config();
    if ((await this.gastadoMes()).usd >= cfg.topeMensualUsd) {
      await fin('tope', { error: `Se llegó al tope de gasto del mes (USD ${cfg.topeMensualUsd}). Subilo en «Lectura con IA» o cargala a mano.` });
      return;
    }
    const archivos = await this.db.select({ mime: facturaArchivos.mime, data: facturaArchivos.data })
      .from(facturaArchivos).where(eq(facturaArchivos.lecturaId, id)).orderBy(asc(facturaArchivos.id));
    if (!archivos.length) { await fin('error', { error: 'La factura no tiene páginas para leer.' }); return; }

    const receptor = await this.receptor();
    const contenido = contenidoDe(archivos, receptor);
    const totalQr = l.leido ? Number(l.total) || 0 : 0;
    const intentos: any[] = [];
    let elegida = await this.intento(IA.modeloRapido, contenido, id, totalQr, receptor.cuit);
    intentos.push(elegida);
    /* Si no cierra (o falló), el modelo fuerte. Salvo que el problema sea la clave o el saldo: ahí falla igual. */
    const fatal = !!elegida.error && /clave|saldo|configurada/i.test(elegida.error);
    if (!elegida.control?.cierra && !fatal && IA.modeloFuerte !== IA.modeloRapido && (await this.gastadoMes()).usd < cfg.topeMensualUsd) {
      const fuerte = await this.intento(IA.modeloFuerte, contenido, id, totalQr, receptor.cuit);
      intentos.push(fuerte);
      const peor = (x: typeof elegida) => (x.control ? x.control.problemas.length : 99);
      if (fuerte.leida && (!elegida.leida || peor(fuerte) <= peor(elegida))) elegida = fuerte;
    }
    const resumenIntentos = intentos.map((x) => ({ modelo: x.modelo, costoUsd: x.costo, cierra: !!x.control?.cierra, error: x.error }));
    const costoTotal = Math.round(intentos.reduce((a, x) => a + x.costo, 0) * 1_000_000) / 1_000_000;
    if (!elegida.leida) {
      await fin('error', { error: elegida.error, intentos: resumenIntentos, costoUsd: costoTotal, leidoEn: new Date().toISOString() });
      return;
    }

    const leida = elegida.leida;
    await fin('lista', {
      ...leida, control: elegida.control, modelo: elegida.modelo, intentos: resumenIntentos,
      costoUsd: costoTotal, leidoEn: new Date().toISOString(), sugeridos: {},
    });
    await this.completarEncabezado(l, leida);
  }

  /**
   * Lo que el QR no dio (o no hubo QR), sale de lo leído: tipo, letra, número,
   * fecha, total, CAE y el proveedor por su CUIT. Lo que ya estaba (del QR o
   * corregido a mano) NO se pisa; lo que había puesto una lectura ANTERIOR de
   * la IA (sigue igual a lo que ella dijo) sí: «Leer de nuevo» corrige.
   */
  private async completarEncabezado(l: typeof facturaLecturas.$inferSelect, x: ReturnType<typeof limpiar>) {
    const e = x.encabezado;
    const antes: any = l.leido ? null : l.ia;
    const ae = antes?.encabezado ?? {};
    /** Vacío, o todavía lo que dijo la IA la vez anterior (nadie lo tocó). */
    const libre = (actual: unknown, previo: unknown) => !actual || (antes != null && String(actual) === String(previo ?? ''));
    const mismoDia = (f: Date | null, previo: unknown) => !!f && fechaDeTexto(String(previo ?? ''))?.getTime() === f.getTime();
    const patch: any = {};
    if (e.tipo && e.tipo !== l.tipo && libre(l.tipo, ae.tipo)) patch.tipo = e.tipo;
    if (e.letra && e.letra !== l.letra && libre(l.letra, ae.letra)) patch.letra = e.letra;
    if (e.puntoVenta && libre(l.puntoVenta, ae.puntoVenta)) patch.puntoVenta = e.puntoVenta;
    if (e.numero && libre(l.numero, ae.numero)) patch.numero = e.numero;
    if (e.fecha && (!l.fecha || (antes != null && mismoDia(l.fecha, ae.fecha)))) patch.fecha = fechaDeTexto(e.fecha);
    if (x.pie.total > 0 && libre(Number(l.total) > 0 ? l.total : 0, antes?.pie?.total)) patch.total = x.pie.total;
    if (e.cae && libre(l.cae, ae.cae)) patch.cae = e.cae;
    if (e.cuitEmisor && libre(l.cuit, ae.cuitEmisor)) patch.cuit = e.cuitEmisor;
    if (!l.moneda && e.moneda) patch.moneda = e.moneda;
    if (!l.cuitReceptor && e.cuitReceptor) patch.cuitReceptor = e.cuitReceptor;
    const notas: string[] = [];
    if (!l.proveedorId && e.cuitEmisor) {
      const [p] = await this.db.select({ id: proveedores.id }).from(proveedores)
        .where(sql`regexp_replace(${proveedores.cuit}, '[^0-9]', '', 'g') = ${e.cuitEmisor}`).limit(1);
      if (p) patch.proveedorId = p.id;
    }
    const propio = (await this.receptor()).cuit;
    if (!l.cuitReceptor && e.cuitReceptor && propio && e.cuitReceptor !== propio) {
      notas.push(`OJO: la factura está a nombre del CUIT ${e.cuitReceptor}, que no es el de la empresa.`);
    }
    if (x.nota) notas.push(`IA: ${x.nota}`);
    if (notas.length) patch.observaciones = [l.observaciones, ...notas].filter(Boolean).join(' ').slice(0, 500);
    if (Object.keys(patch).length) await this.db.update(facturaLecturas).set(patch).where(eq(facturaLecturas.id, l.id));
  }

  /* ============================ la propuesta de carga ============================ */

  /**
   * LO QUE EL ALTA PRECARGA: el encabezado leído, cada renglón con su producto
   * (aprendido de facturas anteriores, por el código del formato de compra o
   * por un nombre claramente igual), los candidatos de los que no se
   * reconocieron y lo que sugirió la IA si se le pidió elegir. No escribe nada.
   */
  async propuesta(id: number) {
    const [l] = await this.db.select().from(facturaLecturas).where(eq(facturaLecturas.id, id)).limit(1);
    if (!l) throw new NotFoundException('Esa factura no existe en la bandeja.');
    const ia: any = l.ia;
    if (l.iaEstado !== 'lista' || !ia?.renglones) {
      return { estado: l.iaEstado, error: ia?.error ?? null, renglones: [], avisos: [] };
    }

    const [catalogo, aprendidos] = l.proveedorId
      ? await Promise.all([
        this.db.select({
          id: productos.id, nombre: productos.nombre, iva: productos.iva,
          porBulto: productoProveedores.cantidad, codigoProveedor: productoProveedores.codigoProveedor,
        }).from(productoProveedores)
          .innerJoin(productos, eq(productos.id, productoProveedores.productoId))
          .where(eq(productoProveedores.proveedorId, l.proveedorId)),
        this.db.select({ codigo: proveedorArticulos.codigo, productoId: proveedorArticulos.productoId, nombre: productos.nombre, iva: productos.iva })
          .from(proveedorArticulos).innerJoin(productos, eq(productos.id, proveedorArticulos.productoId))
          .where(eq(proveedorArticulos.proveedorId, l.proveedorId)),
      ])
      : [[], []];
    const porAprendido = new Map(aprendidos.map((a) => [a.codigo, a]));
    const porCodigo = new Map<string, (typeof catalogo)[number]>();
    for (const p of catalogo) { const c = String(p.codigoProveedor || '').trim(); if (c && !porCodigo.has(c)) porCodigo.set(c, p); }
    const deProveedor = catalogo.map((p) => ({ ...p, tokens: tokensDe(p.nombre) }));
    let todos: { id: number; nombre: string; iva: number; tokens: string[] }[] | null = null;
    const catalogoEntero = async () => {
      todos ??= (await this.db.select({ id: productos.id, nombre: productos.nombre, iva: productos.iva }).from(productos)
        .where(eq(productos.estado, 'activo'))).map((p) => ({ ...p, tokens: tokensDe(p.nombre) }));
      return todos;
    };

    const ivas: number[] = [...new Set((ia.pie?.ivas ?? []).map((x: any) => Number(x.alicuota)).filter((a: number) => a > 0))] as number[];
    const ivaUnico = ivas.length === 1 ? ivas[0] : null;
    const sugeridos: Record<string, number> = ia.sugeridos ?? {};
    const renglones: any[] = [];
    for (const [i, r] of (ia.renglones as any[]).entries()) {
      const codigo = codigoDeRenglon(r);
      const ap = porAprendido.get(codigo);
      const cat = r.codigo ? porCodigo.get(r.codigo) : undefined;
      let prod: { id: number; nombre: string; porBulto: number | null; confianza: number; fuente: string } | null = null;
      if (ap) prod = { id: ap.productoId, nombre: ap.nombre, porBulto: catalogo.find((c) => c.id === ap.productoId)?.porBulto ?? null, confianza: 1, fuente: 'aprendido' };
      else if (cat) prod = { id: cat.id, nombre: cat.nombre, porBulto: cat.porBulto, confianza: 1, fuente: 'catalogo' };
      let cands: { id: number; nombre: string; score: number }[] = [];
      if (!prod) {
        const delProveedor = candidatos(r.descripcion, deProveedor, 5);
        let lista: { p: { id: number; nombre: string }; score: number }[] = delProveedor;
        const claro = elegido(delProveedor);
        if (claro) prod = { id: claro.id, nombre: claro.nombre, porBulto: claro.porBulto, confianza: claro.confianza, fuente: 'parecido' };
        else {
          /* Del proveedor no salió nada firme: se buscan también en todo el catálogo. */
          if (!lista.length || lista[0].score < 0.5) lista = [...lista, ...candidatos(r.descripcion, await catalogoEntero(), 5)];
          const vistos = new Set<number>();
          cands = lista.filter((x) => (vistos.has(x.p.id) ? false : (vistos.add(x.p.id), true))).slice(0, 6)
            .map((x) => ({ id: x.p.id, nombre: x.p.nombre, score: Math.round(x.score * 100) / 100 }));
        }
      }
      const sugerido = !prod && sugeridos[String(i)] ? cands.find((c) => c.id === sugeridos[String(i)]) ?? null : null;
      const factor = factorDescuentos(r.descuentos ?? []);
      const costoBulto = r.cantidad > 0 && factor > 0
        ? (r.importe ? r2(r.importe / (r.cantidad * factor)) : r.precioUnitario || null)
        : null;
      renglones.push({
        i, codigo: r.codigo, codigoProveedor: codigo, descripcion: r.descripcion, unidad: r.unidad,
        cantidad: r.cantidad, precioUnitario: r.precioUnitario, dto: descuentoEquivalente(r.descuentos ?? []),
        importe: r.importe, iva: r.alicuotaIva || ivaUnico, costoBulto,
        productoId: prod?.id ?? null, productoNombre: prod?.nombre ?? null, porBulto: prod?.porBulto ?? null,
        confianza: prod?.confianza ?? null, fuente: prod?.fuente ?? null,
        candidatos: cands, sugerido,
        cierra: !(ia.control?.renglonesMal ?? []).includes(i),
      });
    }

    const avisos: string[] = [...(ia.control?.problemas ?? [])];
    const sinProducto = renglones.filter((x) => !x.productoId).length;
    if (sinProducto) avisos.push(`${sinProducto} ${sinProducto === 1 ? 'renglón' : 'renglones'} sin producto reconocido: elegilo a mano entre los parecidos, o pedile a la IA que elija.`);
    let proveedorSugerido: { cuit: string; nombre: string; direccion: string; condicionIva: string } | null = null;
    if (!l.proveedorId && ia.encabezado?.cuitEmisor) {
      proveedorSugerido = {
        cuit: ia.encabezado.cuitEmisor, nombre: ia.encabezado.razonSocialEmisor,
        direccion: ia.encabezado.domicilioEmisor, condicionIva: ia.encabezado.condicionIvaEmisor || 'responsable_inscripto',
      };
    }
    return {
      estado: l.iaEstado,
      cierra: !!ia.control?.cierra,
      modelo: ia.modelo, costoUsd: ia.costoUsd, intentos: ia.intentos,
      encabezado: {
        tipo: ia.encabezado?.tipo || null, letra: ia.encabezado?.letra || null, puntoVenta: ia.encabezado?.puntoVenta || null,
        numero: ia.encabezado?.numero ?? null, fecha: ia.encabezado?.fecha || null, cae: ia.encabezado?.cae || null,
      },
      renglones,
      pie: {
        subtotal: ia.pie?.subtotal ?? 0, bonifPct: ia.pie?.bonificacionPct ?? 0, bonifImporte: ia.pie?.bonificacionImporte ?? 0,
        ivas: ia.pie?.ivas ?? [], percepciones: ia.pie?.percepciones ?? [],
        impuestosInternos: ia.pie?.impuestosInternos ?? 0, total: ia.pie?.total ?? 0,
      },
      proveedorSugerido,
      avisos,
    };
  }

  /**
   * «QUE LA IA ELIJA»: para los renglones sin producto, la IA elige entre SUS
   * candidatos (nunca fuera de ellos). Queda como SUGERENCIA a confirmar; se
   * aprende recién cuando la persona guarda el comprobante.
   */
  async elegir(id: number, usuarioId: number | null) {
    if (!IA.configurado) throw new BadRequestException('La lectura con IA no está configurada.');
    const prop: any = await this.propuesta(id);
    const pendientes = (prop.renglones as any[]).filter((r) => !r.productoId && r.candidatos.length);
    if (!pendientes.length) throw new BadRequestException('No hay renglones sin producto con candidatos para elegir.');
    const cfg = await this.config();
    if ((await this.gastadoMes()).usd >= cfg.topeMensualUsd) throw new BadRequestException(`Se llegó al tope de gasto del mes (USD ${cfg.topeMensualUsd}).`);
    const datos = pendientes.map((r) => ({
      renglon: r.i, codigo: r.codigo, descripcion: r.descripcion, unidad: r.unidad,
      candidatos: r.candidatos.map((c: any) => ({ productoId: c.id, nombre: c.nombre })),
    }));
    let res;
    try {
      res = await llamarIa({
        modelo: IA.modeloRapido, sistema: SISTEMA_ELEGIR, esquema: ESQUEMA_ELEGIR, maxTokens: 2_000,
        contenido: [{ type: 'text', text: JSON.stringify(datos) }],
      });
    } catch (e) {
      const err = e as ErrorIa & { uso?: Uso };
      await this.registrar({ lecturaId: id, tarea: 'elegir', modelo: IA.modeloRapido, uso: err.uso, ok: false, error: err.message, usuarioId });
      throw new BadRequestException(err.message);
    }
    await this.registrar({ lecturaId: id, tarea: 'elegir', modelo: IA.modeloRapido, uso: res.uso, ok: true, usuarioId });
    /* Solo vale una elección que esté entre los candidatos de ESE renglón. */
    const sugeridos: Record<string, number> = {};
    for (const x of res.json?.elecciones ?? []) {
      const r = pendientes.find((p) => p.i === Number(x?.renglon));
      if (r && r.candidatos.some((c: any) => c.id === Number(x?.productoId))) sugeridos[String(r.i)] = Number(x.productoId);
    }
    await this.db.update(facturaLecturas)
      .set({ ia: sql`jsonb_set(${facturaLecturas.ia}, '{sugeridos}', ${JSON.stringify(sugeridos)}::jsonb)` })
      .where(eq(facturaLecturas.id, id));
    return this.propuesta(id);
  }
}
