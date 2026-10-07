/**
 * COFFIT · INGREDIENTES CON COSTO CONVERTIDO (0140, 6/10/2026, pedido del dueño)
 * ============================================================================
 * Coffit costea sus recetas en otra app; para eso necesita el costo de cada
 * ingrediente POR UNIDAD DE MEDIDA (por kg, por 100 g, por litro…), no por
 * envase. Acá se eligen los ingredientes y se configura UNA vez lo que trae
 * cada envase; el costo se calcula siempre al vuelo, así una factura nueva lo
 * actualiza sola.
 *
 * EL COSTO, TAL CUAL SE LO COBRAN A SABOR Y AROMA (decisión del dueño):
 *   · el ÚLTIMO comprobante confirmado con precio real (factura, liquidación
 *     o remito), con su descuento y la bonificación general ya repartida
 *     (`subtotal` del renglón);
 *   · factura y liquidación CON IVA (el del renglón); remito SIN IVA;
 *   · un precio «de mentira» no cuenta: menos de $1 por unidad, o menos del
 *     10 % del costo válido anterior (las hormas «con confirmación de peso»
 *     que vienen a $0,10). Sigue valiendo el anterior hasta que llegue uno real.
 *
 * COFFITCOST (0141, 7/10/2026): los costos VIAJAN a la app de recetas de Coffit
 * por POST, con su formato y su clave (`X-API-Key`). Se mandan con el botón
 * «Enviar ahora» y, solos, cada 15 minutos SI ALGÚN COSTO CAMBIÓ (la firma de
 * lo enviado se compara con la del último envío bueno). La dirección y la clave
 * son variables del servidor (`COFFITCOST_URL`, `COFFITCOST_API_KEY`): sin la
 * clave, no se manda nada. Cada envío queda registrado con su respuesta.
 */
import { createHash } from 'node:crypto';
import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get, Inject, Injectable, Logger, Module, NotFoundException,
  OnModuleDestroy, OnModuleInit, Param, ParseIntPipe, Patch, Post,
} from '@nestjs/common';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { desc, eq, sql } from 'drizzle-orm';
import { Auth, Permiso, type Sesion } from '../auth/auth.decoradores';
import { DRIZZLE, Database } from '../db/drizzle';
import { coffitIngredientes, coffitcostEnvios, productos } from '../db/schema';

const UNIDADES_CONTENIDO = ['g', 'kg', 'ml', 'l'] as const;
const UNIDADES_COSTO = ['kg', 'g', '100g', 'l', 'ml', '100ml', 'u', 'doc'] as const;
/** Cuántos gramos (o ml) hay en cada unidad. */
const BASE: Record<string, number> = { g: 1, kg: 1000, ml: 1, l: 1000, '100g': 100, '100ml': 100 };
const MASA = new Set(['g', 'kg', '100g']);
const VOLUMEN = new Set(['ml', 'l', '100ml']);
/** Un precio por debajo de esto, o del 10 % del anterior válido, es «a confirmar». */
const PRECIO_MINIMO = 1;
const FRACCION_MINIMA = 0.1;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

class IngredienteDto {
  @IsOptional() @IsInt() productoId?: number;
  @IsOptional() @IsNumber() @Min(0.0001) @Max(1_000_000) contenido?: number | null;
  @IsOptional() @IsIn(UNIDADES_CONTENIDO as unknown as string[]) contenidoUnidad?: string;
  @IsOptional() @IsIn(UNIDADES_COSTO as unknown as string[]) unidadCosto?: string;
  @IsOptional() @IsString() @MaxLength(200) nota?: string;
  /** Cómo se llama en CoffitCost (tiene que coincidir); vacío = el nombre del producto. */
  @IsOptional() @IsString() @MaxLength(120) nombreCoffit?: string;
}

/** Comparar nombres como CoffitCost: sin mayúsculas, tildes ni espacios de más. */
const normNombre = (t: string) => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const COFFITCOST_URL_DEFECTO = 'https://apicoffit.saboryaroma.com/api/public/sya/costos';
const coffitcost = {
  get url() { return (process.env.COFFITCOST_URL || COFFITCOST_URL_DEFECTO).trim(); },
  get clave() { return (process.env.COFFITCOST_API_KEY || '').trim(); },
  get configurado() { return !!this.clave; },
};
/** «2026-10-07T10:00:00-03:00»: el instante en hora argentina, con su desfase. */
const fechaAr = (d = new Date()) => `${new Date(d.getTime() - 3 * 3600_000).toISOString().slice(0, 19)}-03:00`;
/** Lo que CoffitCost entiende: g, kg, ml, l, u, doc. «100 g» y «100 ml» viajan por g / ml. */
function paraCoffitcost(costo: number, unidad: string): { costo: number; unidad: string } {
  if (unidad === '100g') return { costo: r4(costo / 100), unidad: 'g' };
  if (unidad === '100ml') return { costo: r4(costo / 100), unidad: 'ml' };
  return { costo: r4(costo), unidad };
}

