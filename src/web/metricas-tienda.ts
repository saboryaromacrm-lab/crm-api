/**
 * TIENDA ONLINE › MÉTRICAS (0179, 18/10/2026, pedido del dueño: «todas las
 * métricas que se puedan medir, por separado mayorista y minorista»).
 * ============================================================================
 * Todo sale de lo que el sistema ya guarda, por modo y por período:
 *
 *   · `web_eventos`      — la telemetría anónima del sitio (vistas, productos
 *                          mirados, agregados al carrito, búsquedas, pedidos).
 *   · `presupuestos`     — los pedidos web (origen 'web', `modo_tienda`), con
 *                          sus renglones para productos, categorías y marcas.
 *   · `tienda_accesos` / `tienda_compradores` / `tienda_sesiones` — los
 *                          clientes de cada modo y sus ingresos.
 *
 * Son consultas AGREGADAS en Postgres (GROUP BY sobre los índices por modo y
 * fecha), nunca "bajar todo y contar en Node": tardan lo mismo con un mes que
 * con el año entero. Cada número del resumen viene con el del período
 * anterior del mismo largo, para leer si sube o baja.
 *
 * Los pedidos web anteriores a la minorista (16/10/2026) no tienen
 * `modo_tienda`: cuentan como mayoristas, que es lo que eran.
 */
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import { PASOS, type Paso, periodos, r2, variacion } from '../metricas/consultas';
import { ZONA_AR, sumarDias } from '../cafeteria/cuenta';

export type ModoTienda = 'mayorista' | 'minorista';
export interface FiltroTienda { modo: ModoTienda; desde: string; hasta: string; paso: Paso }

const SOLO_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DIAS = 400;
const MS_DIA = 86_400_000;
const diasDe = (desde: string, hasta: string) => Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / MS_DIA) + 1;
const N = (x: unknown) => Number(x ?? 0) || 0;
const filas = (r: any): any[] => r.rows ?? r;
/** Parte ÷ total en %, o null sin total. */
const pct = (parte: number, total: number) => (total > 0 ? r2((parte / total) * 100) : null);
/** Un número del resumen: ahora, antes y cuánto cambió. */
const cmp = (ahora: number, antes: number) => ({ ahora: r2(ahora), antes: r2(antes), variacion: variacion(ahora, antes) });

/** El día argentino de una fecha con zona: todas las agrupaciones y los rangos van en hora local. */
const diaAr = (col: any) => sql`(${col} at time zone ${ZONA_AR})::date`;

/**
 * Lo que pide la pantalla, validado. Sin fechas: los últimos 30 días. El paso
 * (día / semana / mes) se elige solo según el largo, salvo que venga puesto.
 */
export function filtroTienda(q: Record<string, any>): FiltroTienda {
  const modo: ModoTienda = q.modo === 'minorista' ? 'minorista' : q.modo === 'mayorista' ? 'mayorista' : (() => { throw new BadRequestException('El modo va: mayorista o minorista.'); })();
  const hoy = new Date().toLocaleDateString('en-CA', { timeZone: ZONA_AR });
  const hasta = SOLO_FECHA.test(String(q.hasta)) ? String(q.hasta) : hoy;
  const desde = SOLO_FECHA.test(String(q.desde)) ? String(q.desde) : sumarDias(hasta, -29);
  if (desde > hasta) throw new BadRequestException('«Desde» no puede ser después de «hasta».');
  const dias = diasDe(desde, hasta);
  if (dias > MAX_DIAS) throw new BadRequestException(`El período no puede pasar de ${MAX_DIAS} días.`);
  const paso: Paso = q.paso in PASOS ? q.paso : dias <= 45 ? 'dia' : dias <= 180 ? 'semana' : 'mes';
  return { modo, desde, hasta, paso };
}

