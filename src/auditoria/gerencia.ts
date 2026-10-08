/**
 * GERENCIA › AUDITORÍA (0144, 8/10/2026, pedido del dueño)
 * ============================================================================
 * «Quién hizo qué»: todo lo que una persona puede hacer para que la plata o la
 * mercadería no cierre, junto y por persona, para ver patrones («esta cajera
 * anula mucho», «este producto se ajusta todas las semanas»).
 *
 * NO GUARDA NADA NUEVO: lee lo que cada operación ya deja firmado en su tabla.
 *   anulacion   ventas anuladas (quién, cuándo, por qué)            ventas
 *   devolucion  notas de crédito y devoluciones de ticket           ventas
 *   a_mano      precio pisado, lista habilitada o descuento a mano  venta_items
 *   stock       ajustes y bajas (merma, vencido, defectuoso)        movimientos
 *   caja        cierres con diferencia, controles, sobres, caja del dueño
 *   retiro      retiros sin costo de los socios (0146), a costo        retiros
 *   otras       cobranzas, compras, movimientos de caja y del Cash Flow,
 *               sobres, gastos y retiros anulados
 *   cambios     la tabla `auditoria`: usuarios, roles, permisos, sucursales,
 *               fichas, formatos, relevos de caja, respaldos…
 *
 * RÁPIDO A PROPÓSITO: cada fuente lee solo su período con un índice (0144) y
 * todo corre en UNA conexión de solo lectura —una foto consistente que no le
 * quita conexiones a las cajas—. Los totales y la tabla por persona cuentan el
 * período entero; la lista de movimientos trae los más recientes (TOPE).
 */
import { BadRequestException } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import type { Database } from '../db/drizzle';
import { etiquetaVenta } from '../ventas/etiqueta';

export const TIPOS_AUDITORIA = {
  anulacion: 'Ventas anuladas',
  devolucion: 'Notas de crédito y devoluciones',
  a_mano: 'Precios y descuentos a mano',
  stock: 'Ajustes y bajas de stock',
  caja: 'Diferencias de caja',
  retiro: 'Retiros sin costo',
  otras: 'Otras anulaciones',
  cambios: 'Cambios en el sistema',
} as const;
export type TipoAuditoria = keyof typeof TIPOS_AUDITORIA;

/** Cuántos movimientos viajan a la pantalla: los más recientes del filtro. */
const TOPE = 1500;
const MAX_DIAS = 366;
const DIA = /^\d{4}-\d{2}-\d{2}$/;
const r2 = (n: unknown) => Math.round((Number(n) || 0) * 100) / 100;
/*
 * Los formateadores se crean UNA vez: `toLocaleString` arma uno nuevo en cada
 * llamada y, con un año de movimientos, eso solo se comía casi 2 segundos.
 */
const ENTERO = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 });
const CENTAVOS = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const CANTIDAD = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 3 });
const PORCENTAJE = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 1 });
const FECHA_HORA = new Intl.DateTimeFormat('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', dateStyle: 'short', timeStyle: 'short' });
/** «$1.500» o «$96,80»: los centavos, completos o ninguno. */
const $ = (n: number) => {
  const v = Math.abs(r2(n));
  return `${n < 0 ? '−' : ''}$${(Number.isInteger(v) ? ENTERO : CENTAVOS).format(v)}`;
};
const cant = (n: unknown) => CANTIDAD.format(Number(n) || 0);
/** Menos de 50 centavos no es una diferencia: es redondeo. */
const NULA = 0.5;

export interface FiltroAuditoria {
  desde: string;
  hasta: string;
  sucursalId: number | null;
  usuarioId: number | null;
  /** Solo achica la LISTA de movimientos; los totales muestran todos los tipos. */
  tipo: TipoAuditoria | null;
}

export interface EventoAuditoria {
  id: string;
  tipo: TipoAuditoria;
  fecha: string;
  usuarioId: number | null;
  sucursalId: number | null;
  /** anulación/devolución/otras: importe · a mano: lo que se dejó de cobrar · retiro: a costo · stock y caja: con signo (− = faltó). */
  monto: number | null;
  titulo: string;
  detalle: string[];
  motivo: string;
  /** Se muestra pero no suma: un control a mitad de turno ya lo cuenta el cierre. */
  informativo?: boolean;
  /** La otra persona del caso: quién cobró la venta anulada, quién hizo el control. */
  otro?: { etiqueta: string; usuarioId: number };
}

/** Cada producto ajustado o dado de baja, suelto (también los de un control): la base de la alerta «se ajusta seguido». */
interface AjusteSuelto { clave: string; producto: string; sucursalId: number | null; usuarioId: number | null; valor: number }

export function validarFiltro(q: Record<string, string | undefined>): FiltroAuditoria {
  const { desde, hasta } = q;
  if (!desde || !hasta || !DIA.test(desde) || !DIA.test(hasta)) throw new BadRequestException('Elegí el período (desde y hasta).');
  const dias = (Date.parse(hasta) - Date.parse(desde)) / 86_400_000 + 1;
  if (!(dias >= 1)) throw new BadRequestException('La fecha «desde» es posterior a «hasta».');
  if (dias > MAX_DIAS) throw new BadRequestException('El período puede ser de hasta un año.');
  const tipo = q.tipo && q.tipo in TIPOS_AUDITORIA ? (q.tipo as TipoAuditoria) : null;
  return { desde, hasta, sucursalId: Number(q.sucursalId) || null, usuarioId: Number(q.usuarioId) || null, tipo };
}

