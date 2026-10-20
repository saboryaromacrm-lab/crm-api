/**
 * LAS REGLAS DE VENCIMIENTO, CONTRA LA BASE (0188, 20/10/2026, pedido del dueño).
 *
 *   · `reglas` / `guardar`: la regla de cada rango.
 *   · `aplicar`: el ESCALADO. Para cada registro abierto, la oferta que pide la
 *     regla de su rango: la arma si no tiene, la actualiza si es automática y
 *     cambió (pasó a un rango más corto, cambió un precio o un costo), la saca
 *     si el rango ya no lleva oferta. Lo MANUAL no se toca. Corre cada hora,
 *     al registrar o editar un vencimiento y al guardar las reglas; es
 *     idempotente (correrlo de más no cambia nada).
 *   · `panel`: la rentabilidad de cada registro con su regla —por lista— y lo
 *     que REALMENTE se vendió con su oferta (los renglones de venta que la
 *     llevan), con la misma cuenta que Métricas: neto − costo congelado.
 *
 * La cuenta de la plata es `reglas.ts` (con tests); acá solo se juntan los
 * datos con los MISMOS helpers con que cotiza la caja.
 */
import { BadRequestException, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import {
  ofertas, presentaciones, productoListas, productoProveedores, productos, vencimientoReglas, vencimientos,
} from '../db/schema';
import { ConfiguracionService } from '../configuracion/configuracion.module';
import { ListasService } from '../listas/listas.module';
import { OfertasService } from '../ofertas/ofertas.module';
import { costoNetoEntry, costoPrecioEntry, escalaPaquete, formatoDeCosto, precioVentaFila } from '../inventario/pricing';
import { DIAS } from './dias';
import {
  RANGOS_REGLA, REGLAS_DE_FABRICA, describirRegla, errorDeRegla, proponer, rangoDe, rentabilidadDeOferta,
  type Articulo, type Mecanica, type Propuesta, type Regla,
} from './reglas';

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const clave = (productoId: number, presentacionId: number | null) => `${productoId}-${presentacionId ?? 0}`;
/** El CSV de listas ordenado, como lo guarda el motor de ofertas: para comparar. */
const csv = (ids: number[]) => [...ids].sort((a, b) => a - b).join(',');
/** Lo vendido de UN registro: su oferta, su artículo y su sucursal. */
const claveVendido = (ofertaId: number, productoId: number, presentacionId: number | null, sucursalId: number) =>
  `${ofertaId}|${clave(productoId, presentacionId)}|${sucursalId}`;
/** Mismos criterios que Métricas: cuentan confirmadas y pendientes de CAE; las notas de crédito restan. */
const SIGNO = sql`(CASE WHEN v.tipo::text LIKE 'nota_credito%' THEN -1 ELSE 1 END)`;

@Injectable()
export class ReglasVencimientoService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('ReglasVencimiento');
  private reloj: ReturnType<typeof setInterval> | null = null;
  private arranque: ReturnType<typeof setTimeout> | null = null;
  /** Una pasada a la vez en este proceso: el reloj, el botón y un registro nuevo no se pisan. */
  private cola: Promise<unknown> = Promise.resolve();

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly ofertas: OfertasService,
    private readonly cfg: ConfiguracionService,
    private readonly listas: ListasService,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test' || process.env.VENC_RELOJ === '0') return;
    const tic = () => { void this.aplicar().catch((e) => this.log.warn(`escalado: ${(e as Error).message}`)); };
    /* Cada hora: el cambio de rango ocurre a la medianoche argentina y así entra en la primera hora del día. */
    this.arranque = setTimeout(tic, 60_000);
    this.arranque.unref();
    this.reloj = setInterval(tic, 60 * 60_000);
    this.reloj.unref();
  }

  onModuleDestroy() {
    if (this.reloj) clearInterval(this.reloj);
    if (this.arranque) clearTimeout(this.arranque);
  }

  /* ============================== LAS REGLAS ============================== */

  async reglas(): Promise<Regla[]> {
    const filas = await this.db.select().from(vencimientoReglas);
    const por = new Map(filas.map((f) => [f.rango, f]));
    return RANGOS_REGLA.map((rango) => {
      const f = por.get(rango) ?? REGLAS_DE_FABRICA.find((x) => x.rango === rango)!;
      return { rango, mecanica: f.mecanica as Mecanica, valor: Number(f.valor), lleva: Number(f.lleva), paga: Number(f.paga) };
    });
  }

  /** Guarda las reglas (todas válidas o ninguna) y las aplica en el acto. */
  async guardar(entrada: Regla[], usuarioId: number | null) {
    const reglas = entrada.map((r) => ({
      rango: r.rango,
      mecanica: r.mecanica,
      /* Cada mecánica guarda solo lo suyo: un 25 que quedó de antes en un 3×2 no significa nada. */
      valor: r.mecanica === 'descuento' || r.mecanica === 'costo' ? Number(r.valor) : 0,
      lleva: r.mecanica === 'nxm' ? Number(r.lleva) : 0,
      paga: r.mecanica === 'nxm' ? Number(r.paga) : 0,
    })) as Regla[];
    for (const r of reglas) {
      const e = errorDeRegla(r);
      if (e) throw new BadRequestException(e);
    }
    if (new Set(reglas.map((r) => r.rango)).size !== reglas.length) throw new BadRequestException('Hay un rango repetido.');
    await this.db.transaction(async (tx) => {
      for (const r of reglas) {
        const fila = { ...r, usuarioId, actualizadoEn: new Date() };
        await tx.insert(vencimientoReglas).values(fila).onConflictDoUpdate({ target: vencimientoReglas.rango, set: fila });
      }
    });
    return this.aplicar();
  }

  /* ========================= COTIZAR LO QUE VENCE ========================= */

  /**
   * Cada artículo (producto suelto o paquete) con su costo REAL de hoy y el
   * precio final de cada lista activa donde tiene formato: los mismos helpers y
   * las mismas reglas que la caja (base del precio, paquete escalado con su
   * merma, redondeo del producto o el de la configuración).
   */
  async articulos(items: { productoId: number; presentacionId: number | null }[]): Promise<Map<string, Articulo>> {
    const out = new Map<string, Articulo>();
    if (!items.length) return out;
    const ids = [...new Set(items.map((x) => x.productoId))];
    const presIds = [...new Set(items.map((x) => x.presentacionId).filter((x): x is number => x != null))];
    const [prods, provs, press, formatos, cat, cfg] = await Promise.all([
      this.db.select().from(productos).where(inArray(productos.id, ids)),
      this.db.select().from(productoProveedores).where(inArray(productoProveedores.productoId, ids)),
      presIds.length ? this.db.select().from(presentaciones).where(inArray(presentaciones.id, presIds)) : Promise.resolve([]),
      this.db.select().from(productoListas).where(inArray(productoListas.productoId, ids)),
      this.listas.catalogo(),
      this.cfg.get('ventas'),
    ]);
    const activas = new Map(cat.listas.filter((l: any) => l.activa).map((l: any) => [l.id, l]));
    const prodDe = new Map(prods.map((p) => [p.id, p]));
    const presDe = new Map((press as any[]).map((p) => [p.id, p]));
    for (const it of items) {
      const k = clave(it.productoId, it.presentacionId);
      const p = prodDe.get(it.productoId);
      if (out.has(k) || !p) continue;
      const formato = formatoDeCosto(p, provs.filter((x) => x.productoId === p.id) as any[]) as any;
      const pres = it.presentacionId != null ? presDe.get(it.presentacionId) : null;
      const escala = pres ? escalaPaquete(pres.tamKg, p.merma) : 1;
      const base = costoPrecioEntry(formato, p.iva) * escala;
      const opts = { iva: p.iva, redondeo: p.redondeo ?? (Number(cfg.redondeoPrecio) || 0) };
      /* Una fila por lista: si hay varias (la unidad y la caja), la de menos unidades es el precio por unidad. */
      const porLista = new Map<number, any>();
      for (const f of formatos) {
        if (f.productoId !== p.id || (f.presentacionId ?? null) !== (it.presentacionId ?? null) || !activas.has(f.listaId)) continue;
        const ya = porLista.get(f.listaId);
        if (!ya || (Number(f.unidades) || 1) < (Number(ya.unidades) || 1)) porLista.set(f.listaId, f);
      }
      out.set(k, {
        iva: Number(p.iva) || 0,
        redondeo: opts.redondeo,
        costoReal: costoNetoEntry(formato, p.iva) * escala,
        listaBaseId: Number(cfg.listaBaseId) || null,
        listas: [...porLista.values()]
          .sort((a, b) => activas.get(a.listaId).orden - activas.get(b.listaId).orden)
          .map((f) => ({ listaId: f.listaId, nombre: activas.get(f.listaId).etiqueta, precio: precioVentaFila(base, f, opts).finalUnitario })),
      });
    }
    return out;
  }

  /** Los registros abiertos (o esos `ids`) con su oferta atada, si tiene. */
  private async abiertos(o: { ids?: number[]; soloSuc?: number | null } = {}) {
    if (o.ids && !o.ids.length) return [];
    return this.db.select({
      v: vencimientos,
      dias: DIAS,
      oferta: {
        id: ofertas.id, nombre: ofertas.nombre, tipo: ofertas.tipo, precio: ofertas.precio, lleva: ofertas.lleva,
        paga: ofertas.paga, porcentaje: ofertas.porcentaje, listas: ofertas.listas, sucursales: ofertas.sucursales,
        hasta: ofertas.hasta, activa: ofertas.activa, porVencer: ofertas.porVencer, auto: ofertas.autoVencimiento,
      },
    }).from(vencimientos)
      .leftJoin(ofertas, eq(ofertas.id, vencimientos.ofertaId))
      .where(and(
        eq(vencimientos.procesado, false),
        o.ids ? inArray(vencimientos.id, o.ids) : undefined,
        o.soloSuc ? eq(vencimientos.sucursalId, o.soloSuc) : undefined,
      ))
      .orderBy(asc(vencimientos.fechaVencimiento), asc(vencimientos.id));
  }

  /**
   * La regla y su propuesta para UN registro: la del botón «Oferta» del panel.
   * En un rango sin oferta (+30) propone la del primer rango que la tenga: el
   * que arma una oferta antes de tiempo quiere ofertar igual.
   */
  async propuestaPara(v: { productoId: number; presentacionId: number | null }, dias: number) {
    const reglas = await this.reglas();
    const rango = rangoDe(dias);
    const regla = reglas.find((r) => r.rango === rango && r.mecanica !== 'ninguna')
      ?? reglas.find((r) => r.mecanica !== 'ninguna');
    const art = (await this.articulos([v])).get(clave(v.productoId, v.presentacionId));
    return { regla: regla ?? null, propuesta: regla && art ? proponer(regla, art) : null };
  }

  /** La oferta que pide la propuesta, en el formato del motor de ofertas. */
  dtoOferta(v: any, p: Extract<Propuesta, { hay: true }>) {
    return {
      nombre: `Por vencer · ${v.nombre}`,
      tipo: p.tipo,
      porcentaje: 0,
      precio: p.precio,
      lleva: p.lleva,
      paga: p.paga,
      /* Hasta el día del paquete INCLUSIVE, en hora argentina: la promo nunca sobrevive a la mercadería. */
      hasta: `${v.fechaVencimiento}T23:59:59-03:00`,
      sucursales: String(v.sucursalId),
      listas: csv(p.listas),
      porVencer: true,
      activa: true,
      alcances: [v.presentacionId ? { tipo: 'presentacion', refId: v.presentacionId } : { tipo: 'producto', refId: v.productoId }],
    };
  }

  /** ¿La oferta que está ya es la que pide la regla? */
  private igual(o: any, d: ReturnType<ReglasVencimientoService['dtoOferta']>) {
    return o.tipo === d.tipo && r2(o.precio) === r2(d.precio) && Number(o.lleva) === d.lleva && Number(o.paga) === d.paga
      && o.listas === d.listas && o.sucursales === d.sucursales && o.activa && o.porVencer && o.nombre === d.nombre
      && o.hasta && new Date(o.hasta).getTime() === new Date(d.hasta).getTime();
  }

  /* ============================== EL ESCALADO ============================== */

  /** Aplica las reglas a lo abierto (o a esos registros). Una pasada a la vez. */
  aplicar(ids?: number[]) {
    const corrida = this.cola.then(() => this.aplicarYa(ids));
    this.cola = corrida.catch(() => undefined);
    return corrida;
  }

  private async aplicarYa(ids?: number[]) {
    const [reglas, filas] = await Promise.all([this.reglas(), this.abiertos({ ids })]);
    const porRango = new Map(reglas.map((r) => [r.rango, r]));
    const arts = await this.articulos(filas.map((f) => ({ productoId: f.v.productoId, presentacionId: f.v.presentacionId })));
    const res = { creadas: 0, actualizadas: 0, quitadas: 0, iguales: 0, manuales: 0, sinOferta: 0 };
    for (const { v, dias, oferta: o } of filas) {
      const rango = rangoDe(Number(dias));
      /* Lo vencido no se toca: su oferta termina sola con el `hasta` y el registro se procesa. */
      if (rango === 'vencido') continue;
      if (o?.id && !o.auto) { res.manuales += 1; continue; }
      const art = arts.get(clave(v.productoId, v.presentacionId));
      const p = art ? proponer(porRango.get(rango)!, art) : null;
      if (!p?.hay) {
        if (o?.id) { await this.ofertas.borrar(o.id); res.quitadas += 1; } else res.sinOferta += 1;
        continue;
      }
      const dto = this.dtoOferta(v, p);
      if (!o?.id) {
        const nueva = await this.ofertas.crear(dto as any, null, true);
        /* Atarla solo si el registro sigue sin oferta: dos pasadas a la vez (un deploy) no dejan dos. */
        const [atada] = await this.db.update(vencimientos).set({ ofertaId: nueva.id })
          .where(and(eq(vencimientos.id, v.id), isNull(vencimientos.ofertaId))).returning({ id: vencimientos.id });
        if (atada) res.creadas += 1; else await this.ofertas.borrar(nueva.id);
        continue;
      }
      if (this.igual(o, dto)) { res.iguales += 1; continue; }
      await this.ofertas.editar(o.id, dto as any, true);
      res.actualizadas += 1;
    }
    return res;
  }

  /** «Volver a la regla»: la oferta manual del registro la retoma el sistema (y la ajusta ya). */
  async volverARegla(id: number) {
    const [reg] = await this.db.select({ ofertaId: vencimientos.ofertaId, procesado: vencimientos.procesado })
      .from(vencimientos).where(eq(vencimientos.id, id)).limit(1);
    if (!reg) throw new NotFoundException('Registro inexistente.');
    if (reg.procesado) throw new BadRequestException('Ya se procesó.');
    if (reg.ofertaId) await this.db.update(ofertas).set({ autoVencimiento: true }).where(eq(ofertas.id, reg.ofertaId));
    return this.aplicar([id]);
  }

  /** Al borrar o procesar un registro, su oferta automática se va con él (la manual queda: es de una persona). */
  async soltarOferta(ofertaId: number | null) {
    if (!ofertaId) return;
    const [o] = await this.db.select({ auto: ofertas.autoVencimiento }).from(ofertas).where(eq(ofertas.id, ofertaId)).limit(1);
    if (o?.auto) await this.ofertas.borrar(ofertaId);
  }

  /* ========================= RENTABILIDAD Y MEDICIÓN ========================= */

  /**
   * Lo que REALMENTE se vendió con cada oferta: unidades, neto, costo y lo que
   * se descontó, de los renglones que la llevan. La ganancia se mide solo
   * sobre renglones con costo (`costeado`), como Métricas; si alguno no lo
   * tiene, se avisa en vez de inventar.
   *
   * Por registro cuenta SOLO su artículo en su sucursal: una oferta manual
   * puede abarcar una marca entera o todas las sucursales, y eso no es lo que
   * se vendió de este lote.
   */
  private async vendido(ofertaIds: number[]) {
    const m = new Map<string, { unidades: number; neto: number; costeado: number; costo: number; descuento: number; sinCosto: number }>();
    if (!ofertaIds.length) return m;
    const r = await this.db.execute(sql`
      SELECT vi.oferta_id AS id, vi.producto_id AS pid, vi.presentacion_id AS pres, v.sucursal_id AS suc,
        coalesce(sum(vi.cantidad * ${SIGNO}), 0) AS unidades,
        coalesce(sum(vi.subtotal * ${SIGNO}), 0) AS neto,
        coalesce(sum(vi.subtotal * ${SIGNO}) FILTER (WHERE vi.costo_unitario IS NOT NULL), 0) AS costeado,
        coalesce(sum(vi.cantidad * vi.costo_unitario * ${SIGNO}), 0) AS costo,
        coalesce(sum(vi.oferta_descuento * ${SIGNO}), 0) AS descuento,
        count(*) FILTER (WHERE vi.costo_unitario IS NULL)::int AS sin_costo
      FROM ventas v JOIN venta_items vi ON vi.venta_id = v.id
      WHERE v.estado IN ('confirmada', 'pendiente_cae') AND vi.oferta_id IN ${ofertaIds}
      GROUP BY vi.oferta_id, vi.producto_id, vi.presentacion_id, v.sucursal_id`);
    for (const x of r.rows as any[]) {
      m.set(claveVendido(Number(x.id), Number(x.pid), x.pres == null ? null : Number(x.pres), Number(x.suc)), {
        unidades: r2(x.unidades), neto: r2(x.neto), costeado: r2(x.costeado), costo: r2(x.costo),
        descuento: r2(x.descuento), sinCosto: Number(x.sin_costo) || 0,
      });
    }
    return m;
  }

  /** La pantalla de reglas: cada registro abierto con su regla, su oferta, su rentabilidad por lista y lo vendido. */
  async panel(soloSuc: number | null = null) {
    const [reglas, filas] = await Promise.all([this.reglas(), this.abiertos({ soloSuc })]);
    const porRango = new Map(reglas.map((r) => [r.rango, r]));
    const [arts, vendido] = await Promise.all([
      this.articulos(filas.map((f) => ({ productoId: f.v.productoId, presentacionId: f.v.presentacionId }))),
      this.vendido(filas.map((f) => f.oferta?.id).filter((x): x is number => !!x)),
    ]);
    return {
      reglas: reglas.map((r) => ({ ...r, texto: describirRegla(r) })),
      filas: filas.map(({ v, dias, oferta: o }) => {
        const d = Number(dias);
        const rango = rangoDe(d);
        const art = arts.get(clave(v.productoId, v.presentacionId));
        const regla = rango === 'vencido' ? null : porRango.get(rango)!;
        const p = regla && art ? proponer(regla, art) : null;
        const venta = o?.id ? vendido.get(claveVendido(o.id, v.productoId, v.presentacionId, v.sucursalId)) ?? null : null;
        return {
          id: v.id,
          nombre: v.nombre,
          sucursalId: v.sucursalId,
          fechaVencimiento: v.fechaVencimiento,
          diasParaVencer: d,
          rango,
          cantidad: v.cantidad,
          unidad: v.unidad,
          /** Lo que se pierde si se vence: costo congelado al registrar × cantidad. */
          enJuego: r2(v.cantidad * v.costoUnitario),
          costoReal: art ? r2(art.costoReal) : null,
          /* La lista de referencia de la pantalla (mostrador): ahí se lee la ganancia por unidad. */
          listaBaseId: art?.listaBaseId ?? null,
          regla: regla ? describirRegla(regla) : null,
          propuesta: p,
          oferta: o?.id ? {
            id: o.id, nombre: o.nombre, tipo: o.tipo, precio: o.precio, lleva: o.lleva, paga: o.paga,
            porcentaje: o.porcentaje, activa: o.activa, auto: o.auto,
            /* Lo que deja la oferta PUESTA: una manual puede estar debajo del costo. */
            porLista: art ? rentabilidadDeOferta(o, art) : null,
          } : null,
          vendido: venta && {
            ...venta,
            ganancia: r2(venta.costeado - venta.costo),
          },
        };
      }),
    };
  }
}
