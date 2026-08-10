/**
 * VENCIMIENTOS — el vigía de fechas, sin lote.
 * ============================================================================
 * La lógica vino de la app externa de vencimientos (PHP/Hostinger) y el DATO
 * es 100% de este sistema: catálogo, sucursales, costos y usuarios reales.
 *
 * El modelo en tres actos:
 *
 *   1. CONTROL (sesión): alguien camina la góndola de una sucursal y anota
 *      "N unidades de X vencen tal día". El registro NO toca stock — es una
 *      lista de control con el costo CONGELADO del día (lección de cafetería:
 *      la pérdida de marzo no cambia en julio porque subió el catálogo).
 *   2. OFERTA: un registro por vencer NO arma su propia oferta paralela — va al
 *      MOTOR de ofertas de Ventas con el formulario ya lleno (`borradorOferta`)
 *      y, cuando se crea, el registro se ata a esa oferta (`vincularOferta`).
 *      Una sola forma de crear ofertas en el sistema, con su vista previa y sus
 *      siete mecánicas; el vencimiento aporta el contexto, no un motor propio.
 *   3. PROCESAR: cuando venció, se cierra el ciclo — cuántas unidades se
 *      salvaron vendiéndose y cuántas se perdieron. La pérdida REAL es
 *      costo × perdidas, y opcionalmente genera la baja de stock de verdad
 *      (movimiento 'vencido', disponible → estado vencido) EN LA MISMA
 *      transacción: o pasa todo, o no pasó nada.
 *
 * Los rangos de alerta son EXCLUYENTES (vencido / 0-7 / 8-15 / 16-30 / +30):
 * un registro vive en UNA sola tarjeta. Y los "días para vencer" se calculan
 * SIEMPRE contra el día de ARGENTINA (now() AT TIME ZONE), nunca contra
 * CURRENT_DATE del server en UTC — a la noche UTC ya es "mañana" y los
 * vencidos se adelantarían un día.
 */
import { Body, Controller, Delete, Get, Inject, Injectable, Module, Param, ParseIntPipe, Post, Put, Query, BadRequestException, NotFoundException } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty, IsArray, IsBoolean, IsInt, IsNumber, IsOptional, IsString, Matches, MaxLength, ValidateNested,
} from 'class-validator';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import {
  categorias, movimientos, presentaciones, productoEtiquetas, productoProveedores, productos,
  sucursales, usuarios, vencimientoSesiones, vencimientos,
} from '../db/schema';
import { InventarioModule } from '../inventario/inventario.module';
import { InventarioService } from '../inventario/inventario.service';
import { costoNetoEntry, formatoActivo } from '../inventario/pricing';
import { OfertasModule, OfertasService } from '../ofertas/ofertas.module';

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/** Día "para vencer" contra el calendario argentino, no el UTC del server. */
const HOY_AR = sql`(now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date`;
const DIAS = sql<number>`(${vencimientos.fechaVencimiento} - ${HOY_AR})`;

/* ---------------- Alcance y vigencia de una oferta (lado servidor) ----------------
 *
 * Las MISMAS tres reglas que el motor del POS aplica en la caja
 * (dashboard/modules/ventas/domain/ofertas.js). Están acá porque el cruce
 * oferta ↔ vencimiento se resuelve en la base y no puede opinar distinto que la
 * caja: si el motor dice que la oferta alcanza al producto, este aviso también.
 */

/** ¿El alcance de la oferta llega a este producto? Varias filas = unión. */
function alcanzaProducto(o: any, p: { id: number; marcaId: number | null; categoriaId: number | null; etiquetas: number[] }) {
  // El de ticket alcanza al total del ticket, no a productos.
  if (o.tipo === 'ticket') return false;
  // El del combo son sus componentes (no usa filas de alcance).
  if (o.tipo === 'combo') return (o.componentes ?? []).some((c: any) => c.productoId === p.id);
  return (o.alcances ?? []).some((a: any) => {
    switch (a.tipo) {
      case 'producto': return a.refId === p.id;
      case 'marca': return a.refId === p.marcaId;
      case 'categoria': return a.refId === p.categoriaId;
      case 'etiqueta': return p.etiquetas.includes(a.refId);
      default: return false;
    }
  });
}

/** '' = todas las sucursales; si no, la lista CSV manda. */
function cubreSucursal(o: any, sucursalId: number) {
  const ids = String(o.sucursales || '').split(',').map((x) => x.trim()).filter(Boolean);
  return !ids.length || ids.includes(String(sucursalId));
}

/** Estado calculado, igual que el panel de Ventas: por qué (no) está corriendo. */
function estadoOferta(o: any, ahora: Date) {
  if (!o.activa) return 'inactiva';
  if (o.desde && ahora < new Date(o.desde)) return 'programada';
  if (o.hasta && ahora > new Date(o.hasta)) return 'vencida';
  return 'vigente';
}

class ItemControlDto {
  @IsInt() productoId!: number;
  @IsOptional() @IsInt() presentacionId?: number;
  @IsNumber() cantidad!: number;
  /** La fecha impresa en el paquete. Puede ser pasada: registrar lo ya vencido vale. */
  @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) fechaVencimiento!: string;
  @IsOptional() @IsString() @MaxLength(300) observaciones?: string;
}