export async function auditoriaGerencia(db: Database, f: FiltroAuditoria) {
  /* El día argentino entero: de las 0 del «desde» a las 0 del día siguiente al «hasta». */
  const ini = new Date(`${f.desde}T00:00:00-03:00`);
  const fin = new Date(new Date(`${f.hasta}T00:00:00-03:00`).getTime() + 86_400_000);
  const en = (col: string) => sql`${sql.raw(col)} >= ${ini} AND ${sql.raw(col)} < ${fin}`;
  const deSuc = (col: string): SQL => (f.sucursalId ? sql` AND ${sql.raw(col)} = ${f.sucursalId}` : sql``);
  /* Lo que no es de ningún local (el Cash Flow del dueño, los cambios de usuarios…) sale al filtrar por local. */
  const sinLocal = !f.sucursalId;

  const datos = await db.transaction(async (tx) => {
    const q = async (consulta: SQL) => { const r: any = await tx.execute(consulta); return (r.rows ?? r) as any[]; };
    return {
      cobradas: await q(sql`
        SELECT coalesce(v.cobrado_por, v.usuario_id) AS u, count(*)::int AS n, coalesce(sum(v.total), 0) AS total
          FROM ventas v
         WHERE ${en('v.fecha')} AND v.estado <> 'borrador' AND v.tipo::text NOT LIKE 'nota_%' ${deSuc('v.sucursal_id')}
         GROUP BY 1`),
      anuladas: await q(sql`
        SELECT v.id, v.anulado_en AS fecha, v.anulado_por AS u, v.sucursal_id AS suc, v.total, v.tipo, v.punto_venta, v.numero,
               v.fecha AS vendida, coalesce(v.cobrado_por, v.usuario_id) AS cobro, v.anulado_motivo AS motivo, c.nombre AS cliente
          FROM ventas v LEFT JOIN clientes c ON c.id = v.cliente_id
         WHERE v.estado = 'anulada' AND ${en('v.anulado_en')} ${deSuc('v.sucursal_id')}`),
      notas: await q(sql`
        SELECT v.id, v.fecha, v.usuario_id AS u, v.sucursal_id AS suc, v.total, v.tipo, v.punto_venta, v.numero, v.observaciones,
               o.tipo AS o_tipo, o.punto_venta AS o_pv, o.numero AS o_numero, c.nombre AS cliente
          FROM ventas v
          LEFT JOIN ventas o ON o.id = v.ref_venta_id
          LEFT JOIN clientes c ON c.id = v.cliente_id
         WHERE v.tipo::text LIKE 'nota_credito%' AND v.estado IN ('confirmada', 'pendiente_cae') AND ${en('v.fecha')} ${deSuc('v.sucursal_id')}`),
      /* El WHERE de los renglones repite el del índice parcial al pie de la letra: así lo usa. */
      aMano: await q(sql`
        SELECT v.id, v.fecha, coalesce(v.cobrado_por, v.usuario_id) AS u, v.sucursal_id AS suc, v.tipo, v.punto_venta, v.numero,
               cl.nombre AS cliente, coalesce(cl.descuento, 0) AS desc_cliente,
               json_agg(json_build_array(p.nombre, vi.cantidad, vi.lista, vi.lista_origen, vi.precio_lista,
                                         vi.precio_unitario, vi.descuento, vi.iva, vi.descuento_id, vi.oferta_descuento)) AS items
          FROM venta_items vi
          JOIN ventas v ON v.id = vi.venta_id
          JOIN productos p ON p.id = vi.producto_id
          LEFT JOIN clientes cl ON cl.id = v.cliente_id
         WHERE (vi.lista_origen = 'manual' OR (vi.descuento > 0 AND vi.descuento_id IS NULL AND vi.oferta_descuento = 0))
           AND ${en('v.fecha')} AND v.estado IN ('confirmada', 'pendiente_cae') AND v.tipo::text NOT LIKE 'nota_%' ${deSuc('v.sucursal_id')}
         GROUP BY v.id, cl.nombre, cl.descuento`),
      stock: await q(sql`
        SELECT m.id, m.fecha, m.usuario_id AS u, m.sucursal_id AS suc, m.tipo, m.signo, m.cantidad, m.unidad, m.costo_unitario,
               m.motivo, m.producto_id, coalesce(p.nombre, 'Producto borrado') AS producto, m.pres_label,
               m.ref_conteo_id, co.nombre AS conteo, co.aplicado_por
          FROM movimientos m
          LEFT JOIN productos p ON p.id = m.producto_id
          LEFT JOIN conteos co ON co.id = m.ref_conteo_id
         WHERE m.tipo IN ('ajuste', 'merma', 'vencido', 'defectuoso') AND m.signo <> 0 AND ${en('m.fecha')} ${deSuc('m.sucursal_id')}`),
      cierres: await q(sql`
        SELECT cs.id, cs.cierre AS fecha, cs.usuario_id AS u, cs.sucursal_id AS suc, cs.diferencia,
               cs.sistema_efectivo, cs.declarado_efectivo, cs.observaciones
          FROM caja_sesiones cs
         WHERE cs.estado = 'cerrada' AND abs(cs.diferencia) >= ${NULA} AND ${en('cs.cierre')} ${deSuc('cs.sucursal_id')}`),
      controles: await q(sql`
        SELECT cc.id, cc.fecha, cs.usuario_id AS u, cc.usuario_id AS controlo, cs.sucursal_id AS suc, cc.diferencia,
               cc.esperado_efectivo, cc.contado_efectivo, cc.observaciones, cs.id AS turno
          FROM caja_controles cc JOIN caja_sesiones cs ON cs.id = cc.caja_sesion_id
         WHERE abs(cc.diferencia) >= ${NULA} AND ${en('cc.fecha')} ${deSuc('cs.sucursal_id')}
           -- El cierre por envío firma su propio conteo como control (caja.module): ese ES el cierre, no va dos veces.
           AND cc.observaciones NOT LIKE 'Cierre por envío%'`),
      sobres: await q(sql`
        SELECT so.id, so.controlado_en AS fecha, cs.usuario_id AS u, so.controlado_por AS controlo, cs.sucursal_id AS suc,
               so.diferencia, so.enviado, so.contado, so.motivo, cs.id AS turno
          FROM cashflow_sobres so JOIN caja_sesiones cs ON cs.id = so.caja_sesion_id
         WHERE so.anulado_en IS NULL AND NOT so.descartado AND abs(so.diferencia) >= ${NULA}
           AND ${en('so.controlado_en')} ${deSuc('cs.sucursal_id')}`),
      cajaDueno: sinLocal ? await q(sql`
        SELECT c.id, c.fecha, c.usuario_id AS u, c.diferencia, c.esperado, c.contado, c.motivo, c.ajustado
          FROM cashflow_conteos c
         WHERE abs(c.diferencia) >= ${NULA} AND ${en('c.fecha')}`) : [],
      cobranzas: await q(sql`
        SELECT co.id, co.anulado_en AS fecha, co.anulado_por AS u, co.sucursal_id AS suc, co.total, co.punto_venta, co.numero,
               co.anulado_motivo AS motivo, cl.nombre AS cliente
          FROM cobranzas co LEFT JOIN clientes cl ON cl.id = co.cliente_id
         WHERE co.estado = 'anulada' AND ${en('co.anulado_en')} ${deSuc('co.sucursal_id')}`),
      compras: await q(sql`
        SELECT c.id, c.anulado_en AS fecha, c.anulado_por AS u, c.sucursal_id AS suc, c.total, c.tipo, c.letra, c.punto_venta,
               c.numero, c.motivo_anulacion AS motivo, p.nombre AS proveedor
          FROM comprobantes c LEFT JOIN proveedores p ON p.id = c.proveedor_id
         WHERE c.estado = 'anulado' AND ${en('c.anulado_en')} ${deSuc('c.sucursal_id')}`),
      movCaja: await q(sql`
        SELECT m.id, m.anulado_en AS fecha, m.anulado_por AS u, cs.sucursal_id AS suc, m.importe, m.tipo, m.motivo,
               m.anulado_motivo, cs.id AS turno
          FROM caja_movimientos m JOIN caja_sesiones cs ON cs.id = m.caja_sesion_id
         WHERE ${en('m.anulado_en')} ${deSuc('cs.sucursal_id')}`),
      /* El movimiento de un sobre cuyo control se deshizo ya aparece como «sobre»: no dos veces. */
      movCashflow: sinLocal ? await q(sql`
        SELECT m.id, m.anulado_en AS fecha, m.anulado_por AS u, m.importe, m.tipo, m.detalle, m.anulado_motivo AS motivo,
               k.nombre AS concepto
          FROM cashflow_movimientos m LEFT JOIN cashflow_conceptos k ON k.id = m.concepto_id
         WHERE ${en('m.anulado_en')}
           AND NOT EXISTS (SELECT 1 FROM cashflow_sobres so WHERE so.id = m.sobre_id AND so.anulado_en IS NOT NULL)`) : [],
      sobresDeshechos: await q(sql`
        SELECT so.id, so.anulado_en AS fecha, so.anulado_por AS u, cs.sucursal_id AS suc, so.contado, so.anulado_motivo AS motivo,
               cs.id AS turno
          FROM cashflow_sobres so JOIN caja_sesiones cs ON cs.id = so.caja_sesion_id
         WHERE ${en('so.anulado_en')} ${deSuc('cs.sucursal_id')}`),
      retiros: await q(sql`
        SELECT r.id, r.fecha, r.usuario_id AS u, r.sucursal_id AS suc, r.costo_total, r.anulado_en, c.nombre AS cliente,
               (SELECT json_agg(json_build_array(i.nombre, i.cantidad) ORDER BY i.id) FROM retiro_items i WHERE i.retiro_id = r.id) AS items
          FROM retiros r JOIN clientes c ON c.id = r.cliente_id
         WHERE ${en('r.fecha')} ${deSuc('r.sucursal_id')}`),
      retirosAnulados: await q(sql`
        SELECT r.id, r.anulado_en AS fecha, r.anulado_por AS u, r.sucursal_id AS suc, r.costo_total, r.anulado_motivo AS motivo, c.nombre AS cliente
          FROM retiros r JOIN clientes c ON c.id = r.cliente_id
         WHERE ${en('r.anulado_en')} ${deSuc('r.sucursal_id')}`),
      /* Solo lo que hizo una PERSONA: lo automático (copias nocturnas, sincronizaciones) no es «quién hizo qué». */
      cambios: await q(sql`
        SELECT a.id, a.fecha, a.usuario_id AS u, a.entidad, a.entidad_id, a.ambito, a.detalle, a.campo, a.antes, a.despues,
               coalesce(g.sucursal_id, cs.sucursal_id, CASE WHEN a.entidad = 'sucursal' THEN a.entidad_id END) AS suc, g.total AS gasto_total
          FROM auditoria a
          LEFT JOIN gastos g ON a.entidad = 'gasto' AND a.ambito = 'Anulación' AND g.id = a.entidad_id
          LEFT JOIN caja_sesiones cs ON a.entidad = 'caja' AND cs.id = a.entidad_id
         WHERE a.usuario_id IS NOT NULL AND ${en('a.fecha')}
           ${f.sucursalId ? sql` AND coalesce(g.sucursal_id, cs.sucursal_id, CASE WHEN a.entidad = 'sucursal' THEN a.entidad_id END) = ${f.sucursalId}` : sql``}
         ORDER BY a.fecha DESC, a.id`),
      usuarios: await q(sql`SELECT id, nombre FROM usuarios`),
      sucursales: await q(sql`SELECT id, nombre FROM sucursales`),
    };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });

  const { eventos, ajustes } = armarEventos(datos);
  const deLaPersona = f.usuarioId ? eventos.filter((e) => e.usuarioId === f.usuarioId) : eventos;
  const cobradas = datos.cobradas.map((x) => ({ u: x.u == null ? null : Number(x.u), n: Number(x.n), total: Number(x.total) }));

  /* Los números de arriba: todos los tipos, siempre (el tipo elegido solo achica la lista). */
  const tipos = (Object.keys(TIPOS_AUDITORIA) as TipoAuditoria[]).map((clave) => {
    const de = deLaPersona.filter((e) => e.tipo === clave && !e.informativo);
    const caja = clave === 'caja';
    return {
      clave, etiqueta: TIPOS_AUDITORIA[clave], n: de.length,
      monto: clave === 'cambios' ? null : r2(de.reduce((s, e) => s + (e.monto ?? 0), 0)),
      ...(caja ? {
        faltante: r2(de.reduce((s, e) => s + Math.min(e.monto ?? 0, 0), 0)),
        sobrante: r2(de.reduce((s, e) => s + Math.max(e.monto ?? 0, 0), 0)),
      } : {}),
    };
  });

  const personas = porPersona(eventos, cobradas).filter((p) => !f.usuarioId || p.usuarioId === f.usuarioId);
  const nombreDe = (filas: any[]) => new Map<number, string>(filas.map((x) => [Number(x.id), x.nombre]));
  const alertas = armarAlertas({
    eventos, personas, cobradas, ajustes: f.usuarioId ? ajustes.filter((a) => a.usuarioId === f.usuarioId) : ajustes,
    usuarios: nombreDe(datos.usuarios), sucursales: nombreDe(datos.sucursales),
  });

  const lista = (f.tipo ? deLaPersona.filter((e) => e.tipo === f.tipo) : deLaPersona)
    .sort((a, b) => (a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : 0));
  const usados = new Set<number>();
  const sucsUsadas = new Set<number>();
  for (const e of eventos) {
    if (e.usuarioId) usados.add(e.usuarioId);
    if (e.otro) usados.add(e.otro.usuarioId);
    if (e.sucursalId) sucsUsadas.add(e.sucursalId);
  }
  for (const c of cobradas) if (c.u) usados.add(c.u);
  const dic = (filas: any[], ids: Set<number>) => Object.fromEntries(filas.filter((x) => ids.has(Number(x.id))).map((x) => [x.id, x.nombre]));

  return {
    desde: f.desde, hasta: f.hasta, sucursalId: f.sucursalId, usuarioId: f.usuarioId, tipo: f.tipo,
    tipos, personas, alertas,
    eventos: lista.slice(0, TOPE),
    totalEventos: lista.length,
    tope: TOPE,
    nombres: { usuarios: dic(datos.usuarios, usados), sucursales: dic(datos.sucursales, sucsUsadas) },
  };
}

