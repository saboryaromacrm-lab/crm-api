/**
 * VENTAS › CONCILIACIÓN MP — LA BAJADA Y LA PANTALLA (18/11/2026)
 * ============================================================================
 * Se bajan los pagos de Mercado Pago a `mp_movimientos` y se ata solo lo
 * seguro (`conciliacion.ts`). La bajada pide por fecha de creación en tramos
 * de 2 DÍAS que avanzan de a uno (cada día entra en dos tramos, redondee como
 * redondee Mercado Pago los «NOW-xDAYS»): cada 5 minutos un tramo (los últimos
 * 2 días, la misma consulta que el diagnóstico), y al arrancar y una vez por
 * día 35 tramos (lo que faltó, devoluciones y contracargos tardíos). Pedirlo
 * todo junto por fecha de modificación dejó días a medias, y los tramos de un
 * día dejaron huecos de mañana (producción, 18/11/2026).
 *
 * SOLO LO QUE COBRÓ LA CUENTA: la búsqueda trae también lo que la cuenta PAGA
 * (compras con la tarjeta de débito de Mercado Pago, servicios, débitos
 * automáticos) y esos pagos no siempre dicen quién cobró. Se le pide a Mercado
 * Pago que filtre por cobrador (`collector.id`), y el barrido borra lo que se
 * había guardado y ya no vuelve (si no está atado).
 * La pantalla pide un rango de días y recibe:
 *
 *   dias        por día: vendido electrónico, entró a MP y qué quedó pendiente
 *   faltan      cobros del ERP sin pago en Mercado Pago (lo que importa)
 *   sugeridos   cobro + pago candidato, para confirmar con un clic
 *   sinVenta    plata que entró a Mercado Pago sin cobro en el ERP
 *   avisos      atados cuyo pago se devolvió o reclamó, o cuya venta se anuló
 *   conciliados (solo si se piden) lo que ya está atado o explicado
 *
 * La comisión y el neto de Mercado Pago solo los ve un jefe. Quien no es jefe
 * ve y opera solo lo de su local.
 *
 * EL MEDIO DE LA VENTA (18/11/2026): un cobro atado a UN pago, por el MISMO
 * importe, puede tomar el medio que dice Mercado Pago (`medioReal`; si no lo
 * dice sin dudas, no se toca). Cada cambio y cada vuelta atrás quedan en
 * Auditoría (quién, cuándo, antes → después).
 */
import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Inject, Injectable, Logger, NotFoundException,
  OnModuleDestroy, OnModuleInit, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { type SQL, and, eq, getTableColumns, inArray, isNull, sql } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import { Auth, Permiso, type Sesion } from '../auth/auth.decoradores';
import { esJefe } from '../auth/auth.guard';
import { auditoria, cobranzaPagos, mpCajas, mpConciliacionErp, mpConciliaciones, mpMovimientos, mpSucursales, ventaPagos } from '../db/schema';
import { ZONA } from '../metricas/sincronizar';
import { ErrorMp, MP, mp } from './api';
import { FAMILIA_DE_MEDIO, MEDIOS_ELECTRONICOS, atarSolos, medioReal, movimientoDe, seGuarda, sugerir, type CobroErp, type Familia, type PagoMp } from './conciliacion';

