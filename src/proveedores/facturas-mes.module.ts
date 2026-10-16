/**
 * FACTURAS DEL MES (0158, 11/10/2026 — pedido del dueño)
 * ============================================================================
 * El proveedor entrega todo el mes con remitos SIN IVA, y eso es lo que se le
 * paga. A fin de mes hace las facturas de todo lo comprado (con IVA) y, por
 * cada una, cobra aparte una comisión sin factura. Siempre mensual.
 *
 * Lo que pasa al cargar las facturas de un mes, en UNA transacción:
 *
 *   · LAS ENTREGAS DEL MES (remitos y liquidaciones de ese proveedor) quedan
 *     enganchadas a esas facturas. Los remitos pasan a LIQUIDACIÓN: la deuda
 *     nace por su valor SIN IVA, que es lo que se paga. El stock no se toca
 *     (entró con cada entrega).
 *   · LAS FACTURAS son solo fiscales: su IVA es crédito y sus percepciones pago
 *     a cuenta, por SU fecha (Resultados IVA, Resultados). No suman deuda: el
 *     IVA no se le paga al proveedor.
 *   · LA COMISIÓN de cada factura es una liquidación aparte, sin IVA ni stock:
 *     deuda que se paga desde Pagos como cualquier otra. NO es gasto: ya entra
 *     al costo de los productos por su «Comisión %» (0157) — como gasto se
 *     contaría dos veces en Resultados.
 *
 * Anular el mes deshace lo fiscal y la comisión (si no tiene pagos); las
 * entregas quedan como liquidaciones —se deben igual— y vuelven a quedar
 * pendientes de sus facturas.
 */
import {
  BadRequestException, Body, Controller, ForbiddenException, Get, Inject, Injectable, Module,
  NotFoundException, Param, ParseIntPipe, Post, Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayNotEmpty, IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength,
  Min, MinLength, ValidateNested,
} from 'class-validator';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Auth, Permiso, type Sesion } from '../auth/auth.decoradores';
import { esJefe } from '../auth/auth.guard';
import { AuditoriaModule, AuditoriaService } from '../auditoria/auditoria.module';
import { fechaDeCuenta } from '../cafeteria/cuenta';
import { exigirFueraDeConciliado } from '../common/conciliacion';
import { etiquetaDoc } from '../common/documentos';
import { CONDICION_TEXTO, LETRAS_POR_CONDICION } from '../comprobantes/comprobantes.module';
import { DRIZZLE, Database } from '../db/drizzle';
import {
  comprobanteItems, comprobantePercepciones, comprobantes, facturacionesMes, facturacionesMesFacturas,
  productoProveedores, proveedores, usuarios,
} from '../db/schema';
import { fechaDeTexto, normalizarPuntoVenta } from '../facturas/comun';