/* ============================================================================
 * CADA FUENTE, A UN MISMO FORMATO
 * ========================================================================== */
type Datos = Record<string, any[]>;
const iso = (v: unknown) => new Date(v as string).toISOString();
const num = (v: unknown) => (v == null ? null : Number(v));
const primeraLinea = (t: unknown) => String(t ?? '').split('\n')[0].trim();
const ETIQ_MOV: Record<string, string> = { ajuste: 'Ajuste', merma: 'Merma', vencido: 'Vencido', defectuoso: 'Defectuoso' };

function armarEventos(d: Datos): { eventos: EventoAuditoria[]; ajustes: AjusteSuelto[] } {
  const ev: EventoAuditoria[] = [];
  const ajustes: AjusteSuelto[] = [];
  const push = (e: EventoAuditoria) => ev.push(e);

  for (const x of d.anuladas) {
    const cobro = num(x.cobro);
    push({
      id: `anulacion-${x.id}`, tipo: 'anulacion', fecha: iso(x.fecha), usuarioId: num(x.u), sucursalId: num(x.suc), monto: r2(x.total),
      titulo: `${etiquetaVenta({ tipo: x.tipo, puntoVenta: x.punto_venta, numero: x.numero })} anulada`,
      detalle: [`Vendida el ${FECHA_HORA.format(new Date(x.vendida))}${x.cliente ? ` a ${x.cliente}` : ''}`],
      motivo: x.motivo ?? '',
      ...(cobro && cobro !== num(x.u) ? { otro: { etiqueta: 'La cobró', usuarioId: cobro } } : {}),
    });
  }

  for (const x of d.notas) {
    const original = x.o_tipo ? etiquetaVenta({ tipo: x.o_tipo, puntoVenta: x.o_pv, numero: x.o_numero }) : '';
    push({
      id: `devolucion-${x.id}`, tipo: 'devolucion', fecha: iso(x.fecha), usuarioId: num(x.u), sucursalId: num(x.suc), monto: r2(x.total),
      titulo: etiquetaVenta({ tipo: x.tipo, puntoVenta: x.punto_venta, numero: x.numero }),
      detalle: [original ? `De ${original}${x.cliente ? ` · ${x.cliente}` : ''}` : (x.cliente ?? '')].filter(Boolean),
      motivo: primeraLinea(x.observaciones),
    });
  }

  /*
   * A MANO, renglón por renglón, con la regla del POS (`resolverRenglones`):
   *   · precio pisado: la lista decía una cosa y se cobró otra → la diferencia;
   *   · lista habilitada a mano: el ticket no la ganaba y alguien con permiso
   *     la abrió (se cobró la lista entera: lo regalado contra la base no queda);
   *   · descuento a mano: el del renglón que NO es el del cliente, ni un
   *     descuento con nombre (los autorizó el dueño) ni una oferta.
   * Importes finales, con IVA: lo que el cliente dejó de pagar.
   */
  for (const x of d.aMano) {
    const descCliente = Number(x.desc_cliente) || 0;
    let dejado = 0;
    const lineas: string[] = [];
    for (const [nombre, cantidad, lista, origen, pLista, pUnit, desc, iva, descId, ofertaDesc] of x.items as any[]) {
      const conIva = 1 + (Number(iva) || 0) / 100;
      const c = Number(cantidad) || 0;
      const pl = Number(pLista) || 0;
      const pu = Number(pUnit) || 0;
      const d0 = Number(desc) || 0;
      const enLista = origen === 'manual';
      const pisado = enLista && Math.abs(pl - pu) > 0.005;
      const descManual = d0 > 0 && descId == null && !(Number(ofertaDesc) > 0) && Math.abs(d0 - descCliente) > 1e-6;
      if (!enLista && !descManual) continue;
      const partes: string[] = [];
      if (pisado) {
        dejado += (pl - pu) * c * conIva;
        partes.push(`a ${$(pu * conIva)} en vez de ${$(pl * conIva)}`);
      } else if (enLista) {
        partes.push(`lista ${lista || 'elegida'} habilitada a mano`);
      }
      if (descManual) {
        dejado += pu * c * (d0 / 100) * conIva;
        partes.push(`${cant(d0)} % de descuento`);
      }
      lineas.push(`${nombre} × ${cant(c)}: ${partes.join(' y ')}`);
    }
    if (!lineas.length) continue;
    push({
      id: `a_mano-${x.id}`, tipo: 'a_mano', fecha: iso(x.fecha), usuarioId: num(x.u), sucursalId: num(x.suc), monto: r2(dejado),
      titulo: `${etiquetaVenta({ tipo: x.tipo, puntoVenta: x.punto_venta, numero: x.numero })}${x.cliente ? ` · ${x.cliente}` : ''}`,
      detalle: lineas, motivo: '',
    });
  }

  /* Stock: el control de stock aplicado es UN evento (con todos sus renglones); lo manual, uno por movimiento. */
  const porConteo = new Map<number, any[]>();
  for (const x of d.stock) {
    const valor = Number(x.signo) * (Number(x.cantidad) || 0) * (Number(x.costo_unitario) || 0);
    const linea = `${x.producto}${x.pres_label ? ` ${x.pres_label}` : ''}: ${Number(x.signo) > 0 ? '+' : '−'}${cant(x.cantidad)} ${x.unidad || ''}`.trim();
    ajustes.push({ clave: `${x.producto_id}|${x.suc}`, producto: x.producto, sucursalId: num(x.suc), usuarioId: num(x.aplicado_por ?? x.u), valor });
    if (x.ref_conteo_id) {
      const a = porConteo.get(Number(x.ref_conteo_id)) ?? [];
      a.push({ ...x, valor, linea });
      porConteo.set(Number(x.ref_conteo_id), a);
      continue;
    }
    push({
      id: `stock-${x.id}`, tipo: 'stock', fecha: iso(x.fecha), usuarioId: num(x.u), sucursalId: num(x.suc),
      monto: Number(x.costo_unitario) > 0 ? r2(valor) : null,
      titulo: `${ETIQ_MOV[x.tipo] ?? x.tipo}: ${linea}`,
      detalle: Number(x.costo_unitario) > 0 ? [] : ['Sin costo registrado (movimiento anterior al 27/9 o que no es una pérdida nueva)'],
      motivo: x.motivo ?? '',
    });
  }
  for (const [conteoId, filas] of porConteo) {
    const x = filas[0];
    const valor = filas.reduce((s, y) => s + y.valor, 0);
    const falta = filas.reduce((s, y) => s + Math.min(y.valor, 0), 0);
    const sobra = filas.reduce((s, y) => s + Math.max(y.valor, 0), 0);
    filas.sort((a, b) => Math.abs(b.valor) - Math.abs(a.valor));
    push({
      id: `stock-conteo-${conteoId}`, tipo: 'stock', fecha: iso(x.fecha), usuarioId: num(x.aplicado_por ?? x.u), sucursalId: num(x.suc), monto: r2(valor),
      titulo: `Control de stock «${x.conteo ?? `#${conteoId}`}»: ${filas.length} producto${filas.length === 1 ? '' : 's'} ajustado${filas.length === 1 ? '' : 's'}`,
      detalle: [`Faltó ${$(-falta)} · sobró ${$(sobra)}`, ...filas.slice(0, 8).map((y) => `${y.linea} (${$(y.valor)})`),
        ...(filas.length > 8 ? [`y ${filas.length - 8} más`] : [])],
      motivo: '',
    });
  }

  for (const x of d.cierres) {
    push({
      id: `caja-cierre-${x.id}`, tipo: 'caja', fecha: iso(x.fecha), usuarioId: num(x.u), sucursalId: num(x.suc), monto: r2(x.diferencia),
      titulo: `Cierre de caja (turno #${x.id}) ${Number(x.diferencia) < 0 ? 'con faltante' : 'con sobrante'}`,
      detalle: [`Tenía que haber ${$(x.sistema_efectivo)} en efectivo y se contaron ${$(x.declarado_efectivo)}`],
      motivo: x.observaciones ?? '',
    });
  }
  for (const x of d.controles) {
    push({
      id: `caja-control-${x.id}`, tipo: 'caja', fecha: iso(x.fecha), usuarioId: num(x.u), sucursalId: num(x.suc), monto: r2(x.diferencia),
      titulo: `Control a mitad del turno #${x.turno}`,
      detalle: [`Tenía que haber ${$(x.esperado_efectivo)} y se contaron ${$(x.contado_efectivo)}`,
        'No suma: si la diferencia sigue, la cuenta el cierre del turno'],
      motivo: x.observaciones ?? '', informativo: true,
      ...(x.controlo && num(x.controlo) !== num(x.u) ? { otro: { etiqueta: 'Lo controló', usuarioId: Number(x.controlo) } } : {}),
    });
  }
  for (const x of d.sobres) {
    push({
      id: `caja-sobre-${x.id}`, tipo: 'caja', fecha: iso(x.fecha), usuarioId: num(x.u), sucursalId: num(x.suc), monto: r2(x.diferencia),
      titulo: `Sobre del turno #${x.turno}: ${Number(x.diferencia) < 0 ? 'llegó de menos' : 'llegó de más'}`,
      detalle: [`Se mandaron ${$(x.enviado)} y en el Cash Flow se contaron ${$(x.contado)}`],
      motivo: x.motivo ?? '',
      ...(x.controlo ? { otro: { etiqueta: 'Lo contó', usuarioId: Number(x.controlo) } } : {}),
    });
  }
  for (const x of d.cajaDueno) {
    push({
      id: `caja-dueno-${x.id}`, tipo: 'caja', fecha: iso(x.fecha), usuarioId: num(x.u), sucursalId: null, monto: r2(x.diferencia),
      titulo: `Conteo de la caja del dueño (Cash Flow)${x.ajustado ? ' · ajustado en el libro' : ''}`,
      detalle: [`El libro decía ${$(x.esperado)} y se contaron ${$(x.contado)}`],
      motivo: x.motivo ?? '',
    });
  }

  /* Lo que se llevó un socio, a costo. Anulado se ve pero no suma (la anulación va a «otras»). */
  for (const x of d.retiros) {
    const its = (x.items ?? []) as [string, number][];
    push({
      id: `retiro-${x.id}`, tipo: 'retiro', fecha: iso(x.fecha), usuarioId: num(x.u), sucursalId: num(x.suc), monto: r2(x.costo_total),
      titulo: `Retiro sin costo #${x.id} · ${x.cliente}`,
      detalle: [...its.slice(0, 8).map(([nombre, c]) => `${nombre} × ${cant(c)}`), ...(its.length > 8 ? [`y ${its.length - 8} más`] : []),
        ...(x.anulado_en ? ['Anulado: no suma'] : [])],
      motivo: '', ...(x.anulado_en ? { informativo: true } : {}),
    });
  }
  for (const x of d.retirosAnulados) {
    push({
      id: `otras-retiro-${x.id}`, tipo: 'otras', fecha: iso(x.fecha), usuarioId: num(x.u), sucursalId: num(x.suc), monto: r2(x.costo_total),
      titulo: `Retiro sin costo #${x.id} anulado · ${x.cliente}`, detalle: ['La mercadería volvió al stock'], motivo: x.motivo ?? '',
    });
  }

  for (const x of d.cobranzas) {
    push({
      id: `otras-cobranza-${x.id}`, tipo: 'otras', fecha: iso(x.fecha), usuarioId: num(x.u), sucursalId: num(x.suc), monto: r2(x.total),
      titulo: `Cobranza ${x.punto_venta}-${String(x.numero ?? 0).padStart(8, '0')} anulada${x.cliente ? ` · ${x.cliente}` : ''}`,
      detalle: [], motivo: x.motivo ?? '',
    });
  }
  for (const x of d.compras) {
    const nro = x.numero ? ` ${x.punto_venta ?? ''}-${x.numero}` : '';
    push({
      id: `otras-compra-${x.id}`, tipo: 'otras', fecha: iso(x.fecha), usuarioId: num(x.u), sucursalId: num(x.suc), monto: r2(x.total),
      titulo: `Compra anulada: ${String(x.tipo ?? '').replace(/_/g, ' ')} ${x.letra ?? ''}${nro}${x.proveedor ? ` · ${x.proveedor}` : ''}`.replace(/\s+/g, ' '),
      detalle: [], motivo: x.motivo ?? '',
    });
  }
  for (const x of d.movCaja) {
    push({
      id: `otras-movcaja-${x.id}`, tipo: 'otras', fecha: iso(x.fecha), usuarioId: num(x.u), sucursalId: num(x.suc), monto: r2(x.importe),
      titulo: `${x.tipo === 'ingreso' ? 'Ingreso' : 'Egreso'} de caja anulado (turno #${x.turno})`,
      detalle: x.motivo ? [`Era: ${x.motivo}`] : [], motivo: x.anulado_motivo ?? '',
    });
  }
  for (const x of d.movCashflow) {
    push({
      id: `otras-cashflow-${x.id}`, tipo: 'otras', fecha: iso(x.fecha), usuarioId: num(x.u), sucursalId: null, monto: r2(x.importe),
      titulo: `Cash Flow: ${x.tipo === 'ingreso' ? 'ingreso' : 'egreso'} anulado${x.concepto ? ` · ${x.concepto}` : ''}`,
      detalle: x.detalle ? [x.detalle] : [], motivo: x.motivo ?? '',
    });
  }
  for (const x of d.sobresDeshechos) {
    push({
      id: `otras-sobre-${x.id}`, tipo: 'otras', fecha: iso(x.fecha), usuarioId: num(x.u), sucursalId: num(x.suc), monto: r2(x.contado),
      titulo: `Control del sobre del turno #${x.turno} deshecho`, detalle: [], motivo: x.motivo ?? '',
    });
  }

  /*
   * LA TABLA `auditoria`: una fila por CAMPO. Lo que una persona tocó en el
   * mismo lugar en el mismo minuto es UN cambio («editó la ficha de Fulano:
   * nombre, CUIT y percepciones»), no tres renglones.
   */
  const grupos = new Map<string, any[]>();
  for (const x of d.cambios) {
    if (x.entidad === 'gasto' && x.ambito === 'Anulación') {
      push({
        id: `otras-gasto-${x.id}`, tipo: 'otras', fecha: iso(x.fecha), usuarioId: num(x.u), sucursalId: num(x.suc), monto: num(x.gasto_total) == null ? null : r2(x.gasto_total),
        titulo: `Gasto anulado: ${x.detalle}`, detalle: [], motivo: x.despues ?? '',
      });
      continue;
    }
    const k = `${x.u}|${x.entidad}|${x.ambito}|${String(iso(x.fecha)).slice(0, 16)}`;
    const a = grupos.get(k);
    if (a) a.push(x); else grupos.set(k, [x]);
  }
  for (const filas of grupos.values()) {
    const x = filas[0];
    const detalles = [...new Set(filas.map((y) => y.detalle).filter(Boolean))];
    const varios = detalles.length > 1;
    const linea = (y: any) => {
      const cambio = y.antes && y.despues ? `${y.antes} → ${y.despues}` : y.despues || (y.antes ? `${y.antes} → (vacío)` : '');
      return `${varios && y.detalle ? `${y.detalle} · ` : ''}${y.campo}${cambio ? `: ${cambio}` : ''}`;
    };
    push({
      id: `cambios-${x.id}`, tipo: 'cambios', fecha: iso(x.fecha), usuarioId: num(x.u), sucursalId: num(x.suc), monto: null,
      titulo: `${x.ambito}${varios ? ` · ${detalles.length} registros` : detalles[0] ? ` · ${detalles[0]}` : ''}`,
      detalle: [...filas.slice(0, 10).map(linea), ...(filas.length > 10 ? [`y ${filas.length - 10} cambios más`] : [])],
      motivo: '',
    });
  }
  return { eventos: ev, ajustes };
}