export type CostoComprobante = {
  costoBase: number;           // $ por unidad base: por unidad (entero) o por kg (granel)
  conIva: boolean;
  comprobante: { id: number; tipo: string; letra: string; numero: string; fecha: string; proveedor: string };
  aConfirmar: { tipo: string; letra: string; numero: string; fecha: string; precio: number }[];
};

/**
 * El costo de cada producto según la regla de arriba. Mira los últimos 12
 * renglones con precio de cada uno (una consulta con ventana) y elige, del más
 * viejo al más nuevo, el último que no sea «de mentira».
 */
export async function costosIngredientes(db: any, ids: number[]): Promise<Map<number, CostoComprobante>> {
  const out = new Map<number, CostoComprobante>();
  if (!ids.length) return out;
  const r = await db.execute(sql`
    select * from (
      select ci.producto_id as "productoId", ci.subtotal, ci.cantidad, ci.iva, coalesce(pr.tam_kg, 1) as tam,
        c.id as "comprobanteId", c.tipo::text as tipo, c.letra::text as letra,
        c.punto_venta || '-' || lpad(coalesce(c.numero, 0)::text, 8, '0') as numero, c.fecha,
        coalesce(pv.nombre, '') as proveedor,
        row_number() over (partition by ci.producto_id order by c.fecha desc, c.id desc, ci.id desc) as rn
      from comprobante_items ci
        join comprobantes c on c.id = ci.comprobante_id
        left join presentaciones pr on pr.id = ci.presentacion_id
        left join proveedores pv on pv.id = c.proveedor_id
      where ci.producto_id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
        and c.estado = 'confirmado' and c.tipo in ('factura', 'liquidacion', 'remito') and ci.cantidad > 0
    ) x where rn <= 12
    order by "productoId", rn desc`);
  const porProducto = new Map<number, any[]>();
  for (const f of r.rows as any[]) {
    const id = Number(f.productoId);
    if (!porProducto.has(id)) porProducto.set(id, []);
    porProducto.get(id)!.push(f); // del más viejo al más nuevo
  }
  for (const [id, filas] of porProducto) {
    let elegido: CostoComprobante | null = null;
    let previo: number | null = null;
    let aConfirmar: CostoComprobante['aConfirmar'] = [];
    for (const f of filas) {
      const remito = f.tipo === 'remito';
      const neto = Number(f.subtotal) / (Number(f.cantidad) * (Number(f.tam) || 1));
      const precio = remito ? neto : neto * (1 + (Number(f.iva) || 0) / 100);
      const doc = { tipo: f.tipo, letra: f.letra, numero: f.numero, fecha: new Date(f.fecha).toISOString() };
      /* Un remito SIN precio (subtotal 0) no es «a confirmar»: es un remito sin valorizar. */
      if (!(Number(f.subtotal) > 0)) continue;
      const deMentira = !(precio >= PRECIO_MINIMO) || (previo != null && precio < previo * FRACCION_MINIMA);
      if (deMentira) { aConfirmar.push({ ...doc, precio: r4(precio) }); continue; }
      previo = precio;
      aConfirmar = []; // los «a confirmar» que importan son los MÁS NUEVOS que el elegido
      elegido = {
        costoBase: r4(precio), conIva: !remito,
        comprobante: { id: Number(f.comprobanteId), ...doc, proveedor: f.proveedor },
        aConfirmar,
      };
    }
    if (elegido) { elegido.aConfirmar = aConfirmar; out.set(id, elegido); }
  }
  return out;
}

/**
 * El costo convertido: el de la unidad base pasado a la unidad pedida.
 * Entero → contenido del envase (200 g); granel → la base ya es el kg.
 */
export function convertir(costoBase: number, tipo: string, ing: { contenido: number | null; contenidoUnidad: string; unidadCosto: string }) {
  if (ing.unidadCosto === 'u') return tipo === 'granel' ? null : costoBase;
  if (ing.unidadCosto === 'doc') return tipo === 'granel' ? null : r4(costoBase * 12);
  const gramosPorBase = tipo === 'granel' ? 1000 : (Number(ing.contenido) || 0) * (BASE[ing.contenidoUnidad] ?? 0);
  if (!(gramosPorBase > 0)) return null;
  return r4((costoBase / gramosPorBase) * BASE[ing.unidadCosto]);
}