const ZONA = 'America/Argentina/Buenos_Aires';
const EPS = 0.009;
const r2 = (n: unknown) => Math.round((Number(n) || 0) * 100) / 100;
const MES_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const pesos = (n: number) => `$${r2(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** 'AAAA-MM' de hoy en la Argentina. */
const mesActual = () => new Intl.DateTimeFormat('sv-SE', { timeZone: ZONA, year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);
/** 'AAAA-MM' → «octubre de 2026». */
export const nombreMes = (mes: string) => {
  const [y, m] = mes.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
};
const etiquetaFactura = (f: { letra: string; puntoVenta: string; numero: number }) =>
  `Factura ${f.letra} ${f.puntoVenta}-${String(f.numero).padStart(8, '0')}`;
/** Las entregas del mes `$mes` ('AAAA-MM'), en el día argentino. */
const EN_MES = (mes: string) => sql`${comprobantes.fecha} >= (${`${mes}-01`}::date::timestamp at time zone ${ZONA})
  and ${comprobantes.fecha} < ((${`${mes}-01`}::date + interval '1 month')::timestamp at time zone ${ZONA})`;
/** Una liquidación que es la COMISIÓN de una factura del mes no es una entrega. */
const NO_ES_COMISION = sql`not exists (select 1 from facturaciones_mes_facturas ff where ff.comision_comprobante_id = ${comprobantes.id})`;

/* --------------------------------- DTOs --------------------------------- */

class FacturaMesDto {
  @IsIn(['A', 'B', 'C']) letra!: string;
  @IsString() @MaxLength(8) puntoVenta!: string;
  @IsInt() @Min(1) @Max(99_999_999) numero!: number;
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'La fecha de la factura va como AAAA-MM-DD.' }) fecha!: string;
  @IsOptional() @IsString() @MaxLength(32) cae?: string;
  @IsNumber() @Min(0) @Max(10_000_000_000) neto!: number;
  @IsOptional() @IsNumber() @Min(0) @Max(10_000_000_000) iva?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(10_000_000_000) percIva?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(10_000_000_000) percIibb?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(10_000_000_000) percOtras?: number;
  /** El total del PAPEL: si viene, tiene que cerrar con neto + IVA + percepciones. */
  @IsOptional() @IsNumber() @Min(0) @Max(10_000_000_000) total?: number;
  /** La comisión que el proveedor cobra por ESTA factura (sin factura). */
  @IsOptional() @IsNumber() @Min(0) @Max(10_000_000_000) comision?: number;
}

export class CargarFacturasMesDto {
  @Matches(MES_RE, { message: 'El mes va como AAAA-MM.' }) mes!: string;
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => FacturaMesDto)
  facturas!: FacturaMesDto[];
  @IsOptional() @IsString() @MaxLength(500) observaciones?: string;
}

export class AnularFacturasMesDto {
  @IsString() @MinLength(3) @MaxLength(300) motivo!: string;
}

/* ------------------------------- Servicio ------------------------------- */

@Injectable()
export class FacturasMesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditoriaService,
  ) {}

  private async proveedor(ex: any, id: number) {
    const [p] = await ex.select().from(proveedores).where(eq(proveedores.id, id)).limit(1);
    if (!p) throw new NotFoundException('Proveedor inexistente.');
    return p;
  }

  /** Las entregas del mes que todavía no tienen sus facturas (con candado si va en una transacción). */
  private async entregasPendientes(ex: any, proveedorId: number, mes: string, candado = false) {
    const q = ex.select().from(comprobantes).where(and(
      eq(comprobantes.proveedorId, proveedorId),
      eq(comprobantes.estado, 'confirmado'),
      inArray(comprobantes.tipo, ['remito', 'liquidacion']),
      isNull(comprobantes.facturacionMesId),
      EN_MES(mes),
      NO_ES_COMISION,
    )).orderBy(asc(comprobantes.fecha), asc(comprobantes.id));
    return candado ? q.for('update') : q;
  }

  private entrega(c: any) {
    return {
      id: c.id, etiqueta: etiquetaDoc(c), tipo: c.tipo, fecha: c.fecha,
      /* Sin IVA: lo que se le paga. En el remito es su neto (su total traía el
       * IVA de catálogo); en la liquidación, neto y total son lo mismo. */
      neto: r2(c.subtotalNeto), pagado: r2(c.pagado), sucursalId: c.sucursalId,
    };
  }

  /**
   * LA PANTALLA: los meses del proveedor (pendientes y facturados), el mes
   * pedido con sus entregas —o sus facturas, si ya se cargaron— y la comisión
   * que tienen sus productos, para proponer la de cada factura.
   */
  async vista(proveedorId: number, mesPedido?: string) {
    const p = await this.proveedor(this.db, proveedorId);
    const actual = mesActual();

    const [pendientes, hechas, porcs] = await Promise.all([
      this.db.execute(sql`
        select to_char(${comprobantes.fecha} at time zone ${ZONA}, 'YYYY-MM') as mes,
          count(*)::int as documentos, coalesce(sum(${comprobantes.subtotalNeto}), 0) as neto
        from ${comprobantes}
        where ${comprobantes.proveedorId} = ${proveedorId} and ${comprobantes.estado} = 'confirmado'
          and ${comprobantes.tipo} in ('remito', 'liquidacion') and ${comprobantes.facturacionMesId} is null
          and ${NO_ES_COMISION}
        group by 1 order by 1 desc limit 24`),
      this.db.select({
        id: facturacionesMes.id, mes: facturacionesMes.mes, netoDocumentos: facturacionesMes.netoDocumentos,
        facturas: sql<number>`(select count(*)::int from facturaciones_mes_facturas ff where ff.facturacion_id = ${facturacionesMes.id})`,
      }).from(facturacionesMes)
        .where(and(eq(facturacionesMes.proveedorId, proveedorId), eq(facturacionesMes.estado, 'activa')))
        .orderBy(desc(facturacionesMes.mes)).limit(24),
      this.db.select({ comision: productoProveedores.comision, n: sql<number>`count(*)::int` })
        .from(productoProveedores).where(eq(productoProveedores.proveedorId, proveedorId))
        .groupBy(productoProveedores.comision),
    ]);

    const meses = new Map<string, any>();
    for (const x of (pendientes as any).rows ?? pendientes) {
      meses.set(x.mes, { mes: x.mes, nombre: nombreMes(x.mes), pendientes: Number(x.documentos), netoPendiente: r2(x.neto), facturacionId: null });
    }
    for (const h of hechas) {
      const m = meses.get(h.mes) ?? { mes: h.mes, nombre: nombreMes(h.mes), pendientes: 0, netoPendiente: 0 };
      meses.set(h.mes, { ...m, facturacionId: h.id, facturas: Number(h.facturas), netoFacturado: r2(h.netoDocumentos) });
    }
    const lista = [...meses.values()].sort((a, b) => (a.mes < b.mes ? 1 : -1));

    /* El mes que se abre: el pedido; si no, el MÁS VIEJO ya cerrado que tenga
     * entregas sin sus facturas (es el que falta cargar); si no, el anterior. */
    const [y, m] = actual.split('-').map(Number);
    const anterior = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
    const viejoPendiente = lista.filter((x) => x.pendientes > 0 && !x.facturacionId && x.mes < actual).map((x) => x.mes).sort()[0];
    const mes = mesPedido && MES_RE.test(mesPedido) ? mesPedido : (viejoPendiente ?? anterior);
    if (mes > actual) throw new BadRequestException('Ese mes todavía no empezó.');

    const entregas = (await this.entregasPendientes(this.db, proveedorId, mes)).map((c: any) => this.entrega(c));
    const hecha = hechas.find((h) => h.mes === mes);
    const facturacion = hecha ? await this.detalle(hecha.id) : null;

    /* La comisión de sus productos: la más común que no sea cero. */
    const conComision = porcs.filter((x) => Number(x.comision) > 0).sort((a, b) => b.n - a.n);
    return {
      proveedor: {
        id: p.id, nombre: p.nombre, facturaMensual: !!p.facturaMensual, condicionIva: p.condicionIva,
        letras: LETRAS_POR_CONDICION[p.condicionIva ?? 'responsable_inscripto'] ?? ['A', 'B', 'C'],
        conciliadoHasta: p.conciliadoHasta,
      },
      mes, nombreMes: nombreMes(mes), mesActual: actual,
      meses: lista,
      entregas,
      netoEntregas: r2(entregas.reduce((a: number, e: any) => a + e.neto, 0)),
      facturacion,
      comisionSugerida: conComision.length ? Number(conComision[0].comision) : 0,
    };
  }

  /** Un mes facturado: sus facturas, sus entregas y el estado de cada comisión. */
  private async detalle(id: number) {
    const [h] = await this.db.select({
      f: facturacionesMes, usuario: usuarios.nombre,
    }).from(facturacionesMes).leftJoin(usuarios, eq(usuarios.id, facturacionesMes.usuarioId))
      .where(eq(facturacionesMes.id, id)).limit(1);
    if (!h) throw new NotFoundException('Esas facturas del mes no existen.');
    const [facturas, entregas] = await Promise.all([
      this.db.select({
        f: facturacionesMesFacturas, comPagado: comprobantes.pagado, comEstado: comprobantes.estado,
        comLetra: comprobantes.letra, comPv: comprobantes.puntoVenta, comNumero: comprobantes.numero, comTipo: comprobantes.tipo,
      }).from(facturacionesMesFacturas)
        .leftJoin(comprobantes, eq(comprobantes.id, facturacionesMesFacturas.comisionComprobanteId))
        .where(eq(facturacionesMesFacturas.facturacionId, id))
        .orderBy(asc(facturacionesMesFacturas.fecha), asc(facturacionesMesFacturas.id)),
      this.db.select().from(comprobantes).where(eq(comprobantes.facturacionMesId, id))
        .orderBy(asc(comprobantes.fecha), asc(comprobantes.id)),
    ]);
    const filas = facturas.map(({ f, comPagado, comEstado, comLetra, comPv, comNumero, comTipo }) => ({
      id: f.id, etiqueta: etiquetaFactura(f), letra: f.letra, puntoVenta: f.puntoVenta, numero: f.numero,
      fecha: f.fecha, cae: f.cae, neto: f.neto, iva: f.iva, percIva: f.percIva, percIibb: f.percIibb, percOtras: f.percOtras,
      total: f.total, comision: f.comision,
      comisionDoc: f.comisionComprobanteId ? {
        id: f.comisionComprobanteId, pagado: r2(comPagado), estado: comEstado,
        etiqueta: etiquetaDoc({ tipo: comTipo ?? 'liquidacion', letra: comLetra, puntoVenta: comPv, numero: comNumero, id: f.comisionComprobanteId }),
      } : null,
    }));
    const suma = (k: string) => r2(filas.reduce((a, x: any) => a + (Number(x[k]) || 0), 0));
    return {
      id: h.f.id, mes: h.f.mes, estado: h.f.estado, creadoEn: h.f.creadoEn, usuario: h.usuario ?? '',
      observaciones: h.f.observaciones, netoDocumentos: r2(h.f.netoDocumentos),
      facturas: filas,
      totales: {
        neto: suma('neto'), iva: suma('iva'), percIva: suma('percIva'), percIibb: suma('percIibb'),
        percOtras: suma('percOtras'), total: suma('total'), comision: suma('comision'),
      },
      entregas: entregas.map((c) => this.entrega(c)),
    };
  }

  /** Valida y normaliza las facturas del papel. Todo lo que se puede revisar sin la base. */
  private normalizar(dto: CargarFacturasMesDto, p: any) {
    const letras = LETRAS_POR_CONDICION[p.condicionIva ?? 'responsable_inscripto'] ?? ['A', 'B', 'C'];
    const inicioMes = new Date(`${dto.mes}-01T00:00:00`);
    const manana = new Date(); manana.setHours(0, 0, 0, 0); manana.setDate(manana.getDate() + 2);
    const vistas = new Set<string>();
    return dto.facturas.map((f) => {
      const puntoVenta = normalizarPuntoVenta(f.puntoVenta);
      const nombre = etiquetaFactura({ letra: f.letra, puntoVenta, numero: f.numero });
      if (!letras.includes(f.letra)) {
        throw new BadRequestException(
          `${p.nombre} figura como ${CONDICION_TEXTO[p.condicionIva] ?? p.condicionIva}: emite factura ${letras.join(' o ')}, no ${f.letra} (${nombre}).`,
        );
      }
      const clave = `${f.letra}|${puntoVenta}|${f.numero}`;
      if (vistas.has(clave)) throw new BadRequestException(`La ${nombre} está dos veces.`);
      vistas.add(clave);

      const fecha = fechaDeTexto(f.fecha);
      if (!fecha || Number.isNaN(fecha.getTime())) throw new BadRequestException(`La fecha de la ${nombre} no es válida.`);
      if (fecha < inicioMes) {
        throw new BadRequestException(`La ${nombre} es del ${fecha.toLocaleDateString('es-AR')}: es anterior a ${nombreMes(dto.mes)}, el mes que factura.`);
      }
      if (fecha >= manana) throw new BadRequestException(`La ${nombre} tiene fecha futura (${fecha.toLocaleDateString('es-AR')}).`);

      const neto = r2(f.neto);
      if (!(neto > 0)) throw new BadRequestException(`La ${nombre} no tiene neto.`);
      /* Solo la A discrimina IVA: en la B y la C el IVA viene adentro y NO es crédito. */
      const iva = r2(f.iva);
      if (f.letra !== 'A' && iva > 0) {
        throw new BadRequestException(`La ${nombre} no discrimina IVA (solo la A): cargá su importe como neto y el IVA en cero.`);
      }
      if (iva > neto * 0.27 + 0.01) {
        throw new BadRequestException(`El IVA de la ${nombre} (${pesos(iva)}) es más del 27 % de su neto: revisá los importes.`);
      }
      const percIva = r2(f.percIva); const percIibb = r2(f.percIibb); const percOtras = r2(f.percOtras);
      for (const [cual, imp] of [['de IVA', percIva], ['de IIBB', percIibb], ['otras', percOtras]] as const) {
        if (imp > neto * 0.15 + 0.01) {
          throw new BadRequestException(`La percepción ${cual} de la ${nombre} es el ${Math.round((imp / neto) * 100)} % del neto: las percepciones rondan entre 1 % y 6 %.`);
        }
      }
      const total = r2(neto + iva + percIva + percIibb + percOtras);
      if (f.total != null && Math.abs(r2(f.total) - total) > 0.05) {
        throw new BadRequestException(
          `La ${nombre} no cierra: neto + IVA + percepciones da ${pesos(total)} y el papel dice ${pesos(f.total)}. Revisá los importes.`,
        );
      }
      const comision = r2(f.comision);
      if (comision > neto * 0.3) {
        throw new BadRequestException(`La comisión de la ${nombre} (${pesos(comision)}) es el ${Math.round((comision / neto) * 100)} % de su neto: revisá el importe.`);
      }
      return {
        letra: f.letra, puntoVenta, numero: f.numero, fecha, cae: String(f.cae ?? '').trim().slice(0, 32),
        neto, iva, percIva, percIibb, percOtras, total, comision, nombre,
      };
    });
  }

  async cargar(proveedorId: number, dto: CargarFacturasMesDto, usuarioId: number | null) {
    const actual = mesActual();
    if (dto.mes > actual) throw new BadRequestException('Ese mes todavía no empezó.');
    const p = await this.proveedor(this.db, proveedorId);
    if (!p.facturaMensual) {
      throw new BadRequestException(`${p.nombre} no está marcado como «factura a fin de mes»: tildalo en su ficha para cargar sus facturas del mes.`);
    }
    const facturas = this.normalizar(dto, p);
    const mesTexto = nombreMes(dto.mes);

    try {
      const res = await this.db.transaction(async (tx) => {
        const entregas = await this.entregasPendientes(tx, proveedorId, dto.mes, true);
        /* Después del candado: el segundo de un doble clic espera al primero y ya lo ve. */
        const [ya] = await tx.select({ id: facturacionesMes.id }).from(facturacionesMes)
          .where(and(eq(facturacionesMes.proveedorId, p.id), eq(facturacionesMes.mes, dto.mes), eq(facturacionesMes.estado, 'activa'))).limit(1);
        if (ya) {
          throw new BadRequestException(`Las facturas de ${mesTexto} ya están cargadas. Si hay que corregirlas (o sumar una entrega), anulalas y cargalas de nuevo.`);
        }
        if (!entregas.length) {
          throw new BadRequestException(`${p.nombre} no tiene entregas de ${mesTexto} sin sus facturas.`);
        }
        /* La conciliación congela: los remitos pasan a deber desde SU fecha y la
         * comisión desde la de su factura. */
        const fechas = [...entregas.map((c: any) => new Date(c.fecha)), ...facturas.filter((f) => f.comision > 0).map((f) => f.fecha)];
        const primera = new Date(Math.min(...fechas.map((d) => d.getTime())));
        await exigirFueraDeConciliado(tx, p.id, primera, `facturar las entregas de ${mesTexto}`);

        /* El mismo papel no entra dos veces: ni como factura común ni en otro mes. */
        for (const f of facturas) {
          const [comun] = await tx.select({ id: comprobantes.id }).from(comprobantes).where(and(
            eq(comprobantes.proveedorId, p.id), inArray(comprobantes.tipo, ['factura', 'nota_debito']),
            eq(comprobantes.letra, f.letra as any), eq(comprobantes.puntoVenta, f.puntoVenta),
            eq(comprobantes.numero, f.numero), sql`${comprobantes.estado} <> 'anulado'`,
          )).limit(1);
          if (comun) throw new BadRequestException(`La ${f.nombre} ya está cargada en Compras (comprobante #${comun.id}): anulala ahí primero.`);
          const [otra] = await tx.select({ mes: facturacionesMes.mes }).from(facturacionesMesFacturas)
            .innerJoin(facturacionesMes, eq(facturacionesMes.id, facturacionesMesFacturas.facturacionId))
            .where(and(
              eq(facturacionesMesFacturas.proveedorId, p.id), eq(facturacionesMesFacturas.activa, true),
              eq(facturacionesMesFacturas.letra, f.letra as any), eq(facturacionesMesFacturas.puntoVenta, f.puntoVenta),
              eq(facturacionesMesFacturas.numero, f.numero),
            )).limit(1);
          if (otra) throw new BadRequestException(`La ${f.nombre} ya está cargada en las facturas de ${nombreMes(otra.mes)}.`);
        }

        /* La sucursal de la mayoría de las entregas (por importe): ahí van la
         * comisión y, en los filtros por sucursal, el IVA de las facturas. */
        const porSuc = new Map<number | null, number>();
        for (const c of entregas) porSuc.set(c.sucursalId, (porSuc.get(c.sucursalId) ?? 0) + Number(c.subtotalNeto));
        const sucursalId = [...porSuc].sort((a, b) => b[1] - a[1])[0][0];
        const netoEntregas = r2(entregas.reduce((a: number, c: any) => a + Number(c.subtotalNeto), 0));

        const [cab] = await tx.insert(facturacionesMes).values({
          proveedorId: p.id, mes: dto.mes, sucursalId, netoDocumentos: netoEntregas,
          observaciones: String(dto.observaciones ?? '').trim(), usuarioId,
        }).returning();

        /* LOS REMITOS PASAN A LIQUIDACIÓN: la deuda nace ahora, por su valor SIN
         * IVA (lo que se paga), desde su fecha. Producto, cantidad y precio no
         * cambian; el stock tampoco (entró con el remito). */
        const remitos = entregas.filter((c: any) => c.tipo === 'remito');
        for (const c of remitos) {
          const rastro = `Era el ${etiquetaDoc(c)}: pasó a liquidación al cargar las facturas de ${mesTexto} (se paga sin IVA; el stock no se movió).`;
          const [ok] = await tx.update(comprobantes).set({
            tipo: 'liquidacion', letra: 'X', ivaTotal: 0, percepcionesTotal: 0, total: r2(c.subtotalNeto),
            /* Sin IVA ni percepciones, lo que Coffit paga es su neto (0176). */
            finalCafeteria: c.netoCafeteria,
            condicionPago: 'cuenta_corriente', facturacionMesId: cab.id,
            cuentaFecha: Number(c.netoCafeteria) > 0 ? await fechaDeCuenta(tx, new Date(c.fecha)) : null,
            observaciones: [String(c.observaciones ?? '').trim(), rastro].filter(Boolean).join('\n'),
          }).where(and(eq(comprobantes.id, c.id), eq(comprobantes.tipo, 'remito'), eq(comprobantes.estado, 'confirmado'), isNull(comprobantes.facturacionMesId)))
            .returning({ id: comprobantes.id });
          if (!ok) throw new BadRequestException(`El ${etiquetaDoc(c)} cambió mientras se cargaba: actualizá la pantalla.`);
          await tx.update(comprobanteItems).set({ iva: 0 }).where(eq(comprobanteItems.comprobanteId, c.id));
          await tx.delete(comprobantePercepciones).where(eq(comprobantePercepciones.comprobanteId, c.id));
        }
        const liquidaciones = entregas.filter((c: any) => c.tipo === 'liquidacion').map((c: any) => c.id);
        if (liquidaciones.length) {
          const enganchadas = await tx.update(comprobantes).set({ facturacionMesId: cab.id })
            .where(and(inArray(comprobantes.id, liquidaciones), isNull(comprobantes.facturacionMesId), eq(comprobantes.estado, 'confirmado')))
            .returning({ id: comprobantes.id });
          if (enganchadas.length !== liquidaciones.length) {
            throw new BadRequestException('Alguna entrega del mes cambió mientras se cargaba: actualizá la pantalla.');
          }
        }

        /* Cada factura (solo fiscal) y, si cobra comisión, su liquidación. */
        for (const f of facturas) {
          let comisionId: number | null = null;
          if (f.comision > 0) {
            const [doc] = await tx.insert(comprobantes).values({
              tipo: 'liquidacion', letra: 'X', fecha: f.fecha, proveedorId: p.id, sucursalId,
              estado: 'confirmado', condicionPago: 'cuenta_corriente', recepcion: false,
              subtotalNeto: f.comision, ivaTotal: 0, percepcionesTotal: 0, total: f.comision,
              observaciones: `Comisión de la ${f.nombre} (facturas de ${mesTexto}). Sin factura: se paga aparte.`,
              usuarioId,
            }).returning({ id: comprobantes.id });
            comisionId = doc.id;
          }
          await tx.insert(facturacionesMesFacturas).values({
            facturacionId: cab.id, proveedorId: p.id, letra: f.letra as any, puntoVenta: f.puntoVenta, numero: f.numero,
            fecha: f.fecha, cae: f.cae, neto: f.neto, iva: f.iva, percIva: f.percIva, percIibb: f.percIibb,
            percOtras: f.percOtras, total: f.total, comision: f.comision, comisionComprobanteId: comisionId,
          });
        }

        const suma = (k: 'neto' | 'iva' | 'comision') => r2(facturas.reduce((a, f) => a + f[k], 0));
        await this.audit.registrar([{
          entidad: 'proveedor', entidadId: p.id, ambito: 'Facturas del mes', detalle: mesTexto,
          campo: 'Facturas del mes', antes: `${entregas.length} entrega(s) sin facturas por ${pesos(netoEntregas)}`,
          despues: `${facturas.length} factura(s): neto ${pesos(suma('neto'))} · IVA ${pesos(suma('iva'))} · comisión ${pesos(suma('comision'))}`
            + (remitos.length ? ` · ${remitos.length} remito(s) pasaron a liquidación` : ''),
          usuarioId,
        }], tx);
        return cab.id;
      });
      return { ok: true, id: res, ...(await this.vista(proveedorId, dto.mes)) };
    } catch (e: any) {
      const x = e?.cause ?? e;
      if (x?.code === '23505') {
        const cual = String(x?.constraint ?? x?.message ?? '');
        if (cual.includes('uq_facturaciones_mes_facturas')) throw new BadRequestException('Una de esas facturas ya está cargada en otro mes.');
        if (cual.includes('uq_facturaciones_mes')) throw new BadRequestException(`Las facturas de ${mesTexto} ya están cargadas (¿se apretó dos veces?). Actualizá la pantalla.`);
        if (cual.includes('uq_comprobantes_numero')) {
          throw new BadRequestException('Un remito del mes tiene el mismo número que una liquidación ya cargada de este proveedor: corregí el número de uno de los dos y volvé a intentar.');
        }
      }
      throw e;
    }
  }

  /**
   * ANULAR UN MES FACTURADO: lo fiscal deja de contar y la comisión se anula
   * (si no tiene pagos: la plata ya salió y hay que desaplicarla primero). Las
   * entregas siguen siendo liquidaciones —se deben igual— y vuelven a quedar
   * pendientes de sus facturas, para cargarlas bien.
   */
  async anular(id: number, motivoCrudo: string, usuarioId: number | null) {
    const motivo = String(motivoCrudo ?? '').trim();
    if (motivo.length < 3) throw new BadRequestException('Escribí el motivo de la anulación.');
    return this.db.transaction(async (tx) => {
      const [cab] = await tx.select().from(facturacionesMes).where(eq(facturacionesMes.id, id)).limit(1).for('update');
      if (!cab) throw new NotFoundException('Esas facturas del mes no existen.');
      if (cab.estado !== 'activa') throw new BadRequestException('Ya están anuladas.');
      const facturas = await tx.select().from(facturacionesMesFacturas).where(eq(facturacionesMesFacturas.facturacionId, id));
      const idsComision = facturas.map((f) => f.comisionComprobanteId).filter((x): x is number => x != null);
      const comisiones = idsComision.length
        ? await tx.select().from(comprobantes).where(inArray(comprobantes.id, idsComision)).for('update')
        : [];
      const pagadas = comisiones.filter((c) => c.estado !== 'anulado' && Number(c.pagado) > EPS);
      if (pagadas.length) {
        throw new BadRequestException(
          `La comisión ya tiene pagos aplicados (${pagadas.map((c) => `${etiquetaDoc(c)}: ${pesos(Number(c.pagado))}`).join('; ')}). `
          + 'Desaplicalos primero en Pagos (quedan a cuenta del proveedor).',
        );
      }
      const vivas = comisiones.filter((c) => c.estado !== 'anulado');
      if (vivas.length) {
        const primera = new Date(Math.min(...vivas.map((c) => new Date(c.fecha).getTime())));
        await exigirFueraDeConciliado(tx, cab.proveedorId, primera, 'anular la comisión de las facturas del mes');
      }

      await tx.update(facturacionesMes).set({ estado: 'anulada', anuladoEn: new Date(), anuladoPor: usuarioId, motivoAnulacion: motivo })
        .where(eq(facturacionesMes.id, id));
      await tx.update(facturacionesMesFacturas).set({ activa: false }).where(eq(facturacionesMesFacturas.facturacionId, id));
      const sueltas = await tx.update(comprobantes).set({ facturacionMesId: null })
        .where(eq(comprobantes.facturacionMesId, id)).returning({ id: comprobantes.id });
      if (vivas.length) {
        await tx.update(comprobantes).set({
          estado: 'anulado', anuladoEn: new Date(), anuladoPor: usuarioId,
          motivoAnulacion: `Anulación de las facturas de ${nombreMes(cab.mes)}: ${motivo}`,
        }).where(and(inArray(comprobantes.id, vivas.map((c) => c.id)), eq(comprobantes.estado, 'confirmado')));
      }
      await this.audit.registrar([{
        entidad: 'proveedor', entidadId: cab.proveedorId, ambito: 'Facturas del mes', detalle: nombreMes(cab.mes),
        campo: 'Facturas del mes', antes: `${facturas.length} factura(s) cargada(s)`,
        despues: `Anuladas: ${motivo}`, usuarioId,
      }], tx);
      return { ok: true, entregas: sueltas.length, comisionesAnuladas: vivas.length };
    });
  }
}