export const PERMISO_CONCILIACION = 'ventas.conciliacion_mp';
/** Desde cuándo se concilia (decisión del dueño, 18/11/2026). Lo anterior no se baja ni se muestra. */
const ARRANQUE = '2026-11-01';
const CADA = 5 * 60_000;
const DIA = 86_400_000;
const EPS = 0.01;
/** Cuántos días hacia atrás mira el barrido largo (al arrancar y una vez por día). */
const DIAS_BARRIDO = 35;
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
  /** El medio que tenía antes de que la conciliación lo corrigiera (0233). */
  medioAnterior: string | null;
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
  /** Cuándo terminó el último barrido largo (0 = todavía no: el primero va al arrancar). */
  private ultimoBarrido = 0;

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
    const [cajas, sucs] = await Promise.all([
      this.db.select({ pos: mpCajas.mpPosId, sucursalId: mpCajas.sucursalId }).from(mpCajas),
      this.db.select({ store: mpSucursales.mpStoreId, sucursalId: mpSucursales.sucursalId }).from(mpSucursales),
    ]);
    const porPos = new Map(cajas.filter((c) => c.pos).map((c) => [c.pos, c.sucursalId]));
    const porStore = new Map(sucs.map((s) => [s.store, s.sucursalId]));
    const sucursalDe = (pos: string, store: string) => porPos.get(pos) ?? porStore.get(store) ?? null;

    const barrido = Date.now() - this.ultimoBarrido > 20 * 3_600_000;
    const desdeArranque = Math.ceil((Date.now() - desdeDia(ARRANQUE).getTime()) / DIA);
    const tramos = barrido ? Math.max(1, Math.min(DIAS_BARRIDO, desdeArranque)) : 1;
    let nuevos = 0;
    const vistos = new Set<string>();
    for (let k = 0; k < tramos; k++) nuevos += await this.bajarVentana(`NOW-${k + 2}DAYS`, k ? `NOW-${k}DAYS` : 'NOW', sucursalDe, vistos);
    if (barrido) {
      await this.borrarQueNoVolvieron(tramos, vistos);
      this.ultimoBarrido = Date.now();
    }
    const atados = await this.atar();
    this.ultima = { en: new Date().toISOString(), nuevos, atados, error: '' };
  }

  /** Los pagos creados en un tramo (2 días: unas 6 páginas de 50), guardados. Lo que dice Mercado Pago se pisa; el atado no se toca. */
  private async bajarVentana(desde: string, hasta: string, sucursalDe: (pos: string, store: string) => number | null, vistos: Set<string>) {
    let guardados = 0;
    for (let offset = 0; offset < 10_000; offset += 50) {
      const r: any = await mp.buscarPagos({
        sort: 'date_created', criteria: 'desc', range: 'date_created', 'collector.id': String(this.cuentaId),
        begin_date: desde, end_date: hasta, limit: '50', offset: String(offset),
      });
      const lote: any[] = Array.isArray(r?.results) ? r.results : [];
      for (const p of lote) vistos.add(String(p.id));
      const filas = lote.filter((p) => seGuarda(p, this.cuentaId!)).map((p) => movimientoDe(p, sucursalDe));
      if (filas.length) {
        await this.db.insert(mpMovimientos).values(filas).onConflictDoUpdate({
          target: mpMovimientos.id,
          set: Object.fromEntries(Object.keys(filas[0]).filter((k) => k !== 'id').map((k) => [k, sql.raw(`excluded.${COLUMNAS[k as keyof typeof COLUMNAS].name}`)])),
        });
        guardados += filas.length;
      }
      if (lote.length < 50) break;
    }
    return guardados;
  }

  /**
   * Lo guardado que el barrido ya no trajo. La búsqueda de Mercado Pago pagina
   * de forma inestable (puede saltear un pago en una pasada), así que no
   * alcanza con «no vino»: se le pregunta a Mercado Pago por ESE pago y se
   * borra solo si confirma que no lo cobró esta cuenta (o que no existe). Si
   * estaba atado (pasó antes del filtro por cobrador), primero se deshace el
   * atado y queda en Auditoría. Ante cualquier duda, se deja.
   */
  private async borrarQueNoVolvieron(dias: number, vistos: Set<string>) {
    const desde = new Date(Date.now() - (dias - 1) * DIA);
    const hasta = new Date(Date.now() - 3_600_000);
    const guardados = await this.db.select({ id: mpMovimientos.id, conciliacionId: mpMovimientos.conciliacionId })
      .from(mpMovimientos).where(sql`${mpMovimientos.fecha} >= ${desde} and ${mpMovimientos.fecha} < ${hasta}`);
    for (const g of guardados.filter((x) => !vistos.has(x.id)).slice(0, 300)) {
      let esDeLaCuenta = true;
      try {
        const p: any = await mp.pago(g.id);
        const cobrador = p?.collector_id ?? p?.collector?.id;
        esDeLaCuenta = cobrador != null && Number(cobrador) === this.cuentaId && seGuarda(p, this.cuentaId!);
      } catch (e) {
        esDeLaCuenta = !(e instanceof ErrorMp && (e.status === 403 || e.status === 404));
      }
      if (esDeLaCuenta) continue;
      await this.db.transaction(async (tx) => {
        if (g.conciliacionId) await this.deshacerEn(tx, g.conciliacionId, null, 'no lo cobró esta cuenta (lo confirmó Mercado Pago)');
        await tx.delete(mpMovimientos).where(eq(mpMovimientos.id, g.id));
      });
    }
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
          await this.unir(tx, c.id, [p.clave], [p.mpId], true);
        });
        atados++;
      } catch (e) {
        /* Alguien lo ató a mano en el medio: se deja como está. */
        this.log.debug(`atado automático ${p.clave}=${p.mpId}: ${(e as Error).message}`);
      }
    }
    return atados;
  }

  /**
   * Mete cobros y pagos en el atado `id`. Falla si alguno ya estaba atado (la
   * transacción se deshace entera). `auto`: además, el pago no puede estar «a
   * mano» (alguien deshizo su atado mientras el automático corría).
   */
  private async unir(tx: any, id: number, claves: string[], pagos: string[], auto = false) {
    if (claves.length) {
      await tx.insert(mpConciliacionErp).values(claves.map((k) => (k.startsWith('v')
        ? { conciliacionId: id, ventaPagoId: Number(k.slice(1)) }
        : { conciliacionId: id, cobranzaPagoId: Number(k.slice(1)) })));
    }
    if (pagos.length) {
      const hechos = await tx.update(mpMovimientos).set({ conciliacionId: id })
        .where(and(inArray(mpMovimientos.id, pagos), isNull(mpMovimientos.conciliacionId), ...(auto ? [eq(mpMovimientos.aMano, false)] : [])))
        .returning({ id: mpMovimientos.id });
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
        v.estado in ('confirmada', 'pendiente_cae') as vigente, ce.conciliacion_id, ce.medio_anterior::text as medio_anterior
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
        c.estado = 'confirmada', ce.conciliacion_id, ce.medio_anterior::text
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
      medioAnterior: x.medio_anterior ?? null,
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
   * `sucursalId`: solo lo de ese local (la tabla «por local» sigue mostrando todos,
   * para poder cambiar). Un pago de Mercado Pago sin local conocido no es de ninguno.
   * Las listas van de lo más reciente a lo más viejo.
   */
  async ver(q: { desde?: string; hasta?: string; conciliados?: string; sucursalId?: string }, sesion: Sesion) {
    const { desde, hasta } = q;
    const suLocal = this.localDe(sesion);
    const suc = suLocal ?? (q.sucursalId ? Number(q.sucursalId) : null);
    if (!valido(desde) || !valido(hasta) || desde! > hasta!) throw new BadRequestException('Elegí un rango de días válido.');
    if (suc != null && !(Number.isInteger(suc) && suc > 0)) throw new BadRequestException('Ese local no es válido.');
    if (desdeDia(hasta!).getTime() - desdeDia(desde!).getTime() > 62 * DIA) throw new BadRequestException('Elegí hasta dos meses.');
    const ini = [desde!, ARRANQUE].sort()[1];
    const fin = sumaDias(hasta!, 1);
    const enRango = (col: string) => sql`${sql.raw(col)} >= ${desdeDia(ini)} and ${sql.raw(col)} < ${desdeDia(fin)}`;

    const [cobrosRango, pagosRango, pagosCerca] = await Promise.all([
      this.cobrosErp(enRango('v.fecha'), enRango('c.fecha')),
      this.pagosMp(sql`${mpMovimientos.fecha} >= ${desdeDia(ini)} and ${mpMovimientos.fecha} < ${desdeDia(fin)}`),
      /* Los sueltos de alrededor, para sugerir (una transferencia llega días antes). */
      this.pagosMp(sql`${mpMovimientos.conciliacionId} is null and ${mpMovimientos.estado} = 'approved'
        and ${mpMovimientos.fecha} >= ${desdeDia(sumaDias(ini, -3))} and ${mpMovimientos.fecha} < ${desdeDia(sumaDias(fin, 1))}`),
    ]);
    const delLocal = (x: { sucursalId: number | null }) => suc == null || x.sucursalId === suc;
    /* Quien no es jefe no ve otros locales, ni siquiera en la tabla «por local». */
    const cobrosTodos = suLocal != null ? cobrosRango.filter(delLocal) : cobrosRango;
    const pagosTodos = pagosRango.map((x) => ({ ...x.m, dia: x.dia }));
    const cobros = cobrosTodos.filter(delLocal);
    const pagos = pagosTodos.filter(delLocal);
    const recientes = (a: { fecha: Date }, b: { fecha: Date }) => b.fecha.getTime() - a.fecha.getTime();

    /* Los atados de lo que se ve (de todos los locales: la tabla por local los usa), con su otro lado aunque sea de otro día. */
    const idsConc = [...new Set([...cobrosTodos.map((c) => c.conciliacionId), ...pagosTodos.map((p) => p.conciliacionId)].filter((x): x is number => x != null))];
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
      sucursalId: m.sucursalId, pagador: m.pagador, medioErp: medioReal(m), ...(jefe ? { comision: m.comision, neto: m.neto } : {}),
    });

    /* Lo suelto de cada lado y las sugerencias. */
    const sueltosErp = cobros.filter((c) => c.vigente && !c.conciliacionId);
    const sueltosMp = new Map(pagosCerca.map((x) => [x.m.id, { ...x.m, dia: x.dia }]));
    const sugs = sugerir(sueltosErp.map(aCobro), [...sueltosMp.values()].map(aPago));
    const sugCobro = new Set(sugs.map((s) => s.clave));
    const sugPago = new Set(sugs.map((s) => s.mpId));
    const porClave = new Map(cobros.map((c) => [c.clave, c]));

    const faltan = sueltosErp.filter((c) => !sugCobro.has(c.clave)).sort(recientes);
    const sinVenta = pagos.filter((p) => !p.conciliacionId && p.estado === 'approved' && !sugPago.has(p.id)).sort(recientes);
    const sugeridos = sugs.map((s) => ({ motivo: s.motivo, cobro: porClave.get(s.clave)!, pago: verPago(sueltosMp.get(s.mpId)!) }))
      .sort((a, b) => recientes(a.cobro, b.cobro));

    /* Los atados, agrupados, y los avisos: plata devuelta o reclamada, o venta anulada con la plata en Mercado Pago. */
    const grupos = new Map<number, { id: number; tipo: string; motivo: string; usuario: string; creadoEn: Date; cobros: FilaErp[]; pagos: ReturnType<typeof verPago>[] }>();
    for (const c of (concs as any).rows as any[]) {
      grupos.set(Number(c.id), { id: Number(c.id), tipo: c.tipo, motivo: c.motivo, usuario: c.usuario ?? '', creadoEn: c.creado_en, cobros: [], pagos: [] });
    }
    for (const c of cobrosDeConc) grupos.get(c.conciliacionId!)?.cobros.push(c);
    for (const x of pagosDeConc) grupos.get(x.m.conciliacionId!)?.pagos.push(verPago({ ...x.m, dia: x.dia }));
    const delFiltro = (g: { cobros: FilaErp[]; pagos: { sucursalId: number | null }[] }) => suc == null || g.cobros.some(delLocal) || g.pagos.some(delLocal);
    const avisos = [...grupos.values()].filter(delFiltro).flatMap((g) => {
      const motivos = [
        g.pagos.some((p) => p.estado !== 'approved' || p.devuelto > EPS) ? 'Mercado Pago devolvió o tiene reclamado el pago' : null,
        g.cobros.some((c) => !c.vigente) && g.pagos.some((p) => p.estado === 'approved') ? 'La venta o el recibo se anuló y la plata sigue en Mercado Pago' : null,
      ].filter(Boolean) as string[];
      return motivos.length ? [{ ...g, avisos: motivos }] : [];
    });

    /* CONFIRMADO = lo que de verdad entró: en un atado donde Mercado Pago trajo
     * menos que el ERP (se tipeó mal en el Point), cada cobro cuenta en esa
     * proporción. «No entró a MP» no confirma nada. */
    const parteConfirmada = new Map<number, number>();
    for (const g of grupos.values()) {
      const erp = g.cobros.reduce((a, c) => a + c.importe, 0);
      const enMp = g.pagos.reduce((a, p) => a + p.bruto, 0);
      parteConfirmada.set(g.id, g.tipo === 'sin_mp' || erp <= 0 ? 0 : Math.min(1, enMp / erp));
    }
    const confirmadoDe = (c: FilaErp) => (c.conciliacionId ? c.importe * (parteConfirmada.get(c.conciliacionId) ?? 0) : 0);

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
      d.confirmado += confirmadoDe(c);
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
    for (const c of cobrosTodos) {
      if (!c.vigente) continue;
      const confirmado = confirmadoDe(c);
      const filas = [abrir(porSucursal, c.sucursal || '—', { sucursalId: c.sucursalId, sucursal: c.sucursal || '—' })];
      if (delLocal(c)) filas.push(abrir(porMedio, familia(c.medio), { familia: familia(c.medio) }));
      for (const g of filas) { g.vendido += c.importe; g.confirmado += confirmado; }
    }
    const redondear = (o: any) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? r2(v) : v]));
    const aprobados = pagos.filter((p) => p.estado === 'approved');

    return {
      ...this.estado(),
      desde: ini,
      hasta: hasta!,
      sucursalId: suc,
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
      conciliados: q.conciliados === '1' ? [...grupos.values()].filter(delFiltro) : null,
    };
  }

  /** Lo suelto de los dos lados en un rango corto: para atar a mano. */
  async sueltos(q: { desde?: string; hasta?: string }, sesion: Sesion) {
    const { desde, hasta } = q;
    if (!valido(desde) || !valido(hasta) || desde! > hasta! || desdeDia(hasta!).getTime() - desdeDia(desde!).getTime() > 7 * DIA) {
      throw new BadRequestException('Elegí hasta una semana.');
    }
    const fin = desdeDia(sumaDias(hasta!, 1));
    const [cobros, pagos] = await Promise.all([
      this.cobrosErp(sql`v.fecha >= ${desdeDia(desde!)} and v.fecha < ${fin}`, sql`c.fecha >= ${desdeDia(desde!)} and c.fecha < ${fin}`),
      this.pagosMp(sql`${mpMovimientos.conciliacionId} is null and ${mpMovimientos.estado} = 'approved'
        and ${mpMovimientos.fecha} >= ${desdeDia(desde!)} and ${mpMovimientos.fecha} < ${fin}`),
    ]);
    const suLocal = this.localDe(sesion);
    return {
      cobros: cobros.filter((c) => c.vigente && !c.conciliacionId && (suLocal == null || c.sucursalId === suLocal)),
      /* A quien no es jefe: lo de su local y lo que no tiene local (transferencias, posnets sin registrar). */
      pagos: pagos.filter((x) => suLocal == null || x.m.sucursalId == null || x.m.sucursalId === suLocal).map((x) => ({
        id: x.m.id, fecha: x.m.fecha, dia: x.dia, estado: x.m.estado, familia: x.m.familia, tipo: x.m.tipo, operacion: x.m.operacion, bruto: x.m.bruto,
        pagador: x.m.pagador, sucursalId: x.m.sucursalId, medioErp: medioReal(x.m),
      })),
    };
  }

  /* ------------------------------ las acciones ------------------------------ */

  /** El local de quien no es jefe (ve y opera solo ese); null = jefe, todos. */
  private localDe(sesion: Sesion): number | null {
    return esJefe(sesion) ? null : sesion.sucursalId;
  }

  /** Quien no es jefe solo toca cobros de su local. */
  private soloSuLocal(sesion: Sesion, filas: { sucursalId: number | null }[]) {
    const suLocal = this.localDe(sesion);
    if (suLocal != null && filas.some((f) => f.sucursalId !== suLocal)) throw new ForbiddenException('Eso es de otro local.');
  }

  /** Los renglones de pago del ERP por su clave («v12», «r3»). */
  private filasErp(claves: string[]) {
    const ids = (letra: string) => sql.join([0, ...claves.filter((k) => k[0] === letra).map((k) => Number(k.slice(1)))].map((i) => sql`${i}`), sql`, `);
    return this.cobrosErp(sql`vp.id in (${ids('v')})`, sql`cp.id in (${ids('r')})`);
  }

  /**
   * ¿Corresponde corregir el medio de este cobro con lo que dice este pago?
   * Solo uno con uno y por el MISMO importe (con otro importe puede ser otro
   * cobro), si Mercado Pago dice un medio claro (`medioReal`) y distinto. El QR
   * del ERP (referencia «MP n») ya es el de Mercado Pago: no se toca.
   */
  private cambioDeMedio(fila: FilaErp, pago: { bruto: number; familia: Familia; tipo: string }) {
    const ahora = medioReal(pago);
    if (!ahora || ahora === fila.medio || Math.abs(fila.importe - pago.bruto) > EPS || fila.referencia.startsWith('MP ')) return null;
    return { antes: fila.medio, ahora };
  }

  /** Cambia el medio del renglón, guarda el anterior en el atado (una sola vez) y lo deja en Auditoría. */
  private async aplicarMedio(tx: any, conciliacionId: number, fila: FilaErp, pagoId: string, cambio: { antes: string; ahora: string }, usuarioId: number) {
    const marcados = await tx.update(mpConciliacionErp).set({ medioAnterior: cambio.antes as any })
      .where(and(eq(mpConciliacionErp.conciliacionId, conciliacionId), isNull(mpConciliacionErp.medioAnterior)))
      .returning({ id: mpConciliacionErp.id });
    if (!marcados.length) throw new BadRequestException('Ese medio ya se corrigió: actualizá la pantalla.');
    const id = Number(fila.clave.slice(1));
    if (fila.clave[0] === 'v') await tx.update(ventaPagos).set({ medio: cambio.ahora as any }).where(eq(ventaPagos.id, id));
    else await tx.update(cobranzaPagos).set({ medio: cambio.ahora as any }).where(eq(cobranzaPagos.id, id));
    await tx.insert(auditoria).values({
      usuarioId, entidad: fila.clave[0] === 'v' ? 'venta_pago' : 'cobranza_pago', entidadId: id, ambito: 'Conciliación MP',
      detalle: `${fila.origen === 'venta' ? 'Venta' : 'Recibo'} ${fila.puntoVenta}-${fila.numero ?? ''} · pago de Mercado Pago N° ${pagoId}`,
      campo: 'medio', antes: cambio.antes, despues: cambio.ahora,
    });
  }

  /**
   * Atar a mano: cobros del ERP con pagos de Mercado Pago (uno o varios de
   * cada lado), o explicar lo que queda de un solo lado: `sin_venta` (entró
   * plata que no es una venta) o `sin_mp` (el cobro no entró a Mercado Pago).
   * Si los dos lados no suman lo mismo, hace falta decir por qué. Uno con uno y
   * por el mismo importe: el cobro toma el medio que dice Mercado Pago.
   */
  async atarAMano(dto: { cobros?: string[]; pagos?: string[]; motivo?: string }, sesion: Sesion) {
    const claves = [...new Set((dto.cobros ?? []).map(String))];
    const pagos = [...new Set((dto.pagos ?? []).map(String))];
    const motivo = String(dto.motivo ?? '').trim().slice(0, 200);
    if (claves.some((k) => !/^[vr]\d+$/.test(k))) throw new BadRequestException('Algún cobro no es válido.');
    if (!claves.length && !pagos.length) throw new BadRequestException('Elegí qué atar.');
    const tipo = claves.length && pagos.length ? 'manual' : claves.length ? 'sin_mp' : 'sin_venta';
    if (tipo !== 'manual' && !motivo) throw new BadRequestException(tipo === 'sin_mp' ? 'Decí por qué no entró a Mercado Pago.' : 'Decí qué es esa plata.');
    const enMp = pagos.length
      ? await this.db.select({ id: mpMovimientos.id, bruto: mpMovimientos.bruto, familia: mpMovimientos.familia, tipo: mpMovimientos.tipo, sucursalId: mpMovimientos.sucursalId })
        .from(mpMovimientos).where(inArray(mpMovimientos.id, pagos))
      : [];
    if (enMp.length !== pagos.length) throw new BadRequestException('Alguno de los pagos ya no existe: actualizá la pantalla.');
    const filas = claves.length ? await this.filasErp(claves) : [];
    if (filas.length !== claves.length) throw new BadRequestException('Alguno de los cobros ya no existe: actualizá la pantalla.');
    this.soloSuLocal(sesion, filas);
    /* «No es venta» sobre plata de toda la cuenta (sin local): solo un jefe. */
    if (tipo === 'sin_venta') this.soloSuLocal(sesion, enMp);
    let medio: { fila: FilaErp; pagoId: string; cambio: { antes: string; ahora: string } } | null = null;
    if (tipo === 'manual') {
      const dif = r2(filas.reduce((a, f) => a + f.importe, 0) - enMp.reduce((a, p) => a + p.bruto, 0));
      if (Math.abs(dif) > EPS && !motivo) throw new BadRequestException(`Los dos lados no suman lo mismo (diferencia $${dif.toFixed(2)}): decí por qué.`);
      const cambio = filas.length === 1 && enMp.length === 1 ? this.cambioDeMedio(filas[0], enMp[0]) : null;
      if (cambio) medio = { fila: filas[0], pagoId: enMp[0].id, cambio };
    }
    try {
      return await this.db.transaction(async (tx) => {
        const [c] = await tx.insert(mpConciliaciones).values({ tipo, motivo, usuarioId: sesion.usuarioId }).returning({ id: mpConciliaciones.id });
        await this.unir(tx, c.id, claves, pagos);
        if (medio) await this.aplicarMedio(tx, c.id, medio.fila, medio.pagoId, medio.cambio, sesion.usuarioId);
        return { id: c.id, medio: medio?.cambio ?? null };
      });
    } catch (e: any) {
      if (e?.code === '23505' || e?.cause?.code === '23505') throw new BadRequestException('Alguno de esos cobros ya está atado: actualizá la pantalla.');
      throw e;
    }
  }

  /** «Pasar a …» en un atado que ya existe (uno con uno, mismo importe): el cobro toma el medio que dice Mercado Pago. */
  async corregirMedio(id: number, sesion: Sesion) {
    const [filas, pagos] = await Promise.all([
      this.cobrosErp(sql`ce.conciliacion_id = ${id}`, sql`ce.conciliacion_id = ${id}`),
      this.db.select({ id: mpMovimientos.id, bruto: mpMovimientos.bruto, familia: mpMovimientos.familia, tipo: mpMovimientos.tipo })
        .from(mpMovimientos).where(eq(mpMovimientos.conciliacionId, id)),
    ]);
    if (filas.length !== 1 || pagos.length !== 1) throw new BadRequestException('Solo se corrige un cobro atado a un solo pago.');
    this.soloSuLocal(sesion, filas);
    const cambio = this.cambioDeMedio(filas[0], pagos[0]);
    if (!cambio || filas[0].medioAnterior) throw new BadRequestException('No hay medio para corregir: Mercado Pago dice el mismo, no es claro, o los importes no coinciden.');
    await this.db.transaction((tx) => this.aplicarMedio(tx, id, filas[0], pagos[0].id, cambio, sesion.usuarioId));
    return cambio;
  }

  /** Deshacer un atado: el medio corregido vuelve al de antes, y sus pagos quedan «a mano» (el automático no los vuelve a atar). */
  async deshacer(id: number, sesion: Sesion) {
    const filas = await this.cobrosErp(sql`ce.conciliacion_id = ${id}`, sql`ce.conciliacion_id = ${id}`);
    this.soloSuLocal(sesion, filas);
    /* «No es venta» (sin cobros del ERP) lo deshace solo un jefe, igual que lo marca. */
    if (!filas.length && this.localDe(sesion) != null) throw new ForbiddenException('Eso lo deshace un jefe.');
    return this.db.transaction(async (tx) => {
      await tx.update(mpMovimientos).set({ aMano: true }).where(eq(mpMovimientos.conciliacionId, id));
      await this.deshacerEn(tx, id, sesion.usuarioId, 'Se deshizo el atado');
      return { ok: true };
    });
  }

  /** Vuelve atrás un atado dentro de `tx`: cada medio corregido vuelve al anterior (queda en Auditoría) y el atado se borra. */
  private async deshacerEn(tx: any, id: number, usuarioId: number | null, porque: string) {
    const corregidos: any = await tx.execute(sql`
      select e.venta_pago_id, e.cobranza_pago_id, e.medio_anterior::text as anterior, coalesce(vp.medio, cp.medio)::text as actual
      from mp_conciliacion_erp e
      left join venta_pagos vp on vp.id = e.venta_pago_id
      left join cobranza_pagos cp on cp.id = e.cobranza_pago_id
      where e.conciliacion_id = ${id} and e.medio_anterior is not null`);
    for (const r of corregidos.rows as any[]) {
      if (r.venta_pago_id != null) await tx.update(ventaPagos).set({ medio: r.anterior }).where(eq(ventaPagos.id, Number(r.venta_pago_id)));
      else await tx.update(cobranzaPagos).set({ medio: r.anterior }).where(eq(cobranzaPagos.id, Number(r.cobranza_pago_id)));
      await tx.insert(auditoria).values({
        usuarioId, entidad: r.venta_pago_id != null ? 'venta_pago' : 'cobranza_pago', entidadId: Number(r.venta_pago_id ?? r.cobranza_pago_id),
        ambito: 'Conciliación MP', detalle: porque, campo: 'medio', antes: r.actual, despues: r.anterior,
      });
    }
    const borrados = await tx.delete(mpConciliaciones).where(eq(mpConciliaciones.id, id)).returning({ id: mpConciliaciones.id });
    if (!borrados.length) throw new NotFoundException('Ese atado ya no existe.');
  }
}