class CrearSesionDto {
  @IsInt() sucursalId!: number;
  @IsOptional() @IsInt() usuarioId?: number;
  @IsArray() @ArrayNotEmpty() @ValidateNested({ each: true }) @Type(() => ItemControlDto)
  items!: ItemControlDto[];
}

class EditarVencimientoDto {
  @IsOptional() @IsNumber() cantidad?: number;
  @IsOptional() @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) fechaVencimiento?: string;
  @IsOptional() @IsString() @MaxLength(300) observaciones?: string;
}

class ProcesarDto {
  @IsNumber() unidadesVendidas!: number;
  /** true = además genera la baja REAL de stock (movimiento 'vencido'). */
  @IsOptional() @IsBoolean() generarMerma?: boolean;
  @IsOptional() @IsInt() usuarioId?: number;
}

class VincularOfertaDto {
  @IsInt() ofertaId!: number;
}

/** El descuento que se propone en el borrador; lo decide quien arma la oferta. */
const PCT_SUGERIDO = 25;

@Injectable()
export class VencimientosService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly inv: InventarioService,
    private readonly ofertas: OfertasService,
  ) {}

  /* ---------------- Valuación (patrón cafetería, costo del formato activo) ---------------- */
  private async valuar(tx: any, items: { productoId: number; presentacionId?: number | null }[]) {
    const ids = [...new Set(items.map((it) => it.productoId))];
    const provs = await tx.select().from(productoProveedores)
      .where(inArray(productoProveedores.productoId, ids));
    const out = new Map<string, { prod: any; pres: any; costoU: number }>();
    for (const it of items) {
      const clave = `${it.productoId}-${it.presentacionId ?? 0}`;
      if (out.has(clave)) continue;
      const [prod] = await tx.select().from(productos).where(eq(productos.id, it.productoId)).limit(1);
      if (!prod) throw new BadRequestException('Producto inválido en el detalle.');
      /* Archivado no se controla: si no se vende, no tiene sentido vigilar su
       * fecha. El DISCONTINUADO sí — es justo el que hay que sacar a tiempo. */
      if (prod.estado === 'archivado') {
        throw new BadRequestException(`${prod.nombre} está archivado: ya no se vende, así que no hay nada que vigilar.`);
      }
      let pres: any = null;
      if (it.presentacionId) {
        [pres] = await tx.select().from(presentaciones).where(eq(presentaciones.id, it.presentacionId)).limit(1);
        if (!pres || pres.productoId !== prod.id) throw new BadRequestException(`Presentación inválida para ${prod.nombre}.`);
      }
      const cnKg = costoNetoEntry(formatoActivo(provs.filter((p: any) => p.productoId === prod.id)) as any, prod.iva);
      out.set(clave, { prod, pres, costoU: pres ? cnKg * (pres.tamKg ?? 1) : cnKg });
    }
    return out;
  }

  /* ============================ EL CONTROL ============================ */
  async crearSesion(o: CrearSesionDto) {
    return this.db.transaction(async (tx) => {
      const [suc] = await tx.select().from(sucursales).where(eq(sucursales.id, o.sucursalId)).limit(1);
      if (!suc) throw new BadRequestException('Sucursal inválida.');
      for (const it of o.items) {
        if (!(Number(it.cantidad) > 0)) throw new BadRequestException('Todas las cantidades deben ser mayores a 0.');
        if (isNaN(new Date(`${it.fechaVencimiento}T00:00:00`).getTime())) {
          throw new BadRequestException('Fecha de vencimiento inválida.');
        }
      }
      const val = await this.valuar(tx, o.items);

      let unidades = 0;
      for (const it of o.items) unidades += Number(it.cantidad);
      const [sesion] = await tx.insert(vencimientoSesiones).values({
        sucursalId: o.sucursalId,
        usuarioId: o.usuarioId ?? null,
        totalItems: o.items.length,
        totalUnidades: unidades,
      }).returning();

      const filas = o.items.map((it) => {
        const { prod, pres, costoU } = val.get(`${it.productoId}-${it.presentacionId ?? 0}`)!;
        const esGranelSuelto = prod.tipo === 'granel' && !pres;
        const tam = pres ? (pres.tamKg < 1 ? `${Math.round(pres.tamKg * 1000)} g` : `${pres.tamKg} kg`) : '';
        return {
          productoId: prod.id,
          presentacionId: pres?.id ?? null,
          sucursalId: o.sucursalId,
          sesionId: sesion.id,
          fechaVencimiento: it.fechaVencimiento,
          cantidad: Number(it.cantidad),
          costoUnitario: costoU,
          nombre: pres ? `${prod.nombre} · ${tam}` : prod.nombre,
          unidad: esGranelSuelto ? 'kg' : (pres ? 'paq.' : 'u.'),
          codigoBarras: pres?.codigoBarras || prod.codigoBarras || '',
          observaciones: (it.observaciones ?? '').trim(),
          usuarioId: o.usuarioId ?? null,
        };
      });
      const regs = await tx.insert(vencimientos).values(filas).returning();
      return { sesionId: sesion.id, registros: regs.length, unidades: r2(unidades) };
    });
  }

  /* ============================ EL LISTADO ============================ */
  async list() {
    const rows = await this.db.select({
      v: vencimientos,
      diasParaVencer: DIAS,
    }).from(vencimientos)
      .orderBy(asc(vencimientos.fechaVencimiento), asc(vencimientos.id));
    return rows.map((r) => ({ ...r.v, diasParaVencer: Number(r.diasParaVencer) }));
  }

  async editar(id: number, o: EditarVencimientoDto) {
    const [reg] = await this.db.select().from(vencimientos).where(eq(vencimientos.id, id)).limit(1);
    if (!reg) throw new NotFoundException('Registro inexistente.');
    if (reg.procesado) throw new BadRequestException('Ya se procesó: el cierre no se edita.');
    const patch: any = {};
    if (o.cantidad !== undefined) {
      if (!(Number(o.cantidad) > 0)) throw new BadRequestException('La cantidad debe ser mayor a 0.');
      patch.cantidad = Number(o.cantidad);
    }
    if (o.fechaVencimiento !== undefined) patch.fechaVencimiento = o.fechaVencimiento;
    if (o.observaciones !== undefined) patch.observaciones = o.observaciones.trim();
    if (!Object.keys(patch).length) return reg;
    const [out] = await this.db.update(vencimientos).set(patch).where(eq(vencimientos.id, id)).returning();
    return out;
  }

  async eliminar(id: number) {
    const [reg] = await this.db.select().from(vencimientos).where(eq(vencimientos.id, id)).limit(1);
    if (!reg) throw new NotFoundException('Registro inexistente.');
    if (reg.procesado) throw new BadRequestException('Ya se procesó: dejó pérdida real asentada y no se borra.');
    await this.db.delete(vencimientos).where(eq(vencimientos.id, id));
    return { ok: true };
  }

  /* ============================ EL CIERRE ============================ */
  /**
   * Venció → se procesa: cuántas se salvaron vendiéndose y cuántas se
   * perdieron. `generarMerma` además baja el stock real (movimiento 'vencido')
   * en la MISMA transacción. El claim del registro va con FOR UPDATE: dos
   * personas procesando lo mismo, una sola gana.
   */
  async procesar(id: number, o: ProcesarDto) {
    return this.db.transaction(async (tx) => {
      const [reg] = await tx.select().from(vencimientos).where(eq(vencimientos.id, id)).limit(1).for('update');
      if (!reg) throw new NotFoundException('Registro inexistente.');
      if (reg.procesado) throw new BadRequestException('Ya estaba procesado.');
      const uv = Number(o.unidadesVendidas);
      if (!(uv >= 0)) throw new BadRequestException('Las unidades vendidas no pueden ser negativas.');
      if (uv > reg.cantidad + 1e-9) {
        throw new BadRequestException(`Las vendidas no pueden superar lo registrado (${reg.cantidad}).`);
      }
      const perdidas = r2(reg.cantidad - uv);

      let mermaMovimientoId: number | null = null;
      if (o.generarMerma && perdidas > 0) {
        const res = await this.inv.opSimpleTx(tx, {
          tipo: 'vencido',
          productoId: reg.productoId,
          presId: reg.presentacionId,
          sucursalId: reg.sucursalId,
          cantidad: perdidas,
          usuarioId: o.usuarioId ?? null,
          motivo: `Vencimiento #${reg.id} · vencía ${reg.fechaVencimiento}`,
        });
        mermaMovimientoId = res.movimiento?.id ?? null;
      }

      const [out] = await tx.update(vencimientos).set({
        procesado: true,
        unidadesVendidas: uv,
        procesadoEn: new Date(),
        mermaMovimientoId,
      }).where(eq(vencimientos.id, id)).returning();
      return { ...out, perdidas, perdidaReal: r2(perdidas * reg.costoUnitario) };
    });
  }

  /* ============================ LA OFERTA ============================ */
  /**
   * El BORRADOR que abre el motor de ofertas con el formulario lleno. Acá viven
   * las reglas (a quién se le puede armar oferta y con qué valores); el
   * formulario de Ventas solo lo muestra y deja tocar todo antes de crear.
   *
   * El registro viaja con su contexto (cuánto hay, dónde, cuánta plata está en
   * juego) para que la decisión del descuento no sea a ciegas.
   */
  async borradorOferta(id: number) {
    const [reg] = await this.db.select({ v: vencimientos, dias: DIAS })
      .from(vencimientos).where(eq(vencimientos.id, id)).limit(1);
    if (!reg) throw new NotFoundException('Registro inexistente.');
    const v = reg.v;
    if (v.procesado) throw new BadRequestException('Ya se procesó: la oferta llega tarde.');
    if (Number(reg.dias) < 0) throw new BadRequestException('Ya venció: no se ofrece mercadería vencida.');
    if (v.ofertaId) throw new BadRequestException('Este registro ya tiene su oferta (mirala en Ventas › Ofertas).');

    const [prod] = await this.db.select({ nombre: productos.nombre, estado: productos.estado })
      .from(productos).where(eq(productos.id, v.productoId)).limit(1);
    if (!prod) throw new BadRequestException('El producto del registro no existe.');
    if (prod.estado === 'archivado') {
      throw new BadRequestException(`${prod.nombre} está archivado: no se vende, así que no hay oferta que valga.`);
    }
    const [suc] = await this.db.select({ nombre: sucursales.nombre })
      .from(sucursales).where(eq(sucursales.id, v.sucursalId)).limit(1);

    return {
      registro: {
        id: v.id,
        nombre: v.nombre,
        productoId: v.productoId,
        productoNombre: prod.nombre,
        presentacionId: v.presentacionId,
        sucursalId: v.sucursalId,
        sucursalNombre: suc?.nombre ?? '—',
        fechaVencimiento: v.fechaVencimiento,
        diasParaVencer: Number(reg.dias),
        cantidad: v.cantidad,
        unidad: v.unidad,
        costoUnitario: v.costoUnitario,
        perdidaPotencial: r2(v.cantidad * v.costoUnitario),
      },
      /* Con la forma EXACTA de una oferta (sin id): el formulario lo carga como
       * carga cualquier oferta para editar, y no necesita un camino aparte. */
      borrador: {
        nombre: `Por vencer · ${v.nombre}`,
        tipo: 'porcentaje',
        porcentaje: PCT_SUGERIDO,
        /* Hasta el día del vencimiento INCLUSIVE: pasada esa fecha la promo se
         * apaga sola, así el descuento nunca sobrevive a la mercadería. */
        hasta: v.fechaVencimiento,
        /* Solo donde está el lote: rematar en una sucursal que no lo tiene es
         * regalar margen sin salvar nada. */
        sucursales: String(v.sucursalId),
        activa: true,
        soloPrecioBase: true,
        /* Alcance = el PRODUCTO (así lo matchea el motor del POS). Viaja con
         * nombre para que la ficha se lea aunque el producto no esté en el
         * catálogo del POS (sin precio de mostrador todavía). */
        alcances: [{ tipo: 'producto', refId: v.productoId, nombre: prod.nombre }],
      },
    };
  }

  /**
   * Ata el registro a la oferta que se acaba de crear en el motor. El vínculo
   * es lo que hace que el registro figure «en oferta» y que el cruce de abajo
   * pueda avisar cuando algo se desalinea.
   *
   * Se exige que la oferta ALCANCE al producto: si no, el vínculo sería una
   * mentira («en oferta» en pantalla, cero descuento en la caja).
   */
  async vincularOferta(id: number, o: VincularOfertaDto) {
    const [reg] = await this.db.select().from(vencimientos).where(eq(vencimientos.id, id)).limit(1);
    if (!reg) throw new NotFoundException('Registro inexistente.');
    if (reg.procesado) throw new BadRequestException('Ya se procesó: el cierre no cambia.');
    if (reg.ofertaId && reg.ofertaId !== o.ofertaId) {
      throw new BadRequestException('Este registro ya está atado a otra oferta.');
    }

    const todas = await this.ofertas.listar();
    const oferta = todas.find((x: any) => x.id === o.ofertaId);
    if (!oferta) throw new NotFoundException('Oferta inexistente.');

    const prod = (await this.productosParaAlcance([reg.productoId]))[0];
    if (!prod || !alcanzaProducto(oferta, prod)) {
      throw new BadRequestException(
        `La oferta «${oferta.nombre}» no alcanza a ${reg.nombre}: sin eso el registro figuraría en oferta y en la caja no descontaría nada.`,
      );
    }

    // Idempotente: reintentar el mismo vínculo no es un error.
    if (reg.ofertaId === o.ofertaId) return { registro: reg, oferta };
    const [out] = await this.db.update(vencimientos).set({ ofertaId: o.ofertaId })
      .where(eq(vencimientos.id, id)).returning();
    return { registro: out, oferta };
  }

  /** Productos con lo necesario para resolver los cuatro alcances de una oferta. */
  private async productosParaAlcance(ids?: number[]) {
    const base = this.db.select({
      id: productos.id, nombre: productos.nombre, estado: productos.estado,
      marcaId: productos.marcaId, categoriaId: productos.categoriaId,
    }).from(productos);
    const filas = ids ? await base.where(inArray(productos.id, ids)) : await base;
    if (!filas.length) return [];
    const etqs = await this.db.select().from(productoEtiquetas)
      .where(inArray(productoEtiquetas.productoId, filas.map((p) => p.id)));
    return filas.map((p) => ({
      ...p,
      etiquetas: etqs.filter((e) => e.productoId === p.id).map((e) => e.etiquetaId),
    }));
  }

  /**
   * EL CRUCE: qué mercadería vigilada está (o debería estar) en oferta.
   *
   * No mira solo las ofertas nacidas acá: recorre TODAS las ofertas y resuelve
   * su alcance real (producto / marca / categoría / etiqueta / componentes de
   * combo) contra los registros abiertos. Así también aparece la oferta que
   * alguien armó en Ventas sobre algo que además está por vencer — que es
   * justamente lo que uno querría saber.
   *
   * De ahí salen las alarmas. La grave es una sola: mercadería VENCIDA con la
   * oferta corriendo, o sea la caja vendiendo con descuento algo que ya venció.
   */
  async ofertasEnJuego() {
    const ahora = new Date();
    const [todas, prods, abiertos] = await Promise.all([
      this.ofertas.listar(),
      this.productosParaAlcance(),
      this.db.select({ v: vencimientos, dias: DIAS }).from(vencimientos)
        .where(eq(vencimientos.procesado, false))
        .orderBy(asc(vencimientos.fechaVencimiento), asc(vencimientos.id)),
    ]);
    const porId = new Map(prods.map((p) => [p.id, p]));
    const filas: any[] = [];

    for (const { v, dias } of abiertos) {
      const prod = porId.get(v.productoId);
      const d = Number(dias);
      /* Las candidatas: la vinculada (aunque hoy no alcance — ese desajuste ES
       * la noticia) y toda oferta que llegue al producto por cualquier vía. */
      const candidatas = todas.filter((o: any) => (
        o.id === v.ofertaId || (prod && alcanzaProducto(o, prod))
      ));
      for (const o of candidatas) {
        const est = estadoOferta(o, ahora);
        const alcanza = !!prod && alcanzaProducto(o, prod);
        const cubreSuc = cubreSucursal(o, v.sucursalId);
        const hasta = o.hasta ? new Date(o.hasta) : null;
        const vence = new Date(`${v.fechaVencimiento}T23:59:59`);
        const corriendo = est === 'vigente' && alcanza && cubreSuc;
        const vinculada = v.ofertaId === o.id;

        /* La regla que mantiene la lista honesta: una fila existe si la oferta
         * está ATADA al registro (ahí cualquier desajuste es la noticia) o si
         * está DESCONTANDO de verdad ese lote. Una promo apagada, o que corre
         * solo en otra sucursal, no es "el producto en oferta": mostrarla sería
         * llenar la pantalla de filas «todo en orden» que no descuentan nada. */
        if (!vinculada && !corriendo) continue;

        let alarma: { codigo: string; severidad: string; texto: string } | null = null;
        if (corriendo && d < 0) {
          alarma = {
            codigo: 'vencida_en_oferta',
            severidad: 'grave',
            texto: `Venció hace ${Math.abs(d)} día${Math.abs(d) === 1 ? '' : 's'} y la oferta sigue corriendo: la caja lo está vendiendo con descuento. Apagá la oferta y procesá el registro.`,
          };
        } else if (vinculada && !alcanza) {
          alarma = {
            codigo: 'sin_alcance',
            severidad: 'media',
            texto: 'La oferta ya no alcanza a este producto (le cambiaron el alcance): figura «en oferta» pero en la caja no descuenta nada.',
          };
        } else if (vinculada && !cubreSuc) {
          alarma = {
            codigo: 'otra_sucursal',
            severidad: 'media',
            texto: 'La oferta no corre en la sucursal donde está la mercadería.',
          };
        } else if (d >= 0 && est === 'inactiva') {
          alarma = {
            codigo: 'oferta_apagada',
            severidad: 'media',
            texto: `La oferta está apagada y todavía quedan ${d} día${d === 1 ? '' : 's'} de mercadería: el descuento no está corriendo.`,
          };
        } else if (d >= 0 && est === 'vencida') {
          alarma = {
            codigo: 'oferta_terminada',
            severidad: 'media',
            texto: `La oferta terminó y quedan ${d} día${d === 1 ? '' : 's'} de mercadería sin descuento.`,
          };
        } else if (d >= 0 && est === 'programada') {
          alarma = {
            codigo: 'oferta_programada',
            severidad: 'media',
            texto: o.desde && new Date(o.desde) > vence
              ? 'La oferta arranca DESPUÉS de que la mercadería venza: no la va a salvar.'
              : 'La oferta todavía no arrancó.',
          };
        } else if (corriendo && hasta && hasta < vence) {
          const sin = Math.max(0, Math.ceil((vence.getTime() - hasta.getTime()) / 86400000));
          alarma = {
            codigo: 'oferta_corta',
            severidad: 'baja',
            texto: `La oferta corta antes de la fecha del paquete: quedan ${sin} día${sin === 1 ? '' : 's'} de mercadería sin descuento.`,
          };
        } else if (d < 0) {
          /* Vencido y la oferta ya NO descuenta (se apagó o terminó a tiempo):
           * no es grave, pero decir "todo en orden" al lado de "venció hace 3
           * días" sería absurdo — el registro sigue abierto y hay que cerrarlo. */
          alarma = {
            codigo: 'vencida_sin_oferta',
            severidad: 'media',
            texto: `Ya venció hace ${Math.abs(d)} día${Math.abs(d) === 1 ? '' : 's'} y la oferta no lo está descontando (bien): queda retirarlo y procesar el registro.`,
          };
        }

        filas.push({
          vencimientoId: v.id,
          productoId: v.productoId,
          presentacionId: v.presentacionId,
          nombre: v.nombre,
          sucursalId: v.sucursalId,
          fechaVencimiento: v.fechaVencimiento,
          diasParaVencer: d,
          cantidad: v.cantidad,
          unidad: v.unidad,
          costoUnitario: v.costoUnitario,
          enJuego: r2(v.cantidad * v.costoUnitario),
          ofertaId: o.id,
          ofertaNombre: o.nombre,
          ofertaTipo: o.tipo,
          porcentaje: o.porcentaje,
          precio: o.precio,
          lleva: o.lleva,
          paga: o.paga,
          montoMinimo: o.montoMinimo,
          ofertaDesde: o.desde,
          ofertaHasta: o.hasta,
          ofertaSucursales: o.sucursales,
          ofertaEstado: est,
          vinculada,
          corriendo,
          alarma,
        });
      }
    }

    /* Lo grave arriba, y dentro de cada grupo lo que vence primero. */
    const peso: Record<string, number> = { grave: 0, media: 1, baja: 2 };
    filas.sort((a, b) => (
      (peso[a.alarma?.severidad] ?? 3) - (peso[b.alarma?.severidad] ?? 3)
      || a.diasParaVencer - b.diasParaVencer
    ));

    const graves = filas.filter((f) => f.alarma?.severidad === 'grave');
    return {
      filas,
      resumen: {
        filas: filas.length,
        productos: new Set(filas.map((f) => f.productoId)).size,
        ofertas: new Set(filas.map((f) => f.ofertaId)).size,
        corriendo: filas.filter((f) => f.corriendo).length,
        graves: graves.length,
        medias: filas.filter((f) => f.alarma?.severidad === 'media').length,
        bajas: filas.filter((f) => f.alarma?.severidad === 'baja').length,
        /* La plata que se está regalando: mercadería vencida con descuento
         * puesto. Sin duplicar si dos ofertas alcanzan el mismo registro. */
        plataGrave: r2([...new Map(graves.map((f) => [f.vencimientoId, f.enJuego])).values()]
          .reduce((a, n) => a + n, 0)),
      },
    };
  }

  /* ============================ EL RESUMEN ============================ */
  /** Las tarjetas del panel: rangos EXCLUYENTES sobre lo abierto + el histórico procesado. */
  async resumen() {
    const abiertos = await this.db.select({
      rango: sql<string>`case
        when ${DIAS} < 0 then 'vencido'
        when ${DIAS} <= 7 then 'd7'
        when ${DIAS} <= 15 then 'd15'
        when ${DIAS} <= 30 then 'd30'
        else 'vigente' end`,
      n: sql<number>`count(*)::int`,
      unidades: sql<number>`coalesce(sum(${vencimientos.cantidad}), 0)`,
      plata: sql<number>`coalesce(sum(${vencimientos.cantidad} * ${vencimientos.costoUnitario}), 0)`,
    }).from(vencimientos)
      .where(eq(vencimientos.procesado, false))
      .groupBy(sql`1`);

    const [proc] = await this.db.select({
      n: sql<number>`count(*)::int`,
      vendidas: sql<number>`coalesce(sum(${vencimientos.unidadesVendidas}), 0)`,
      perdidas: sql<number>`coalesce(sum(${vencimientos.cantidad} - ${vencimientos.unidadesVendidas}), 0)`,
      perdidaReal: sql<number>`coalesce(sum((${vencimientos.cantidad} - ${vencimientos.unidadesVendidas}) * ${vencimientos.costoUnitario}), 0)`,
    }).from(vencimientos).where(eq(vencimientos.procesado, true));

    const ultimos = await this.db.select({ v: vencimientos, diasParaVencer: DIAS })
      .from(vencimientos).orderBy(desc(vencimientos.id)).limit(5);

    const base = { n: 0, unidades: 0, plata: 0 };
    const por = Object.fromEntries(abiertos.map((a) => [a.rango, {
      n: Number(a.n), unidades: r2(Number(a.unidades)), plata: r2(Number(a.plata)),
    }]));
    return {
      vencidos: por.vencido ?? base,
      d7: por.d7 ?? base,
      d15: por.d15 ?? base,
      d30: por.d30 ?? base,
      vigentes: por.vigente ?? base,
      procesados: {
        n: Number(proc?.n) || 0,
        vendidas: r2(Number(proc?.vendidas)),
        perdidas: r2(Number(proc?.perdidas)),
        perdidaReal: r2(Number(proc?.perdidaReal)),
      },
      ultimos: ultimos.map((u) => ({ ...u.v, diasParaVencer: Number(u.diasParaVencer) })),
    };
  }

  /* ============================ LOS REPORTES ============================ */
  /**
   * Todo el análisis del período en un viaje. Las mermas EXCLUYEN los
   * movimientos generados al procesar vencimientos (ya cuentan como pérdida
   * real del registro — sumarlos de nuevo duplicaría la plata).
   */
  async reportes(periodo: string) {
    const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
    const desde = new Date(hoy);
    if (periodo === 'semana') desde.setDate(desde.getDate() - 7);
    else if (periodo === 'trimestre') desde.setMonth(desde.getMonth() - 3);
    else if (periodo === 'anio') desde.setMonth(0, 1);
    else desde.setDate(1); // mes calendario (default)

    const enPeriodo = sql`${vencimientos.creadoEn} >= ${desde}`;
    const perdidaRealExpr = sql`(${vencimientos.cantidad} - ${vencimientos.unidadesVendidas}) * ${vencimientos.costoUnitario}`;

    const [general] = await this.db.select({
      registros: sql<number>`count(*)::int`,
      unidades: sql<number>`coalesce(sum(${vencimientos.cantidad}), 0)`,
      estimada: sql<number>`coalesce(sum(${vencimientos.cantidad} * ${vencimientos.costoUnitario}), 0)`,
      procesados: sql<number>`count(*) filter (where ${vencimientos.procesado})::int`,
      vendidas: sql<number>`coalesce(sum(${vencimientos.unidadesVendidas}) filter (where ${vencimientos.procesado}), 0)`,
      real: sql<number>`coalesce(sum(${perdidaRealExpr}) filter (where ${vencimientos.procesado}), 0)`,
    }).from(vencimientos).where(enPeriodo);

    // Mermas del período: merma + defectuoso + vencido SUELTO (no nacido de procesar).
    const noDeProcesar = sql`${movimientos.id} not in (select merma_movimiento_id from vencimientos where merma_movimiento_id is not null)`;
    const condMermas = and(
      inArray(movimientos.tipo, ['merma', 'defectuoso', 'vencido'] as any),
      sql`${movimientos.fecha} >= ${desde}`,
      noDeProcesar,
    );
    const [mermasG] = await this.db.select({
      registros: sql<number>`count(*)::int`,
      unidades: sql<number>`coalesce(sum(${movimientos.cantidad}), 0)`,
      plata: sql<number>`coalesce(sum(${movimientos.cantidad} * ${movimientos.costoUnitario}), 0)`,
    }).from(movimientos).where(condMermas);

    const porSucursalVenc = await this.db.select({
      sucursalId: vencimientos.sucursalId,
      registros: sql<number>`count(*)::int`,
      unidades: sql<number>`coalesce(sum(${vencimientos.cantidad}), 0)`,
      estimada: sql<number>`coalesce(sum(${vencimientos.cantidad} * ${vencimientos.costoUnitario}), 0)`,
      real: sql<number>`coalesce(sum(${perdidaRealExpr}) filter (where ${vencimientos.procesado}), 0)`,
    }).from(vencimientos).where(enPeriodo).groupBy(vencimientos.sucursalId);

    const porSucursalMerma = await this.db.select({
      sucursalId: movimientos.sucursalId,
      registros: sql<number>`count(*)::int`,
      plata: sql<number>`coalesce(sum(${movimientos.cantidad} * ${movimientos.costoUnitario}), 0)`,
    }).from(movimientos).where(condMermas).groupBy(movimientos.sucursalId);

    const porCategoria = await this.db.select({
      categoria: sql<string>`coalesce(${categorias.nombre}, 'Sin categoría')`,
      registros: sql<number>`count(*)::int`,
      unidades: sql<number>`coalesce(sum(${vencimientos.cantidad}), 0)`,
      estimada: sql<number>`coalesce(sum(${vencimientos.cantidad} * ${vencimientos.costoUnitario}), 0)`,
    }).from(vencimientos)
      .innerJoin(productos, eq(productos.id, vencimientos.productoId))
      .leftJoin(categorias, eq(categorias.id, productos.categoriaId))
      .where(enPeriodo)
      .groupBy(sql`1`)
      // Ordinal 4 = la pérdida estimada: lo que más plata pierde va arriba.
      .orderBy(sql`4 desc`);

    // Los que MÁS vencen — histórico completo: la señal para comprar distinto.
    const frecuentes = await this.db.select({
      productoId: vencimientos.productoId,
      presentacionId: vencimientos.presentacionId,
      nombre: vencimientos.nombre,
      veces: sql<number>`count(*)::int`,
      unidades: sql<number>`coalesce(sum(${vencimientos.cantidad}), 0)`,
      plata: sql<number>`coalesce(sum(${vencimientos.cantidad} * ${vencimientos.costoUnitario}), 0)`,
    }).from(vencimientos)
      .groupBy(vencimientos.productoId, vencimientos.presentacionId, vencimientos.nombre)
      .orderBy(sql`4 desc, 6 desc`)
      .limit(10);

    const mesExpr = sql<string>`to_char(${vencimientos.creadoEn} AT TIME ZONE 'America/Argentina/Buenos_Aires', 'YYYY-MM')`;
    const seisMeses = new Date(hoy); seisMeses.setMonth(seisMeses.getMonth() - 6);
    const historial = await this.db.select({
      mes: mesExpr,
      registros: sql<number>`count(*)::int`,
      unidades: sql<number>`coalesce(sum(${vencimientos.cantidad}), 0)`,
      estimada: sql<number>`coalesce(sum(${vencimientos.cantidad} * ${vencimientos.costoUnitario}), 0)`,
      real: sql<number>`coalesce(sum(${perdidaRealExpr}) filter (where ${vencimientos.procesado}), 0)`,
    }).from(vencimientos)
      .where(sql`${vencimientos.creadoEn} >= ${seisMeses}`)
      .groupBy(sql`1`)
      .orderBy(sql`1 desc`);

    const [sesionesStats] = await this.db.select({
      sesiones: sql<number>`count(*)::int`,
      items: sql<number>`coalesce(sum(${vencimientoSesiones.totalItems}), 0)::int`,
      unidades: sql<number>`coalesce(sum(${vencimientoSesiones.totalUnidades}), 0)`,
    }).from(vencimientoSesiones).where(sql`${vencimientoSesiones.fecha} >= ${desde}`);

    const sesiones = await this.db.select({
      s: vencimientoSesiones,
      usuarioNombre: sql<string>`coalesce(${usuarios.nombre}, '—')`,
      sucursalNombre: sucursales.nombre,
    }).from(vencimientoSesiones)
      .leftJoin(usuarios, eq(usuarios.id, vencimientoSesiones.usuarioId))
      .innerJoin(sucursales, eq(sucursales.id, vencimientoSesiones.sucursalId))
      .orderBy(desc(vencimientoSesiones.id)).limit(20);

    return {
      periodo: { clave: periodo || 'mes', desde: desde.toISOString() },
      general: {
        registros: Number(general?.registros) || 0,
        unidades: r2(Number(general?.unidades)),
        estimada: r2(Number(general?.estimada)),
        procesados: Number(general?.procesados) || 0,
        vendidas: r2(Number(general?.vendidas)),
        real: r2(Number(general?.real)),
      },
      mermas: {
        registros: Number(mermasG?.registros) || 0,
        unidades: r2(Number(mermasG?.unidades)),
        plata: r2(Number(mermasG?.plata)),
      },
      porSucursal: porSucursalVenc.map((v) => {
        const m = porSucursalMerma.find((x) => x.sucursalId === v.sucursalId);
        return {
          sucursalId: v.sucursalId,
          registros: Number(v.registros),
          unidades: r2(Number(v.unidades)),
          estimada: r2(Number(v.estimada)),
          real: r2(Number(v.real)),
          mermas: r2(Number(m?.plata) || 0),
          total: r2(Number(v.estimada) + (Number(m?.plata) || 0)),
        };
      }).sort((a, b) => b.total - a.total),
      porCategoria: porCategoria.map((c) => ({
        categoria: c.categoria,
        registros: Number(c.registros),
        unidades: r2(Number(c.unidades)),
        estimada: r2(Number(c.estimada)),
      })),
      frecuentes: frecuentes.map((f) => ({
        ...f, veces: Number(f.veces), unidades: r2(Number(f.unidades)), plata: r2(Number(f.plata)),
      })),
      historial: historial.map((h) => ({
        mes: h.mes, registros: Number(h.registros), unidades: r2(Number(h.unidades)),
        estimada: r2(Number(h.estimada)), real: r2(Number(h.real)),
      })),
      sesiones: {
        stats: {
          sesiones: Number(sesionesStats?.sesiones) || 0,
          items: Number(sesionesStats?.items) || 0,
          unidades: r2(Number(sesionesStats?.unidades)),
        },
        ultimas: sesiones.map((x) => ({
          ...x.s, usuarioNombre: x.usuarioNombre, sucursalNombre: x.sucursalNombre,
        })),
      },
    };
  }
}

