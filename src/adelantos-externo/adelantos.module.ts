/**
 * `GET /api/externo/adelantos?desde=AAAA-MM-DD&hasta=AAAA-MM-DD`
 *
 * Los adelantos de sueldo (caja central + cajas de los locales) para la app de
 * sueldos del dueño. Reglas y forma de la respuesta en `adelantos.ts`.
 *
 * ACCESO: son datos de sueldos, así que NO es abierto como el catálogo.
 *   · Otra aplicación: cabecera `X-Clave-Servicio` con el valor de la variable
 *     `SUELDOS_API_KEY` del servidor (la carga el dueño en Dokploy). Sin esa
 *     variable la puerta no existe y solo entra una sesión del ERP.
 *   · Una sesión del ERP con permiso de Cash Flow (para probar desde el panel).
 * Solo lectura: no hay forma de cargar ni anular nada por acá.
 */
import { BadRequestException, Controller, Get, Inject, Injectable, Module, Query } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ClaveServicio, Permiso } from '../auth/auth.decoradores';
import { DRIZZLE, Database } from '../db/drizzle';
import { hoyAr } from '../cafeteria/cuenta';
import { PERMISO_CASHFLOW } from '../cashflow/a-controlar';
import { esConceptoAdelanto } from '../cashflow/conceptos';
import { type Adelanto, armarRespuesta, detalleDeMotivo, rangoPedido } from './adelantos';

const ZONA = 'America/Argentina/Buenos_Aires';
const iso = (v: any) => (v == null ? null : new Date(v).toISOString());
const empleadoDe = (x: any) => (x.emp_id == null ? null
  : { id: Number(x.emp_id), nombre: String(x.emp_nombre), usuarioId: x.emp_usuario == null ? null : Number(x.emp_usuario) });

@Injectable()
export class AdelantosExternoService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async listar(q: { desde?: string; hasta?: string }) {
    const rango = rangoPedido(q, hoyAr());
    if ('error' in rango) throw new BadRequestException(rango.error);

    const todos: any = await this.db.execute(sql`select id, nombre, tipo from cashflow_conceptos order by id`);
    const conceptos = (todos.rows as any[]).filter(esConceptoAdelanto).map((c) => ({ id: Number(c.id), nombre: String(c.nombre) }));
    if (!conceptos.length) return armarRespuesta([], rango, [], new Date().toISOString());
    const ids = sql.join(conceptos.map((c) => sql`${c.id}`), sql`, `);
    const desde = sql`(${rango.desde}::date::timestamp at time zone ${ZONA})`;
    /* El empleado elegido (0221), con su nombre de hoy. Los de antes no tienen: solo el detalle. */
    const empleado = sql`p.id as emp_id, coalesce(pu.nombre, p.nombre) as emp_nombre, p.usuario_id as emp_usuario`;
    const conEmpleado = sql`left join personal p on p.id = m.personal_id left join usuarios pu on pu.id = p.usuario_id`;
    const hasta = sql`((${rango.hasta}::date + 1)::timestamp at time zone ${ZONA})`;

    const [central, locales]: any[] = await Promise.all([
      this.db.execute(sql`
        select m.id, m.fecha, to_char(m.fecha at time zone ${ZONA}, 'YYYY-MM-DD') as dia, m.importe, m.detalle,
          c.nombre as concepto, u.nombre as usuario, m.anulado_en, m.anulado_motivo, ${empleado}
        from cashflow_movimientos m
        join cashflow_conceptos c on c.id = m.concepto_id
        left join usuarios u on u.id = m.usuario_id ${conEmpleado}
        where m.tipo = 'egreso' and m.concepto_id in (${ids}) and m.fecha >= ${desde} and m.fecha < ${hasta}`),
      this.db.execute(sql`
        select m.id, m.fecha, to_char(m.fecha at time zone ${ZONA}, 'YYYY-MM-DD') as dia, m.importe, m.motivo,
          c.nombre as concepto, u.nombre as usuario, m.anulado_en, m.anulado_motivo,
          cs.id as turno, cs.sucursal_id, su.nombre as sucursal, ${empleado}
        from caja_movimientos m
        join cashflow_conceptos c on c.id = m.concepto_id
        join caja_sesiones cs on cs.id = m.caja_sesion_id
        join sucursales su on su.id = cs.sucursal_id
        left join usuarios u on u.id = m.usuario_id ${conEmpleado}
        where m.tipo = 'egreso' and m.concepto_id in (${ids}) and m.fecha >= ${desde} and m.fecha < ${hasta}`),
    ]);

    const filas: Adelanto[] = [
      ...(central.rows as any[]).map((x): Adelanto => ({
        id: `cashflow-${x.id}`, origen: 'cashflow', movimientoId: Number(x.id),
        fecha: iso(x.fecha)!, dia: x.dia, importe: Number(x.importe), detalle: String(x.detalle ?? '').trim(), concepto: x.concepto,
        lugar: 'Caja central (Cash Flow)', sucursalId: null, turnoCajaId: null, cargadoPor: x.usuario ?? '',
        anulado: x.anulado_en != null, anuladoEn: iso(x.anulado_en), anuladoMotivo: x.anulado_en != null ? (x.anulado_motivo || '') : null,
        empleado: empleadoDe(x),
      })),
      ...(locales.rows as any[]).map((x): Adelanto => ({
        id: `caja-${x.id}`, origen: 'caja', movimientoId: Number(x.id),
        fecha: iso(x.fecha)!, dia: x.dia, importe: Number(x.importe), detalle: detalleDeMotivo(x.motivo, x.concepto), concepto: x.concepto,
        lugar: x.sucursal, sucursalId: Number(x.sucursal_id), turnoCajaId: Number(x.turno), cargadoPor: x.usuario ?? '',
        anulado: x.anulado_en != null, anuladoEn: iso(x.anulado_en), anuladoMotivo: x.anulado_en != null ? (x.anulado_motivo || '') : null,
        empleado: empleadoDe(x),
      })),
    ];
    return armarRespuesta(filas, rango, conceptos, new Date().toISOString());
  }
}

@Controller('externo/adelantos')
export class AdelantosExternoController {
  constructor(private readonly svc: AdelantosExternoService) {}

  @Get()
  @ClaveServicio('SUELDOS_API_KEY')
  @Permiso(PERMISO_CASHFLOW)
  listar(@Query('desde') desde?: string, @Query('hasta') hasta?: string) {
    return this.svc.listar({ desde, hasta });
  }
}

@Module({
  controllers: [AdelantosExternoController],
  providers: [AdelantosExternoService],
})
export class AdelantosExternoModule {}