@Controller('mercadopago/conciliacion')
export class ConciliacionMpController {
  constructor(private readonly svc: ConciliacionMpService) {}

  @Get() @Permiso(PERMISO_CONCILIACION)
  ver(@Query() q: { desde?: string; hasta?: string; conciliados?: string; sucursalId?: string }, @Auth() sesion: Sesion) { return this.svc.ver(q, sesion); }

  @Get('sueltos') @Permiso(PERMISO_CONCILIACION)
  sueltos(@Query() q: { desde?: string; hasta?: string }, @Auth() sesion: Sesion) { return this.svc.sueltos(q, sesion); }

  /** Bajar ya lo nuevo de Mercado Pago (además del reloj de cada 5 minutos). */
  @Post('actualizar') @Permiso(PERMISO_CONCILIACION)
  actualizar() { return this.svc.actualizar(); }

  @Post() @Permiso(PERMISO_CONCILIACION)
  atar(@Body() body: { cobros?: string[]; pagos?: string[]; motivo?: string }, @Auth() sesion: Sesion) { return this.svc.atarAMano(body ?? {}, sesion); }

  /** «Pasar a …»: corrige el medio de un atado uno con uno. */
  @Post(':id/medio') @Permiso(PERMISO_CONCILIACION)
  corregirMedio(@Param('id', ParseIntPipe) id: number, @Auth() sesion: Sesion) { return this.svc.corregirMedio(id, sesion); }

  @Delete(':id') @Permiso(PERMISO_CONCILIACION)
  deshacer(@Param('id', ParseIntPipe) id: number, @Auth() sesion: Sesion) { return this.svc.deshacer(id, sesion); }
}