/* ------------------------------ Controller ------------------------------ */

@Controller('facturas-mes')
@Permiso('proveedores.edoc')
export class FacturasMesController {
  constructor(private readonly svc: FacturasMesService) {}

  @Get(':proveedorId')
  vista(@Param('proveedorId', ParseIntPipe) id: number, @Query('mes') mes?: string) {
    return this.svc.vista(id, mes);
  }

  /** Lo fiscal y la deuda del mes: solo administrador (como conciliar o anular). */
  @Post(':proveedorId') @Permiso('compras.pagos', 'gastos.pagos_proveedor')
  cargar(@Param('proveedorId', ParseIntPipe) id: number, @Body() dto: CargarFacturasMesDto, @Auth() auth: Sesion) {
    if (!esJefe(auth)) throw new ForbiddenException('Las facturas del mes las carga un administrador.');
    return this.svc.cargar(id, dto, auth.usuarioId ?? null);
  }

  @Post('anular/:id') @Permiso('compras.pagos', 'gastos.pagos_proveedor')
  anular(@Param('id', ParseIntPipe) id: number, @Body() dto: AnularFacturasMesDto, @Auth() auth: Sesion) {
    if (!esJefe(auth)) throw new ForbiddenException('Las facturas del mes las anula un administrador.');
    return this.svc.anular(id, dto.motivo, auth.usuarioId ?? null);
  }
}

@Module({
  imports: [AuditoriaModule],
  controllers: [FacturasMesController],
  providers: [FacturasMesService],
})
export class FacturasMesModule {}