@Controller('vencimientos')
export class VencimientosController {
  constructor(private readonly svc: VencimientosService) {}

  /* Las rutas fijas van ANTES de las de `:id`: 'ofertas' no es un id. */
  @Get() list() { return this.svc.list(); }
  @Get('resumen') resumen() { return this.svc.resumen(); }
  @Get('reportes') reportes(@Query('periodo') periodo?: string) { return this.svc.reportes(periodo || 'mes'); }
  @Get('ofertas') ofertas() { return this.svc.ofertasEnJuego(); }
  @Post('sesiones') crearSesion(@Body() dto: CrearSesionDto) { return this.svc.crearSesion(dto); }
  @Get(':id/borrador-oferta') borradorOferta(@Param('id', ParseIntPipe) id: number) { return this.svc.borradorOferta(id); }
  @Put(':id') editar(@Param('id', ParseIntPipe) id: number, @Body() dto: EditarVencimientoDto) { return this.svc.editar(id, dto); }
  @Delete(':id') eliminar(@Param('id', ParseIntPipe) id: number) { return this.svc.eliminar(id); }
  @Post(':id/procesar') procesar(@Param('id', ParseIntPipe) id: number, @Body() dto: ProcesarDto) { return this.svc.procesar(id, dto); }
  @Post(':id/vincular-oferta') vincularOferta(@Param('id', ParseIntPipe) id: number, @Body() dto: VincularOfertaDto) {
    return this.svc.vincularOferta(id, dto);
  }
}

@Module({
  imports: [InventarioModule, OfertasModule],
  providers: [VencimientosService],
  controllers: [VencimientosController],
})
export class VencimientosModule {}