/* ============================================================================
 * POR PERSONA Y LLAMADOS DE ATENCIÓN
 * ========================================================================== */
interface Persona {
  usuarioId: number | null;
  cobradas: number; totalCobrado: number;
  anulacion: { n: number; monto: number };
  devolucion: { n: number; monto: number };
  a_mano: { n: number; monto: number };
  stock: { n: number; monto: number };
  caja: { faltantes: number; faltante: number; sobrantes: number; sobrante: number };
  retiro: { n: number; monto: number };
  otras: { n: number; monto: number };
  cambios: number;
}

function porPersona(eventos: EventoAuditoria[], cobradas: { u: number | null; n: number; total: number }[]): Persona[] {
  const m = new Map<number | null, Persona>();
  const de = (u: number | null) => {
    let p = m.get(u);
    if (!p) {
      p = { usuarioId: u, cobradas: 0, totalCobrado: 0, anulacion: { n: 0, monto: 0 }, devolucion: { n: 0, monto: 0 }, a_mano: { n: 0, monto: 0 },
        stock: { n: 0, monto: 0 }, caja: { faltantes: 0, faltante: 0, sobrantes: 0, sobrante: 0 }, retiro: { n: 0, monto: 0 }, otras: { n: 0, monto: 0 }, cambios: 0 };
      m.set(u, p);
    }
    return p;
  };
  for (const c of cobradas) { const p = de(c.u); p.cobradas += c.n; p.totalCobrado += c.total; }
  for (const e of eventos) {
    if (e.informativo) continue;
    const p = de(e.usuarioId);
    if (e.tipo === 'cambios') p.cambios += 1;
    else if (e.tipo === 'caja') {
      if ((e.monto ?? 0) < 0) { p.caja.faltantes += 1; p.caja.faltante += e.monto!; } else { p.caja.sobrantes += 1; p.caja.sobrante += e.monto ?? 0; }
    } else { p[e.tipo].n += 1; p[e.tipo].monto += e.monto ?? 0; }
  }
  const redondear = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, r2(v)]));
  return [...m.values()]
    .map((p) => ({
      ...p, totalCobrado: r2(p.totalCobrado),
      anulacion: redondear(p.anulacion), devolucion: redondear(p.devolucion), a_mano: redondear(p.a_mano),
      stock: redondear(p.stock), caja: redondear(p.caja), retiro: redondear(p.retiro), otras: redondear(p.otras),
    }) as Persona)
    /* Quien solo cobró y no tiene nada para mirar también figura: es la base contra la que se compara. */
    .sort((a, b) => b.cobradas - a.cobradas || (a.usuarioId ?? 0) - (b.usuarioId ?? 0));
}

