/**
 * VENTAS › CONCILIACIÓN MP — LA BAJADA Y LA PANTALLA (18/11/2026)
 * ============================================================================
 * Cada 5 minutos se bajan de Mercado Pago los pagos nuevos o cambiados (desde
 * el último que se vio, con 2 h de margen) a `mp_movimientos`, y se ata solo
 * lo seguro (`conciliacion.ts`). La pantalla pide un rango de días y recibe:
 *
 *   dias        por día: vendido electrónico, entró a MP y qué quedó pendiente
 *   faltan      cobros del ERP sin pago en Mercado Pago (lo que importa)
 *   sugeridos   cobro + pago candidato, para confirmar con un clic
 *   sinVenta    plata que entró a Mercado Pago sin cobro en el ERP
 *   avisos      atados cuyo pago se devolvió o reclamó, o cuya venta se anuló
 *   conciliados (solo si se piden) lo que ya está atado o explicado
 *
 * La comisión y el neto de Mercado Pago solo los ve un jefe.
 */
import { BadRequestException, Body, Controller, Delete, Get, Inject, Injectable, Logger, NotFoundException,
  OnModuleDestroy, OnModuleInit, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { type SQL, and, eq, getTableColumns, inArray, isNull, sql } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import { Auth, Permiso, type Sesion } from '../auth/auth.decoradores';
import { esJefe } from '../auth/auth.guard';
import { mpCajas, mpConciliacionErp, mpConciliaciones, mpMovimientos, mpSucursales } from '../db/schema';
import { ZONA } from '../metricas/sincronizar';
import { MP, mp } from './api';
import { FAMILIA_DE_MEDIO, MEDIOS_ELECTRONICOS, atarSolos, movimientoDe, seGuarda, sugerir, type CobroErp, type PagoMp } from './conciliacion';

export const PERMISO_CONCILIACION = 'ventas.conciliacion_mp';
/** Desde cuándo se concilia (decisión del dueño, 18/11/2026). Lo anterior no se baja ni se muestra. */
const ARRANQUE = '2026-11-01';
const CADA = 5 * 60_000;
const DIA = 86_400_000;
const EPS = 0.01;

/** Fecha y hora en Argentina como la acepta la búsqueda de Mercado Pago (Argentina no tiene horario de verano). */
const isoAr = (d: Date) => `${new Date(d.getTime() - 3 * 3_600_000).toISOString().slice(0, 23)}-03:00`;
const desdeDia = (dia: string) => new Date(`${dia}T00:00:00-03:00`);
const sumaDias = (dia: string, n: number) => new Date(desdeDia(dia).getTime() + n * DIA).toLocaleDateString('en-CA', { timeZone: ZONA });
const valido = (dia: unknown) => typeof dia === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dia) && !Number.isNaN(desdeDia(dia).getTime());
const r2 = (x: number) => Math.round(x * 100) / 100;
const COLUMNAS = getTableColumns(mpMovimientos);

/** Un cobro del ERP para la pantalla. `clave`: «v» + renglón de pago de venta, «r» + renglón de pago de recibo. */
type FilaErp = {
  clave: string; origen: 'venta' | 'recibo'; docId: number; fecha: Date; dia: string; importe: number; medio: string; referencia: string;
  sucursalId: number | null; sucursal: string; tipoDoc: string; puntoVenta: string; numero: number | null; cliente: string;
  cajero: string; turno: number | null; vigente: boolean; conciliacionId: number | null;
};

const familia = (medio: string) => FAMILIA_DE_MEDIO[medio];
const mpIdDe = (referencia: string) => /^MP (\d+)$/.exec(referencia)?.[1] ?? null;
const aCobro = (f: FilaErp): CobroErp => ({ clave: f.clave, fecha: f.fecha, importe: f.importe, familia: familia(f.medio), sucursalId: f.sucursalId, mpId: mpIdDe(f.referencia) });
const aPago = (m: typeof mpMovimientos.$inferSelect): PagoMp => ({ id: m.id, fecha: m.fecha, bruto: m.bruto, familia: m.familia, sucursalId: m.sucursalId });