@Injectable()
export class MetricasTiendaService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  private q(consulta: any) { return this.db.execute(consulta).then(filas); }

  /* ------------------------------ condiciones ------------------------------ */

  /** Los eventos del modo en el período. */
  private eventos(f: FiltroTienda) {
    return sql`modo = ${f.modo} and ${diaAr(sql`fecha`)} between ${f.desde}::date and ${f.hasta}::date`;
  }

  /** Los pedidos web del modo en el período (los de antes de la minorista cuentan como mayoristas). */
  private pedidos(f: FiltroTienda) {
    return sql`origen = 'web' and coalesce(modo_tienda, 'mayorista') = ${f.modo} and ${diaAr(sql`fecha`)} between ${f.desde}::date and ${f.hasta}::date`;
  }

  /** Quién compró: la ficha del cliente (mayorista) o el WhatsApp (minorista); con lo que haya. */
  private readonly comprador = sql`coalesce(cliente_id::text, web_cliente->>'telefono', web_cliente->>'dni', '')`;

  /* ------------------------------ los números ------------------------------ */

  /** Las sumas del período: lo que se compara contra el período anterior. */
  private async sumas(f: FiltroTienda) {
    const [[ev], [pe]] = await Promise.all([
      this.q(sql`
        select count(*) filter (where tipo = 'vista_pagina') as vistas,
          count(distinct sesion) filter (where sesion <> '') as sesiones,
          count(distinct sesion) filter (where tipo = 'vista_producto') as ses_producto,
          count(distinct sesion) filter (where tipo = 'agregar_carrito') as ses_carrito,
          count(distinct sesion) filter (where tipo = 'pedido') as ses_pedido,
          count(*) filter (where tipo = 'agregar_carrito') as carritos,
          count(*) filter (where tipo = 'busqueda') as busquedas,
          coalesce(sum(segundos) filter (where tipo = 'vista_producto'), 0) as segundos
        from web_eventos where ${this.eventos(f)}`),
      this.q(sql`
        select count(*) as pedidos, coalesce(sum(total), 0) as total,
          count(*) filter (where estado <> 'cancelado') as vivos,
          coalesce(sum(total) filter (where estado <> 'cancelado'), 0) as total_vivo,
          count(*) filter (where estado = 'cerrado') as cerrados,
          coalesce(sum(total) filter (where estado = 'cerrado'), 0) as total_cerrado,
          count(*) filter (where estado = 'cancelado') as cancelados,
          count(distinct ${this.comprador}) filter (where estado <> 'cancelado') as compradores
        from presupuestos where ${this.pedidos(f)}`),
    ]);
    const vistas = N(ev.vistas); const sesiones = N(ev.sesiones);
    const vivos = N(pe.vivos); const totalVivo = N(pe.total_vivo);
    return {
      vistas, sesiones,
      paginasPorSesion: sesiones ? r2(vistas / sesiones) : 0,
      sesProducto: N(ev.ses_producto), sesCarrito: N(ev.ses_carrito), sesPedido: N(ev.ses_pedido),
      carritos: N(ev.carritos), busquedas: N(ev.busquedas), segundos: N(ev.segundos),
      pedidos: N(pe.pedidos), total: N(pe.total), vivos, totalVivo,
      cerrados: N(pe.cerrados), totalCerrado: N(pe.total_cerrado), cancelados: N(pe.cancelados),
      compradores: N(pe.compradores),
      ticket: vivos ? r2(totalVivo / vivos) : 0,
    };
  }

  /** Visitas, sesiones, pedidos y plata por día / semana / mes, con los períodos vacíos en cero. */
  private async serie(f: FiltroTienda) {
    const trunc = (col: any) => sql`date_trunc(${PASOS[f.paso]}, ${col} at time zone ${ZONA_AR})::date`;
    const [ev, pe] = await Promise.all([
      this.q(sql`select ${trunc(sql`fecha`)} as p, count(*) filter (where tipo = 'vista_pagina') as vistas,
        count(distinct sesion) filter (where sesion <> '') as sesiones
        from web_eventos where ${this.eventos(f)} group by 1`),
      this.q(sql`select ${trunc(sql`fecha`)} as p, count(*) as pedidos, coalesce(sum(total), 0) as total
        from presupuestos where ${this.pedidos(f)} and estado <> 'cancelado' group by 1`),
    ]);
    const clave = (r: any) => String(r.p).slice(0, 10);
    const e = new Map(ev.map((r) => [clave(r), r]));
    const p = new Map(pe.map((r) => [clave(r), r]));
    return periodos(f.desde, f.hasta, f.paso).map((per) => ({
      periodo: per,
      vistas: N(e.get(per)?.vistas), sesiones: N(e.get(per)?.sesiones),
      pedidos: N(p.get(per)?.pedidos), total: r2(N(p.get(per)?.total)),
    }));
  }

  /** A qué hora y qué día de la semana se navega y se pide, y las páginas más vistas. */
  private async trafico(f: FiltroTienda) {
    const hora = (col: any) => sql`extract(hour from ${col} at time zone ${ZONA_AR})::int`;
    const dow = (col: any) => sql`extract(isodow from ${col} at time zone ${ZONA_AR})::int`;
    const [horas, dias, paginas, pHoras, pDias] = await Promise.all([
      this.q(sql`select ${hora(sql`fecha`)} as k, count(*) as n from web_eventos where ${this.eventos(f)} and tipo = 'vista_pagina' group by 1`),
      this.q(sql`select ${dow(sql`fecha`)} as k, count(*) as n from web_eventos where ${this.eventos(f)} and tipo = 'vista_pagina' group by 1`),
      this.q(sql`select split_part(ruta, '?', 1) as ruta, count(*) as vistas, count(distinct sesion) as sesiones
        from web_eventos where ${this.eventos(f)} and tipo = 'vista_pagina' group by 1 order by 2 desc limit 15`),
      this.q(sql`select ${hora(sql`fecha`)} as k, count(*) as n from presupuestos where ${this.pedidos(f)} and estado <> 'cancelado' group by 1`),
      this.q(sql`select ${dow(sql`fecha`)} as k, count(*) as n from presupuestos where ${this.pedidos(f)} and estado <> 'cancelado' group by 1`),
    ]);
    const serie = (rs: any[], largo: number, desde: number) => {
      const m = new Map(rs.map((r) => [N(r.k), N(r.n)]));
      return Array.from({ length: largo }, (_, i) => m.get(i + desde) ?? 0);
    };
    return {
      /** 24 valores, de las 0 a las 23. */
      vistasPorHora: serie(horas, 24, 0), pedidosPorHora: serie(pHoras, 24, 0),
      /** 7 valores, de lunes a domingo. */
      vistasPorDia: serie(dias, 7, 1), pedidosPorDia: serie(pDias, 7, 1),
      paginas: paginas.map((r) => ({ ruta: String(r.ruta || '/'), vistas: N(r.vistas), sesiones: N(r.sesiones) })),
    };
  }

  /** Cómo terminaron los pedidos, cómo se entregan y de cuánto son. */
  private async detallePedidos(f: FiltroTienda) {
    const [estados, entregas, [tam]] = await Promise.all([
      this.q(sql`select estado, count(*) as n, coalesce(sum(total), 0) as total from presupuestos where ${this.pedidos(f)} group by 1`),
      this.q(sql`select entrega, count(*) as n, coalesce(sum(total), 0) as total,
        count(*) filter (where (web_cliente->>'envioGratis') = 'true') as gratis
        from presupuestos where ${this.pedidos(f)} and estado <> 'cancelado' group by 1`),
      this.q(sql`select coalesce(min(total), 0) as minimo, coalesce(max(total), 0) as maximo,
        coalesce(percentile_cont(0.5) within group (order by total), 0) as mediana,
        coalesce(avg(n), 0) as renglones
        from presupuestos p left join (select presupuesto_id, count(*) as n from presupuesto_items group by 1) i on i.presupuesto_id = p.id
        where ${this.pedidos(f)} and estado <> 'cancelado'`),
    ]);
    const porEstado = Object.fromEntries(estados.map((r) => [String(r.estado), { n: N(r.n), total: r2(N(r.total)) }]));
    return {
      /** pendiente (sin mirar) · enviado (aceptado) · confirmado · cerrado (se hizo venta) · cancelado (rechazado). */
      porEstado,
      porEntrega: entregas.map((r) => ({ entrega: String(r.entrega), n: N(r.n), total: r2(N(r.total)), gratis: N(r.gratis) })),
      ticket: { minimo: r2(N(tam?.minimo)), mediana: r2(N(tam?.mediana)), maximo: r2(N(tam?.maximo)), renglones: r2(N(tam?.renglones)) },
    };
  }

  /** Los clientes del modo: altas, ingresos, quién compra, quién repite y los que más compran. */
  private async clientes(f: FiltroTienda) {
    const rango = (col: any) => sql`${diaAr(col)} between ${f.desde}::date and ${f.hasta}::date`;
    const may = f.modo === 'mayorista';
    const [[altas], [ing], [rep], top] = await Promise.all([
      may
        ? this.q(sql`select count(*) filter (where ${rango(sql`creado_en`)}) as altas,
            count(*) filter (where estado = 'habilitado' and ${rango(sql`resuelto_en`)}) as habilitados,
            count(*) filter (where estado = 'bloqueado' and ${rango(sql`resuelto_en`)}) as bloqueados,
            count(*) filter (where estado = 'pendiente') as pendientes,
            count(*) filter (where estado = 'habilitado') as habilitados_total
            from tienda_accesos`)
        : this.q(sql`select count(*) filter (where ${rango(sql`creado_en`)}) as altas,
            count(*) filter (where not bloqueado) as habilitados_total,
            count(*) filter (where bloqueado) as bloqueados_total
            from tienda_compradores`),
      this.q(sql`select count(*) as ingresos, count(distinct ${may ? sql`acceso_id` : sql`comprador_id`}) as quienes
        from tienda_sesiones where ${may ? sql`acceso_id` : sql`comprador_id`} is not null and ${rango(sql`creado_en`)}`),
      /* Quién compró más de una vez en el período, y quién compró por primera vez en la tienda. */
      this.q(sql`with por_cliente as (
          select ${this.comprador} as c, count(*) as n from presupuestos where ${this.pedidos(f)} and estado <> 'cancelado' and ${this.comprador} <> '' group by 1)
        select count(*) filter (where n >= 2) as repiten, count(*) as compradores,
          count(*) filter (where not exists (
            select 1 from presupuestos x where x.origen = 'web' and coalesce(x.modo_tienda, 'mayorista') = ${f.modo}
              and x.estado <> 'cancelado' and ${sql`coalesce(x.cliente_id::text, x.web_cliente->>'telefono', x.web_cliente->>'dni', '')`} = por_cliente.c
              and ${diaAr(sql`x.fecha`)} < ${f.desde}::date)) as nuevos
        from por_cliente`),
      this.q(sql`select ${this.comprador} as c,
          max(coalesce(cl.nombre, trim(concat(web_cliente->>'nombre', ' ', web_cliente->>'apellido')))) as nombre,
          max(cl.id) as cliente_id, count(*) as pedidos, coalesce(sum(p.total), 0) as total, max(p.fecha) as ultimo
        from presupuestos p left join clientes cl on cl.id = p.cliente_id
        where ${this.pedidos(f)} and estado <> 'cancelado' and ${this.comprador} <> ''
        group by 1 order by 5 desc limit 10`),
    ]);
    return {
      altas: N(altas?.altas),
      habilitados: may ? N(altas?.habilitados) : null,
      bloqueados: may ? N(altas?.bloqueados) : N(altas?.bloqueados_total),
      pendientesAhora: may ? N(altas?.pendientes) : null,
      habilitadosTotal: N(altas?.habilitados_total),
      ingresos: N(ing?.ingresos), quienesIngresaron: N(ing?.quienes),
      compradores: N(rep?.compradores), repiten: N(rep?.repiten), nuevos: N(rep?.nuevos),
      top: top.map((r) => ({ nombre: String(r.nombre || '—'), clienteId: r.cliente_id ? N(r.cliente_id) : null, pedidos: N(r.pedidos), total: r2(N(r.total)), ultimo: r.ultimo })),
    };
  }

  /** Qué se mira, qué se carga y qué se pide: por producto, categoría y marca. */
  private async productos(f: FiltroTienda) {
    /* El importe del renglón como se cotizó: neto × (1 − desc) × (1 + IVA). */
    const importe = sql`i.cantidad * i.precio_lista * (1 - i.descuento / 100) * (1 + i.iva / 100)`;
    const pedidosVivos = sql`select id from presupuestos where ${this.pedidos(f)} and estado <> 'cancelado'`;
    const [ev, pe, cats, marcasR, busq] = await Promise.all([
      this.q(sql`select producto_id, count(*) filter (where tipo = 'vista_producto') as vistas,
          coalesce(sum(segundos) filter (where tipo = 'vista_producto'), 0) as segundos,
          count(*) filter (where tipo = 'agregar_carrito') as carrito
        from web_eventos where ${this.eventos(f)} and producto_id is not null and tipo in ('vista_producto', 'agregar_carrito')
        group by 1 order by 2 desc, 4 desc limit 300`),
      this.q(sql`select i.producto_id, count(distinct i.presupuesto_id) as pedidos, coalesce(sum(i.cantidad), 0) as unidades, coalesce(sum(${importe}), 0) as total
        from presupuesto_items i where i.presupuesto_id in (${pedidosVivos}) group by 1 order by 4 desc limit 300`),
      this.q(sql`select coalesce(c.nombre, 'Sin categoría') as nombre, count(distinct i.presupuesto_id) as pedidos, coalesce(sum(i.cantidad), 0) as unidades, coalesce(sum(${importe}), 0) as total
        from presupuesto_items i join productos pr on pr.id = i.producto_id left join categorias c on c.id = pr.categoria_id
        where i.presupuesto_id in (${pedidosVivos}) group by 1 order by 4 desc limit 12`),
      this.q(sql`select coalesce(m.nombre, 'Sin marca') as nombre, count(distinct i.presupuesto_id) as pedidos, coalesce(sum(i.cantidad), 0) as unidades, coalesce(sum(${importe}), 0) as total
        from presupuesto_items i join productos pr on pr.id = i.producto_id left join marcas m on m.id = pr.marca_id
        where i.presupuesto_id in (${pedidosVivos}) group by 1 order by 4 desc limit 12`),
      this.q(sql`select min(ruta) as termino, count(*) as veces from web_eventos where ${this.eventos(f)} and tipo = 'busqueda' and ruta <> ''
        group by lower(trim(ruta)) order by 2 desc limit 30`),
    ]);
    const ids = [...new Set([...ev.map((r) => N(r.producto_id)), ...pe.map((r) => N(r.producto_id))])];
    const nombres = ids.length
      ? await this.q(sql`select pr.id, pr.nombre, m.nombre as marca from productos pr left join marcas m on m.id = pr.marca_id where pr.id in ${ids}`)
      : [];
    const nombre = new Map(nombres.map((r) => [N(r.id), { nombre: String(r.nombre), marca: r.marca ? String(r.marca) : '' }]));
    const e = new Map(ev.map((r) => [N(r.producto_id), r]));
    const p = new Map(pe.map((r) => [N(r.producto_id), r]));
    const ranking = ids.map((id) => {
      const x = e.get(id); const y = p.get(id);
      const vistas = N(x?.vistas);
      return {
        id, nombre: nombre.get(id)?.nombre ?? `Producto #${id}`, marca: nombre.get(id)?.marca ?? '',
        vistas, segundosProm: vistas ? r2(N(x?.segundos) / vistas) : 0, carrito: N(x?.carrito),
        pedidos: N(y?.pedidos), unidades: r2(N(y?.unidades)), total: r2(N(y?.total)),
      };
    }).sort((a, b) => b.total - a.total || b.unidades - a.unidades || b.vistas - a.vistas);
    const grupo = (rs: any[]) => rs.map((r) => ({ nombre: String(r.nombre), pedidos: N(r.pedidos), unidades: r2(N(r.unidades)), total: r2(N(r.total)) }));
    return {
      ranking,
      categorias: grupo(cats), marcas: grupo(marcasR),
      busquedas: busq.map((r) => ({ termino: String(r.termino), veces: N(r.veces) })),
    };
  }

  /* ------------------------------ la respuesta ------------------------------ */

  async metricas(f: FiltroTienda) {
    const dias = diasDe(f.desde, f.hasta);
    const antes: FiltroTienda = { ...f, desde: sumarDias(f.desde, -dias), hasta: sumarDias(f.desde, -1) };
    const [ahora, previo, serie, trafico, pedidos, clientes, productos] = await Promise.all([
      this.sumas(f), this.sumas(antes), this.serie(f), this.trafico(f), this.detallePedidos(f), this.clientes(f), this.productos(f),
    ]);
    return {
      periodo: { modo: f.modo, desde: f.desde, hasta: f.hasta, paso: f.paso, dias, antes: { desde: antes.desde, hasta: antes.hasta } },
      resumen: {
        visitas: cmp(ahora.vistas, previo.vistas),
        sesiones: cmp(ahora.sesiones, previo.sesiones),
        paginasPorSesion: cmp(ahora.paginasPorSesion, previo.paginasPorSesion),
        carritos: cmp(ahora.carritos, previo.carritos),
        pedidos: cmp(ahora.vivos, previo.vivos),
        total: cmp(ahora.totalVivo, previo.totalVivo),
        ticket: cmp(ahora.ticket, previo.ticket),
        cerrados: cmp(ahora.cerrados, previo.cerrados),
        totalCerrado: cmp(ahora.totalCerrado, previo.totalCerrado),
        cancelados: cmp(ahora.cancelados, previo.cancelados),
        compradores: cmp(ahora.compradores, previo.compradores),
        /** Pedidos vivos cada 100 sesiones. */
        conversion: cmp(N(pct(ahora.vivos, ahora.sesiones)), N(pct(previo.vivos, previo.sesiones))),
        busquedas: cmp(ahora.busquedas, previo.busquedas),
      },
      /** Sesiones → miraron un producto → cargaron el carrito → mandaron el pedido (por sesión, de la telemetría). */
      embudo: {
        sesiones: ahora.sesiones, conProducto: ahora.sesProducto, conCarrito: ahora.sesCarrito, conPedido: ahora.sesPedido,
        pctProducto: pct(ahora.sesProducto, ahora.sesiones), pctCarrito: pct(ahora.sesCarrito, ahora.sesiones), pctPedido: pct(ahora.sesPedido, ahora.sesiones),
        /** De los que cargaron el carrito, cuántos pidieron. */
        pctCarritoAPedido: pct(ahora.sesPedido, ahora.sesCarrito),
        tasaCancelacion: pct(ahora.cancelados, ahora.pedidos),
        tasaCierre: pct(ahora.cerrados, ahora.vivos),
      },
      serie, trafico, pedidos, clientes, productos,
    };
  }
}