/**
 * Tres reglas fijas, a la vista en la pantalla (nada de «inteligencia» que no
 * se pueda explicar):
 *   1. anula 3 o más ventas y, en proporción a lo que cobró, el doble o más que
 *      el resto del equipo (y al menos el 2 %);
 *   2. tuvo 2 o más faltantes de caja (cierres o sobres);
 *   3. un mismo producto, en un mismo local, con 3 o más ajustes o bajas.
 */
function armarAlertas(o: {
  eventos: EventoAuditoria[]; personas: Persona[]; cobradas: { n: number }[]; ajustes: AjusteSuelto[];
  usuarios: Map<number, string>; sucursales: Map<number, string>;
}) {
  const out: { regla: 'anulaciones' | 'faltantes' | 'stock'; usuarioId: number | null; texto: string }[] = [];
  const pct = (n: number) => `${PORCENTAJE.format(n * 100)} %`;
  const quien = (id: number | null) => (id ? o.usuarios.get(id) ?? `Usuario #${id}` : 'Sin usuario');
  const totCobradas = o.cobradas.reduce((s, c) => s + c.n, 0);
  const totAnuladas = o.eventos.filter((e) => e.tipo === 'anulacion').length;
  for (const p of o.personas) {
    if (p.anulacion.n < 3 || p.cobradas <= 0) continue;
    const suyo = p.anulacion.n / p.cobradas;
    const restoCobradas = totCobradas - p.cobradas;
    const resto = restoCobradas > 0 ? (totAnuladas - p.anulacion.n) / restoCobradas : null;
    if (suyo >= 0.02 && resto != null && suyo >= resto * 2) {
      out.push({ regla: 'anulaciones', usuarioId: p.usuarioId, texto: `${quien(p.usuarioId)} anuló ${p.anulacion.n} ventas por ${$(p.anulacion.monto)}: el ${pct(suyo)} de lo que cobró, contra el ${pct(resto)} del resto del equipo.` });
    }
  }
  for (const p of o.personas) {
    if (p.caja.faltantes >= 2) out.push({ regla: 'faltantes', usuarioId: p.usuarioId, texto: `${quien(p.usuarioId)} tuvo ${p.caja.faltantes} faltantes de caja (cierres o sobres) por ${$(p.caja.faltante)} en total.` });
  }
  const porProducto = new Map<string, { n: number; valor: number; producto: string; sucursalId: number | null }>();
  for (const a of o.ajustes) {
    const x = porProducto.get(a.clave) ?? { n: 0, valor: 0, producto: a.producto, sucursalId: a.sucursalId };
    x.n += 1; x.valor += a.valor;
    porProducto.set(a.clave, x);
  }
  [...porProducto.values()].filter((x) => x.n >= 3).sort((a, b) => b.n - a.n || a.valor - b.valor).slice(0, 5)
    .forEach((x) => out.push({
      regla: 'stock', usuarioId: null,
      texto: `${x.producto}${x.sucursalId ? ` en ${o.sucursales.get(x.sucursalId) ?? 'otro local'}` : ''}: ${x.n} ajustes o bajas en el período (${$(x.valor)}).`,
    }));
  return out;
}