@Injectable()
export class ConciliacionMpService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('ConciliacionMp');
  private reloj: ReturnType<typeof setInterval> | null = null;
  private bajando: Promise<void> | null = null;
  private cuentaId: number | null = null;
  /** Cómo salió la última bajada (la pantalla la muestra). */
  private ultima: { en: string; nuevos: number; atados: number; error: string } | null = null;

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test' || process.env.MP_RELOJ === '0') return;
    /* La primera, al minuto de arrancar (después de un deploy la pantalla no espera 5 minutos). */
    setTimeout(() => { void this.actualizar(); }, 60_000).unref();
    this.reloj = setInterval(() => { void this.actualizar(); }, CADA);
    this.reloj.unref();
  }

  onModuleDestroy() { if (this.reloj) clearInterval(this.reloj); }

  /** Baja y ata. Si ya hay una bajada en curso, espera esa (nunca dos a la vez). */
  async actualizar() {
    if (MP.configurado) {
      this.bajando ??= this.bajarYAtar()
        .catch((e) => {
          this.ultima = { en: new Date().toISOString(), nuevos: 0, atados: 0, error: (e as Error).message };
          this.log.warn(`bajada: ${(e as Error).message}`);
        })
        .finally(() => { this.bajando = null; });
      await this.bajando;
    }
    return this.estado();
  }

  private estado() {
    return { configurado: MP.configurado, arranque: ARRANQUE, ultima: this.ultima };
  }

  /* ------------------------------ la bajada ------------------------------ */

  private async bajarYAtar() {
    this.cuentaId ??= Number((await mp.yo()).id);
    const [{ ultimo }] = await this.db.select({ ultimo: sql<Date | null>`max(${mpMovimientos.actualizadoMp})` }).from(mpMovimientos);
    let desde = ultimo ? new Date(new Date(ultimo).getTime() - 2 * 3_600_000) : desdeDia(ARRANQUE);
    const [cajas, sucs] = await Promise.all([
      this.db.select({ pos: mpCajas.mpPosId, sucursalId: mpCajas.sucursalId }).from(mpCajas),
      this.db.select({ store: mpSucursales.mpStoreId, sucursalId: mpSucursales.sucursalId }).from(mpSucursales),
    ]);
    const porPos = new Map(cajas.filter((c) => c.pos).map((c) => [c.pos, c.sucursalId]));
    const porStore = new Map(sucs.map((s) => [s.store, s.sucursalId]));
    const sucursalDe = (pos: string, store: string) => porPos.get(pos) ?? porStore.get(store) ?? null;

    let nuevos = 0;
    let offset = 0;
    /* Mercado Pago no deja pasar del renglón 10.000: al llegar, se sigue desde la fecha del último visto. */
    for (let pagina = 0; pagina < 400; pagina++) {
      const r: any = await mp.buscarPagos({
        sort: 'date_last_updated', criteria: 'asc', range: 'date_last_updated',
        begin_date: isoAr(desde), end_date: isoAr(new Date()), limit: '50', offset: String(offset),
      });
      const lote: any[] = Array.isArray(r?.results) ? r.results : [];
      const filas = lote.filter((p) => seGuarda(p, this.cuentaId!)).map((p) => movimientoDe(p, sucursalDe));
      if (filas.length) {
        /* Lo que dice Mercado Pago se pisa; el atado (`conciliacion_id`, `a_mano`) no se toca. */
        await this.db.insert(mpMovimientos).values(filas).onConflictDoUpdate({
          target: mpMovimientos.id,
          set: Object.fromEntries(Object.keys(filas[0]).filter((k) => k !== 'id').map((k) => [k, sql.raw(`excluded.${COLUMNAS[k as keyof typeof COLUMNAS].name}`)])),
        });
        nuevos += filas.length;
      }
      if (lote.length < 50) break;
      offset += 50;
      if (offset >= 9_950) { desde = new Date(lote[lote.length - 1].date_last_updated); offset = 0; }
    }
    const atados = await this.atar();
    this.ultima = { en: new Date().toISOString(), nuevos, atados, error: '' };
  }

  /** Limpia atados que perdieron un lado (se borró el pago del ERP) y ata solo lo seguro de los últimos 45 días. */
  private async atar(): Promise<number> {
    await this.db.execute(sql`
      delete from mp_conciliaciones c
      where (c.tipo in ('auto', 'manual', 'sin_mp') and not exists (select 1 from mp_conciliacion_erp e where e.conciliacion_id = c.id))
         or (c.tipo in ('auto', 'manual', 'sin_venta') and not exists (select 1 from mp_movimientos m where m.conciliacion_id = c.id))`);
    const desde = [ARRANQUE, new Date(Date.now() - 45 * DIA).toLocaleDateString('en-CA', { timeZone: ZONA })].sort()[1];
    const hasta = sumaDias(new Date().toLocaleDateString('en-CA', { timeZone: ZONA }), 1);
    const [cobros, pagos] = await Promise.all([
      this.cobrosErp(sql`v.fecha >= ${desdeDia(desde)} and v.fecha < ${desdeDia(hasta)}`, sql`c.fecha >= ${desdeDia(desde)} and c.fecha < ${desdeDia(hasta)}`),
      this.db.select().from(mpMovimientos).where(and(
        isNull(mpMovimientos.conciliacionId), eq(mpMovimientos.aMano, false), eq(mpMovimientos.estado, 'approved'),
        sql`${mpMovimientos.fecha} >= ${desdeDia(sumaDias(desde, -3))}`,
      )),
    ]);
    const pares = atarSolos(cobros.filter((c) => c.vigente && !c.conciliacionId).map(aCobro), pagos.map(aPago));
    let atados = 0;
    for (const p of pares) {
      try {
        await this.db.transaction(async (tx) => {
          const [c] = await tx.insert(mpConciliaciones).values({ tipo: 'auto' }).returning({ id: mpConciliaciones.id });
          await this.unir(tx, c.id, [p.clave], [p.mpId]);
        });
        atados++;
      } catch (e) {
        /* Alguien lo ató a mano en el medio: se deja como está. */
        this.log.debug(`atado automático ${p.clave}=${p.mpId}: ${(e as Error).message}`);
      }
    }
    return atados;
  }

  /** Mete cobros y pagos en el atado `id`. Falla si alguno ya estaba atado (la transacción se deshace entera). */
  private async unir(tx: any, id: number, claves: string[], pagos: string[]) {
    if (claves.length) {
      await tx.insert(mpConciliacionErp).values(claves.map((k) => (k.startsWith('v')
        ? { conciliacionId: id, ventaPagoId: Number(k.slice(1)) }
        : { conciliacionId: id, cobranzaPagoId: Number(k.slice(1)) })));
    }
    if (pagos.length) {
      const hechos = await tx.update(mpMovimientos).set({ conciliacionId: id })
        .where(and(inArray(mpMovimientos.id, pagos), isNull(mpMovimientos.conciliacionId))).returning({ id: mpMovimientos.id });
      if (hechos.length !== pagos.length) throw new BadRequestException('Alguno de esos pagos de Mercado Pago ya está atado o no existe: actualizá la pantalla.');
    }
  }

  /* ----------------------------- las consultas ----------------------------- */

  /** Los cobros electrónicos del ERP (ventas y recibos) que cumplen los filtros dados. */
  private async cobrosErp(filtroVenta: SQL, filtroRecibo: SQL): Promise<FilaErp[]> {
    const medios = sql.join(MEDIOS_ELECTRONICOS.map((m) => sql`${m}`), sql`, `);
    const r: any = await this.db.execute(sql`
      select 'v' || vp.id as clave, 'venta' as origen, v.id as doc_id, v.fecha, to_char(v.fecha at time zone ${ZONA}, 'YYYY-MM-DD') as dia,
        vp.importe, vp.medio::text as medio, vp.referencia, v.sucursal_id, s.nombre as sucursal, v.tipo::text as tipo_doc,
        v.punto_venta, v.numero, cl.nombre as cliente, u.nombre as cajero, v.caja_sesion_id as turno,
        v.estado in ('confirmada', 'pendiente_cae') as vigente, ce.conciliacion_id
      from venta_pagos vp
      join ventas v on v.id = vp.venta_id
      left join sucursales s on s.id = v.sucursal_id
      left join clientes cl on cl.id = v.cliente_id
      left join usuarios u on u.id = coalesce(v.cobrado_por, v.usuario_id)
      left join mp_conciliacion_erp ce on ce.venta_pago_id = vp.id
      where vp.medio::text in (${medios}) and v.estado <> 'borrador' and v.tipo::text not like 'nota_credito%' and ${filtroVenta}
      union all
      select 'r' || cp.id, 'recibo', c.id, c.fecha, to_char(c.fecha at time zone ${ZONA}, 'YYYY-MM-DD'),
        cp.importe, cp.medio::text, cp.referencia, c.sucursal_id, s.nombre, 'recibo',
        c.punto_venta, c.numero, cl.nombre, u.nombre, c.caja_sesion_id,
        c.estado = 'confirmada', ce.conciliacion_id
      from cobranza_pagos cp
      join cobranzas c on c.id = cp.cobranza_id
      left join sucursales s on s.id = c.sucursal_id
      left join clientes cl on cl.id = c.cliente_id
      left join usuarios u on u.id = c.usuario_id
      left join mp_conciliacion_erp ce on ce.cobranza_pago_id = cp.id
      where cp.medio::text in (${medios}) and ${filtroRecibo}
      order by fecha`);
    return (r.rows as any[]).map((x) => ({
      clave: x.clave, origen: x.origen, docId: Number(x.doc_id), fecha: new Date(x.fecha), dia: x.dia, importe: Number(x.importe),
      medio: x.medio, referencia: x.referencia ?? '', sucursalId: x.sucursal_id == null ? null : Number(x.sucursal_id), sucursal: x.sucursal ?? '',
      tipoDoc: x.tipo_doc, puntoVenta: x.punto_venta ?? '', numero: x.numero == null ? null : Number(x.numero), cliente: x.cliente ?? '',
      cajero: x.cajero ?? '', turno: x.turno == null ? null : Number(x.turno), vigente: !!x.vigente,
      conciliacionId: x.conciliacion_id == null ? null : Number(x.conciliacion_id),
    }));
  }

  /** Los pagos de Mercado Pago de un rango, o de ciertos atados. */
  private pagosMp(cond: SQL) {
    return this.db.select({ m: mpMovimientos, dia: sql<string>`to_char(${mpMovimientos.fecha} at time zone ${ZONA}, 'YYYY-MM-DD')` })
      .from(mpMovimientos).where(cond).orderBy(mpMovimientos.fecha);
  }

  /**
   * LA PANTALLA: el rango `desde`..`hasta` (días en Argentina, hasta 62).
   * `conciliados`: también la lista de lo ya atado (para un día; en un mes son miles).
   */
  async ver(q: { desde?: string; hasta?: string; conciliados?: string }, sesion: Sesion) {
    const { desde, hasta } = q;
    if (!valido(desde) || !valido(hasta) || desde! > hasta!) throw new BadRequestException('Elegí un rango de días válido.');
    if (desdeDia(hasta!).getTime() - desdeDia(desde!).getTime() > 62 * DIA) throw new BadRequestException('Elegí hasta dos meses.');
    const ini = [desde!, ARRANQUE].sort()[1];
    const fin = sumaDias(hasta!, 1);
    const enRango = (col: string) => sql`${sql.raw(col)} >= ${desdeDia(ini)} and ${sql.raw(col)} < ${desdeDia(fin)}`;

    const [cobros, pagosRango, pagosCerca] = await Promise.all([
      this.cobrosErp(enRango('v.fecha'), enRango('c.fecha')),
      this.pagosMp(sql`${mpMovimientos.fecha} >= ${desdeDia(ini)} and ${mpMovimientos.fecha} < ${desdeDia(fin)}`),
      /* Los sueltos de alrededor, para sugerir (una transferencia llega días antes). */
      this.pagosMp(sql`${mpMovimientos.conciliacionId} is null and ${mpMovimientos.estado} = 'approved'
        and ${mpMovimientos.fecha} >= ${desdeDia(sumaDias(ini, -3))} and ${mpMovimientos.fecha} < ${desdeDia(sumaDias(fin, 1))}`),
    ]);
    const pagos = pagosRango.map((x) => ({ ...x.m, dia: x.dia }));

    /* Los atados de lo que se ve, con su otro lado aunque sea de otro día. */
    const idsConc = [...new Set([...cobros.map((c) => c.conciliacionId), ...pagos.map((p) => p.conciliacionId)].filter((x): x is number => x != null))];
    const [concs, cobrosDeConc, pagosDeConc] = idsConc.length ? await Promise.all([
      this.db.execute(sql`select c.id, c.tipo, c.motivo, c.creado_en, u.nombre as usuario from mp_conciliaciones c
        left join usuarios u on u.id = c.usuario_id where c.id in (${sql.join(idsConc.map((i) => sql`${i}`), sql`, `)})`),
      this.cobrosErp(sql`ce.conciliacion_id in (${sql.join(idsConc.map((i) => sql`${i}`), sql`, `)})`, sql`ce.conciliacion_id in (${sql.join(idsConc.map((i) => sql`${i}`), sql`, `)})`),
      this.pagosMp(inArray(mpMovimientos.conciliacionId, idsConc)),
    ]) : [{ rows: [] } as any, [] as FilaErp[], [] as { m: typeof mpMovimientos.$inferSelect; dia: string }[]];

    const jefe = esJefe(sesion);
    const verPago = (m: typeof mpMovimientos.$inferSelect & { dia?: string }) => ({
      id: m.id, fecha: m.fecha, dia: m.dia ?? m.fecha.toLocaleDateString('en-CA', { timeZone: ZONA }), estado: m.estado, familia: m.familia,
      tipo: m.tipo, metodo: m.metodo, operacion: m.operacion, cuotas: m.cuotas, bruto: m.bruto, devuelto: m.devuelto,
      sucursalId: m.sucursalId, pagador: m.pagador, ...(jefe ? { comision: m.comision, neto: m.neto } : {}),
    });

    /* Lo suelto de cada lado y las sugerencias. */
    const sueltosErp = cobros.filter((c) => c.vigente && !c.conciliacionId);
    const sueltosMp = new Map(pagosCerca.map((x) => [x.m.id, { ...x.m, dia: x.dia }]));
    const sugs = sugerir(sueltosErp.map(aCobro), [...sueltosMp.values()].map(aPago));
    const sugCobro = new Set(sugs.map((s) => s.clave));
    const sugPago = new Set(sugs.map((s) => s.mpId));
    const porClave = new Map(cobros.map((c) => [c.clave, c]));

    const faltan = sueltosErp.filter((c) => !sugCobro.has(c.clave));
    const sinVenta = pagos.filter((p) => !p.conciliacionId && p.estado === 'approved' && !sugPago.has(p.id));
    const sugeridos = sugs.map((s) => ({ motivo: s.motivo, cobro: porClave.get(s.clave)!, pago: verPago(sueltosMp.get(s.mpId)!) }));

    /* Los atados, agrupados, y los avisos: plata devuelta o reclamada, o venta anulada con la plata en Mercado Pago. */
    const grupos = new Map<number, { id: number; tipo: string; motivo: string; usuario: string; creadoEn: Date; cobros: FilaErp[]; pagos: ReturnType<typeof verPago>[] }>();
    for (const c of (concs as any).rows as any[]) {
      grupos.set(Number(c.id), { id: Number(c.id), tipo: c.tipo, motivo: c.motivo, usuario: c.usuario ?? '', creadoEn: c.creado_en, cobros: [], pagos: [] });
    }
    for (const c of cobrosDeConc) grupos.get(c.conciliacionId!)?.cobros.push(c);
    for (const x of pagosDeConc) grupos.get(x.m.conciliacionId!)?.pagos.push(verPago({ ...x.m, dia: x.dia }));
    const avisos = [...grupos.values()].flatMap((g) => {
      const motivos = [
        g.pagos.some((p) => p.estado !== 'approved' || p.devuelto > EPS) ? 'Mercado Pago devolvió o tiene reclamado el pago' : null,
        g.cobros.some((c) => !c.vigente) && g.pagos.some((p) => p.estado === 'approved') ? 'La venta o el recibo se anuló y la plata sigue en Mercado Pago' : null,
      ].filter(Boolean) as string[];
      return motivos.length ? [{ ...g, avisos: motivos }] : [];
    });

    /* Por día: lo vendido, lo que entró y cuánto quedó pendiente. */
    const dias = new Map<string, { dia: string; vendido: number; confirmado: number; entro: number; faltan: number; sugeridos: number; sinVenta: number; avisos: number }>();
    const delDia = (dia: string) => {
      let d = dias.get(dia);
      if (!d) { d = { dia, vendido: 0, confirmado: 0, entro: 0, faltan: 0, sugeridos: 0, sinVenta: 0, avisos: 0 }; dias.set(dia, d); }
      return d;
    };
    for (const c of cobros) {
      if (!c.vigente) continue;
      const d = delDia(c.dia);
      d.vendido += c.importe;
      if (c.conciliacionId && grupos.get(c.conciliacionId)?.tipo !== 'sin_mp') d.confirmado += c.importe;
    }
    for (const p of pagos) if (p.estado === 'approved') delDia(p.dia).entro += p.bruto;
    for (const c of faltan) delDia(c.dia).faltan += c.importe;
    for (const s of sugeridos) delDia(s.cobro.dia).sugeridos++;
    for (const p of sinVenta) delDia(p.dia).sinVenta += p.bruto;
    for (const a of avisos) {
      const dia = a.pagos[0]?.dia ?? a.cobros[0]?.dia;
      if (dia && dia >= ini && dia < fin) delDia(dia).avisos++;
    }

    /* Por sucursal y por medio: lo vendido y cuánto de eso ya confirmó Mercado Pago. */
    const abrir = <K extends string | number>(m: Map<K, any>, k: K, base: object) => { if (!m.has(k)) m.set(k, { ...base, vendido: 0, confirmado: 0 }); return m.get(k); };
    const porSucursal = new Map<string, any>();
    const porMedio = new Map<string, any>();
    for (const c of cobros) {
      if (!c.vigente) continue;
      const confirmado = c.conciliacionId && grupos.get(c.conciliacionId)?.tipo !== 'sin_mp' ? c.importe : 0;
      for (const g of [abrir(porSucursal, c.sucursal || '—', { sucursal: c.sucursal || '—' }), abrir(porMedio, familia(c.medio), { familia: familia(c.medio) })]) {
        g.vendido += c.importe; g.confirmado += confirmado;
      }
    }
    const redondear = (o: any) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? r2(v) : v]));
    const aprobados = pagos.filter((p) => p.estado === 'approved');

    return {
      ...this.estado(),
      desde: ini,
      hasta: hasta!,
      resumen: redondear({
        vendido: cobros.filter((c) => c.vigente).reduce((a, c) => a + c.importe, 0),
        entro: aprobados.reduce((a, p) => a + p.bruto, 0),
        faltan: faltan.reduce((a, c) => a + c.importe, 0),
        sinVenta: sinVenta.reduce((a, p) => a + p.bruto, 0),
        ...(jefe ? { comision: aprobados.reduce((a, p) => a + p.comision, 0), neto: aprobados.reduce((a, p) => a + p.neto, 0) } : {}),
      }),
      dias: [...dias.values()].sort((a, b) => a.dia.localeCompare(b.dia)).map(redondear),
      porSucursal: [...porSucursal.values()].map(redondear),
      porMedio: [...porMedio.values()].map(redondear),
      faltan,
      sugeridos,
      sinVenta: sinVenta.map(verPago),
      avisos,
      conciliados: q.conciliados === '1' ? [...grupos.values()] : null,
    };
  }

  /** Lo suelto de los dos lados en un rango corto: para atar a mano. */
  async sueltos(q: { desde?: string; hasta?: string }) {
    const { desde, hasta } = q;
    if (!valido(desde) || !valido(hasta) || desde! > hasta! || desdeDia(hasta!).getTime() - desdeDia(desde!).getTime() > 7 * DIA) {
      throw new BadRequestException('Elegí hasta una semana.');
    }
    const fin = desdeDia(sumaDias(hasta!, 1));
    const [cobros, pagos] = await Promise.all([
      this.cobrosErp(sql`v.fecha >= ${desdeDia(desde!)} and v.fecha < ${fin}`, sql`c.fecha >= ${desdeDia(desde!)} and c.fecha < ${fin}`),
      this.pagosMp(sql`${mpMovimientos.conciliacionId} is null and ${mpMovimientos.fecha} >= ${desdeDia(desde!)} and ${mpMovimientos.fecha} < ${fin}`),
    ]);
    return {
      cobros: cobros.filter((c) => c.vigente && !c.conciliacionId),
      pagos: pagos.map((x) => ({ id: x.m.id, fecha: x.m.fecha, dia: x.dia, estado: x.m.estado, familia: x.m.familia, tipo: x.m.tipo, bruto: x.m.bruto, pagador: x.m.pagador, sucursalId: x.m.sucursalId })),
    };
  }

  /* ------------------------------ las acciones ------------------------------ */

  /**
   * Atar a mano: cobros del ERP con pagos de Mercado Pago (uno o varios de
   * cada lado), o explicar lo que queda de un solo lado: `sin_venta` (entró
   * plata que no es una venta) o `sin_mp` (el cobro no entró a Mercado Pago).
   * Si los dos lados no suman lo mismo, hace falta decir por qué.
   */
  async atarAMano(dto: { cobros?: string[]; pagos?: string[]; motivo?: string }, sesion: Sesion) {
    const claves = [...new Set((dto.cobros ?? []).map(String))];
    const pagos = [...new Set((dto.pagos ?? []).map(String))];
    const motivo = String(dto.motivo ?? '').trim().slice(0, 200);
    if (claves.some((k) => !/^[vr]\d+$/.test(k))) throw new BadRequestException('Algún cobro no es válido.');
    if (!claves.length && !pagos.length) throw new BadRequestException('Elegí qué atar.');
    const tipo = claves.length && pagos.length ? 'manual' : claves.length ? 'sin_mp' : 'sin_venta';
    if (tipo !== 'manual' && !motivo) throw new BadRequestException(tipo === 'sin_mp' ? 'Decí por qué no entró a Mercado Pago.' : 'Decí qué es esa plata.');
    if (tipo === 'manual') {
      const filas = await this.cobrosErp(
        sql`vp.id in (${sql.join([0, ...claves.filter((k) => k[0] === 'v').map((k) => Number(k.slice(1)))].map((i) => sql`${i}`), sql`, `)})`,
        sql`cp.id in (${sql.join([0, ...claves.filter((k) => k[0] === 'r').map((k) => Number(k.slice(1)))].map((i) => sql`${i}`), sql`, `)})`,
      );
      const enMp = await this.db.select({ bruto: mpMovimientos.bruto }).from(mpMovimientos).where(inArray(mpMovimientos.id, pagos));
      if (filas.length !== claves.length || enMp.length !== pagos.length) throw new BadRequestException('Alguno de los elegidos ya no existe: actualizá la pantalla.');
      const dif = r2(filas.reduce((a, f) => a + f.importe, 0) - enMp.reduce((a, p) => a + p.bruto, 0));
      if (Math.abs(dif) > EPS && !motivo) throw new BadRequestException(`Los dos lados no suman lo mismo (diferencia $${dif.toFixed(2)}): decí por qué.`);
    }
    try {
      return await this.db.transaction(async (tx) => {
        const [c] = await tx.insert(mpConciliaciones).values({ tipo, motivo, usuarioId: sesion.usuarioId }).returning({ id: mpConciliaciones.id });
        await this.unir(tx, c.id, claves, pagos);
        return { id: c.id };
      });
    } catch (e: any) {
      if (e?.code === '23505' || e?.cause?.code === '23505') throw new BadRequestException('Alguno de esos cobros ya está atado: actualizá la pantalla.');
      throw e;
    }
  }

  /** Deshacer un atado. Sus pagos quedan «a mano»: el automático no los vuelve a atar. */
  async deshacer(id: number) {
    return this.db.transaction(async (tx) => {
      await tx.update(mpMovimientos).set({ aMano: true }).where(eq(mpMovimientos.conciliacionId, id));
      const borrados = await tx.delete(mpConciliaciones).where(eq(mpConciliaciones.id, id)).returning({ id: mpConciliaciones.id });
      if (!borrados.length) throw new NotFoundException('Ese atado ya no existe.');
      return { ok: true };
    });
  }
}

@Controller('mercadopago/conciliacion')
export class ConciliacionMpController {
  constructor(private readonly svc: ConciliacionMpService) {}

  @Get() @Permiso(PERMISO_CONCILIACION)
  ver(@Query() q: { desde?: string; hasta?: string; conciliados?: string }, @Auth() sesion: Sesion) { return this.svc.ver(q, sesion); }

  @Get('sueltos') @Permiso(PERMISO_CONCILIACION)
  sueltos(@Query() q: { desde?: string; hasta?: string }) { return this.svc.sueltos(q); }

  /** Bajar ya lo nuevo de Mercado Pago (además del reloj de cada 5 minutos). */
  @Post('actualizar') @Permiso(PERMISO_CONCILIACION)
  actualizar() { return this.svc.actualizar(); }

  @Post() @Permiso(PERMISO_CONCILIACION)
  atar(@Body() body: { cobros?: string[]; pagos?: string[]; motivo?: string }, @Auth() sesion: Sesion) { return this.svc.atarAMano(body ?? {}, sesion); }

  @Delete(':id') @Permiso(PERMISO_CONCILIACION)
  deshacer(@Param('id', ParseIntPipe) id: number) { return this.svc.deshacer(id); }
}