@Injectable()
export class IngredientesService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('CoffitCost');
  private reloj: ReturnType<typeof setInterval> | null = null;
  private arranque: ReturnType<typeof setTimeout> | null = null;
  /** Un envío a la vez: el botón y el reloj no se pisan. */
  private enviando = false;

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test' || process.env.COFFITCOST_RELOJ === '0') return;
    const tic = () => { void this.enviar('automatico', null).catch((e) => this.log.warn(`envío automático: ${(e as Error).message}`)); };
    /* Cada 15 minutos (COFFITCOST_RELOJ_MIN lo cambia; sirve para probar). */
    const minutos = Math.max(1, Number(process.env.COFFITCOST_RELOJ_MIN) || 15);
    this.arranque = setTimeout(tic, Math.min(2, minutos) * 60_000);
    this.arranque.unref();
    this.reloj = setInterval(tic, minutos * 60_000);
    this.reloj.unref();
  }

  onModuleDestroy() {
    if (this.reloj) clearInterval(this.reloj);
    if (this.arranque) clearTimeout(this.arranque);
  }

  /** El nombre en CoffitCost no se repite entre ingredientes (dos costos para el mismo nombre se pisarían). */
  private async exigirNombreLibre(nombre: string, excluirId?: number) {
    const n = normNombre(nombre);
    if (!n) return;
    const r = await this.db.execute(sql`
      select i.id, coalesce(nullif(i.nombre_coffit, ''), p.nombre) as nombre
      from coffit_ingredientes i join productos p on p.id = i.producto_id`);
    const choca = (r.rows as any[]).find((x) => Number(x.id) !== excluirId && normNombre(x.nombre) === n);
    if (choca) throw new ConflictException(`Ya hay un ingrediente que va a CoffitCost como «${choca.nombre}»: el nombre tiene que ser único.`);
  }

  /** Que la configuración tenga sentido: masa con masa, líquido con líquido, «por unidad» solo en enteros. */
  private validar(tipo: string, v: { contenido: number | null; contenidoUnidad: string; unidadCosto: string }) {
    if (tipo === 'granel') {
      if (!MASA.has(v.unidadCosto)) throw new BadRequestException('Un producto a granel se costea por kg, 100 g o g.');
      return;
    }
    if (v.unidadCosto === 'u' || v.unidadCosto === 'doc') return;
    if (!(Number(v.contenido) > 0)) throw new BadRequestException('Poné cuánto trae el envase (por ejemplo 200 g o 1 L).');
    const esMasa = MASA.has(v.unidadCosto);
    const contenidoMasa = v.contenidoUnidad === 'g' || v.contenidoUnidad === 'kg';
    if (esMasa !== contenidoMasa) {
      throw new BadRequestException(esMasa
        ? 'El contenido está en litros o ml: el costo va por litro, 100 ml o ml.'
        : 'El contenido está en gramos o kg: el costo va por kg, 100 g o g.');
    }
    if (!esMasa && !VOLUMEN.has(v.unidadCosto)) throw new BadRequestException('Unidad de costo inválida.');
  }

  async listar() {
    const r = await this.db.execute(sql`
      select i.id, i.producto_id as "productoId", i.contenido, i.contenido_unidad as "contenidoUnidad",
        i.unidad_costo as "unidadCosto", i.nota, i.nombre_coffit as "nombreCoffit", i.actualizado_en as "actualizadoEn",
        p.nombre, p.tipo::text as tipo, p.codigo_propio as codigo, coalesce(m.nombre, '') as marca, p.estado::text as estado
      from coffit_ingredientes i join productos p on p.id = i.producto_id
      left join marcas m on m.id = p.marca_id
      order by p.nombre`);
    const filas = r.rows as any[];
    const costos = await costosIngredientes(this.db, filas.map((f) => Number(f.productoId)));
    return filas.map((f) => {
      const c = costos.get(Number(f.productoId)) ?? null;
      const ing = { contenido: f.contenido == null ? null : Number(f.contenido), contenidoUnidad: f.contenidoUnidad, unidadCosto: f.unidadCosto };
      return {
        ...f, ...ing,
        actualizadoEn: f.actualizadoEn ? new Date(f.actualizadoEn).toISOString() : null,
        costoBase: c?.costoBase ?? null,
        costoConvertido: c ? convertir(c.costoBase, f.tipo, ing) : null,
        conIva: c?.conIva ?? null,
        comprobante: c?.comprobante ?? null,
        aConfirmar: c?.aConfirmar ?? [],
      };
    });
  }

  async crear(dto: IngredienteDto, usuarioId: number | null) {
    if (!dto.productoId) throw new BadRequestException('Elegí el producto.');
    const [p] = await this.db.select({ id: productos.id, tipo: productos.tipo, nombre: productos.nombre }).from(productos).where(eq(productos.id, dto.productoId)).limit(1);
    if (!p) throw new NotFoundException('Ese producto no existe.');
    const v = {
      contenido: p.tipo === 'granel' ? null : (dto.contenido ?? null),
      contenidoUnidad: dto.contenidoUnidad ?? 'g',
      unidadCosto: dto.unidadCosto ?? (p.tipo === 'granel' ? 'kg' : 'kg'),
    };
    this.validar(p.tipo, v);
    const nombreCoffit = String(dto.nombreCoffit ?? '').trim();
    await this.exigirNombreLibre(nombreCoffit || p.nombre);
    try {
      const [fila] = await this.db.insert(coffitIngredientes).values({
        productoId: p.id, ...v, nota: String(dto.nota ?? '').trim(), nombreCoffit, usuarioId,
      }).returning();
      return fila;
    } catch (e: any) {
      if (e?.code === '23505' || e?.cause?.code === '23505') throw new ConflictException(`«${p.nombre}» ya es un ingrediente.`);
      throw e;
    }
  }

  async editar(id: number, dto: IngredienteDto, usuarioId: number | null) {
    const [actual] = await this.db.select().from(coffitIngredientes).where(eq(coffitIngredientes.id, id)).limit(1);
    if (!actual) throw new NotFoundException('Ese ingrediente no existe.');
    const [p] = await this.db.select({ tipo: productos.tipo }).from(productos).where(eq(productos.id, actual.productoId)).limit(1);
    const v = {
      contenido: p?.tipo === 'granel' ? null : (dto.contenido !== undefined ? dto.contenido : actual.contenido),
      contenidoUnidad: dto.contenidoUnidad ?? actual.contenidoUnidad,
      unidadCosto: dto.unidadCosto ?? actual.unidadCosto,
    };
    this.validar(p?.tipo ?? 'entero', v);
    const nombreCoffit = dto.nombreCoffit !== undefined ? String(dto.nombreCoffit).trim() : actual.nombreCoffit;
    const [prod] = await this.db.select({ nombre: productos.nombre }).from(productos).where(eq(productos.id, actual.productoId)).limit(1);
    await this.exigirNombreLibre(nombreCoffit || prod?.nombre || '', id);
    const [fila] = await this.db.update(coffitIngredientes).set({
      ...v, nota: dto.nota !== undefined ? String(dto.nota).trim() : actual.nota, nombreCoffit, actualizadoEn: new Date(), usuarioId,
    }).where(eq(coffitIngredientes.id, id)).returning();
    return fila;
  }

  /* ------------------------------ CoffitCost ------------------------------ */

  /** Lo que se le manda: solo los ingredientes con costo, con el nombre de CoffitCost. */
  async paraEnviar() {
    const filas = await this.listar();
    const costos = filas
      .filter((f) => f.costoConvertido != null && f.costoConvertido > 0)
      .map((f) => ({ nombre: (f.nombreCoffit || f.nombre).trim(), ...paraCoffitcost(f.costoConvertido!, f.unidadCosto) }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    const firma = createHash('sha256').update(JSON.stringify(costos)).digest('hex');
    return { costos, firma, sinCosto: filas.filter((f) => f.costoConvertido == null).length };
  }

  /**
   * Manda los costos. `automatico`: solo si cambió algo desde el último envío
   * bueno y solo si la clave está cargada (si no, en silencio). `manual`: manda
   * siempre, y si falta la clave lo dice.
   */
  async enviar(origen: 'manual' | 'automatico', usuarioId: number | null) {
    if (!coffitcost.configurado) {
      if (origen === 'automatico') return { enviado: false, motivo: 'sin clave' };
      throw new BadRequestException('Falta la clave de CoffitCost en el servidor (variable COFFITCOST_API_KEY en Dokploy).');
    }
    if (this.enviando) {
      if (origen === 'automatico') return { enviado: false, motivo: 'otro envío en curso' };
      throw new ConflictException('Ya se están mandando los costos: esperá unos segundos.');
    }
    this.enviando = true;
    try {
      const { costos, firma } = await this.paraEnviar();
      if (!costos.length) {
        if (origen === 'automatico') return { enviado: false, motivo: 'sin costos' };
        throw new BadRequestException('No hay ingredientes con costo para mandar.');
      }
      if (origen === 'automatico') {
        const [ultimo] = await this.db.select({ firma: coffitcostEnvios.firma }).from(coffitcostEnvios)
          .where(eq(coffitcostEnvios.ok, true)).orderBy(desc(coffitcostEnvios.id)).limit(1);
        if (ultimo?.firma === firma) return { enviado: false, motivo: 'sin cambios' };
      }
      const [reg] = await this.db.insert(coffitcostEnvios).values({ origen, cantidad: costos.length, firma, usuarioId }).returning();
      const referencia = `SYA-${String(reg.id).padStart(4, '0')}`;
      const cuerpo = { fecha: fechaAr(), referencia, costos };
      let ok = false; let estadoHttp: number | null = null; let respuesta = '';
      const corte = new AbortController();
      const reloj = setTimeout(() => corte.abort(), 15_000);
      try {
        const r = await fetch(coffitcost.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'X-API-Key': coffitcost.clave },
          body: JSON.stringify(cuerpo),
          signal: corte.signal,
        });
        estadoHttp = r.status;
        respuesta = (await r.text()).slice(0, 2000);
        ok = r.ok;
      } catch (e) {
        respuesta = (e as Error)?.name === 'AbortError' ? 'CoffitCost no contestó en 15 segundos.' : `No se pudo conectar: ${(e as Error).message}`;
      } finally {
        clearTimeout(reloj);
      }
      await this.db.update(coffitcostEnvios).set({ referencia, ok, estadoHttp, respuesta }).where(eq(coffitcostEnvios.id, reg.id));
      if (!ok) this.log.warn(`${referencia} (${origen}) falló: ${estadoHttp ?? '—'} ${respuesta.slice(0, 200)}`);
      return { enviado: true, ok, referencia, cantidad: costos.length, estadoHttp, respuesta };
    } finally {
      this.enviando = false;
    }
  }

  /** Para la pantalla: si está configurado, el último envío y si hay costos nuevos sin mandar. */
  async estadoCoffitcost() {
    const [ultimos, actual] = await Promise.all([
      this.db.select().from(coffitcostEnvios).orderBy(desc(coffitcostEnvios.id)).limit(5),
      this.paraEnviar(),
    ]);
    const ultimoOk = ultimos.find((e) => e.ok) ?? null;
    return {
      configurado: coffitcost.configurado,
      destino: (() => { try { return new URL(coffitcost.url).host; } catch { return ''; } })(),
      envios: ultimos.map((e) => ({ ...e, fecha: e.fecha.toISOString(), firma: undefined })),
      paraMandar: actual.costos.length,
      sinCosto: actual.sinCosto,
      cambiosSinMandar: !ultimoOk || ultimoOk.firma !== actual.firma,
    };
  }

  async quitar(id: number) {
    const r = await this.db.delete(coffitIngredientes).where(eq(coffitIngredientes.id, id)).returning({ id: coffitIngredientes.id });
    if (!r.length) throw new NotFoundException('Ese ingrediente no existe.');
    return { ok: true };
  }
}

/* Lo opera quien opera Coffit: el envío ya le muestra el costo de la última factura. */
@Controller('cafeteria/ingredientes')
@Permiso('almacen.cafeteria')
export class IngredientesController {
  constructor(private readonly svc: IngredientesService) {}

  @Get() listar() { return this.svc.listar(); }
  @Get('coffitcost') estado() { return this.svc.estadoCoffitcost(); }
  @Post('coffitcost/enviar') enviar(@Auth() s: Sesion) { return this.svc.enviar('manual', s?.usuarioId ?? null); }
  @Post() crear(@Body() dto: IngredienteDto, @Auth() s: Sesion) { return this.svc.crear(dto, s?.usuarioId ?? null); }
  @Patch(':id') editar(@Param('id', ParseIntPipe) id: number, @Body() dto: IngredienteDto, @Auth() s: Sesion) { return this.svc.editar(id, dto, s?.usuarioId ?? null); }
  @Delete(':id') quitar(@Param('id', ParseIntPipe) id: number) { return this.svc.quitar(id); }
}

@Module({ controllers: [IngredientesController], providers: [IngredientesService], exports: [IngredientesService] })
export class IngredientesModule {}
