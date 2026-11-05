/**
 * VENTAS › CARGADOS A MANO (5/11/2026, pedido del dueño)
 * ============================================================================
 * Lo que los cajeros cobraron con «Cargo extra» escribiendo el nombre en vez de
 * elegir el producto («CARAMELOS», «paprika»…): no descuenta stock, no tiene
 * costo y no aparece en ninguna métrica por producto. Acá se ve cada uno, con
 * su precio, el cajero, el local y la venta, para corregir la costumbre y dar
 * de alta lo que falte.
 *
 * Quedan afuera los cargos que arma el sistema solo: el recargo por cuotas y
 * el envío a domicilio de los presupuestos de la tienda. Las notas de crédito
 * restan. Mismo permiso que el listado de Ventas; quien no es admin ve solo
 * su local.
 */
import { BadRequestException, Controller, Get, Inject, Injectable, Module, Query } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Auth, Permiso, type Sesion } from '../auth/auth.decoradores';
import { esJefe } from '../auth/auth.guard';
import { DRIZZLE, Database } from '../db/drizzle';
import { etiquetaVenta } from './etiqueta';

const ZONA = 'America/Argentina/Buenos_Aires';
const TOPE = 5000;
/** Los que escribe el sistema, no el cajero. */
export const DEL_SISTEMA = ['^Recargo [0-9]+ cuotas? [(]', '^Envío a domicilio'];
const esDia = (v?: string): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(`${v}T12:00:00Z`).getTime());

@Injectable()
export class AManoService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async listar(f: { desde: string; hasta: string; sucursalId?: number | null; usuarioId?: number | null; q?: string }) {
    const q = (f.q ?? '').trim();
    const r: any = await this.db.execute(sql`
      select e.id, v.id as "ventaId", to_char(v.fecha at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as fecha, v.tipo::text as tipo, v.punto_venta as "puntoVenta", v.numero,
        v.sucursal_id as "sucursalId", coalesce(s.nombre, '') as sucursal,
        v.usuario_id as "usuarioId", coalesce(u.nombre, '') as cajero,
        e.concepto, e.iva,
        e.importe * (case when v.tipo::text like 'nota_credito%' then -1 else 1 end) as neto,
        round((e.importe * (1 + e.iva / 100) * (case when v.tipo::text like 'nota_credito%' then -1 else 1 end))::numeric, 2)::float8 as cobrado
      from venta_extras e
      join ventas v on v.id = e.venta_id
      left join sucursales s on s.id = v.sucursal_id
      left join usuarios u on u.id = v.usuario_id
      where v.estado in ('confirmada', 'pendiente_cae')
        and v.fecha >= (${f.desde}::date::timestamp at time zone ${ZONA})
        and v.fecha < ((${f.hasta}::date + 1)::timestamp at time zone ${ZONA})
        and e.concepto !~ ${DEL_SISTEMA[0]} and e.concepto !~ ${DEL_SISTEMA[1]}
        ${f.sucursalId ? sql`and v.sucursal_id = ${f.sucursalId}` : sql``}
        ${f.usuarioId ? sql`and v.usuario_id = ${f.usuarioId}` : sql``}
        ${q ? sql`and e.concepto ilike ${`%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`}` : sql``}
      order by v.fecha desc, e.id desc
      limit ${TOPE + 1}`);
    const filas = (r.rows ?? r) as any[];
    const lista = filas.slice(0, TOPE).map((x) => ({
      ...x, neto: Number(x.neto), iva: Number(x.iva), cobrado: Number(x.cobrado),
      venta: etiquetaVenta({ tipo: x.tipo, puntoVenta: x.puntoVenta, numero: x.numero }),
    }));
    const suma = (k: 'neto' | 'cobrado') => Math.round(lista.reduce((a, x) => a + x[k], 0) * 100) / 100;
    return {
      desde: f.desde, hasta: f.hasta, recortado: filas.length > TOPE,
      filas: lista,
      total: { renglones: lista.length, neto: suma('neto'), cobrado: suma('cobrado'), sinIva: lista.filter((x) => !(x.iva > 0)).length },
    };
  }
}

@Controller('ventas-a-mano')
@Permiso('ventas.listado')
export class AManoController {
  constructor(private readonly svc: AManoService) {}

  @Get()
  listar(
    @Auth() sesion: Sesion,
    @Query('desde') desde?: string, @Query('hasta') hasta?: string,
    @Query('sucursalId') sucursalId?: string, @Query('usuarioId') usuarioId?: string, @Query('q') q?: string,
  ) {
    if (!esDia(desde) || !esDia(hasta)) throw new BadRequestException('Elegí las fechas desde y hasta.');
    if (hasta < desde) throw new BadRequestException('La fecha «hasta» es anterior a «desde».');
    return this.svc.listar({
      desde, hasta, q,
      /* Quien no es admin ve solo su local, como en el listado de Ventas. */
      sucursalId: esJefe(sesion) ? (Number(sucursalId) || null) : sesion.sucursalId,
      usuarioId: Number(usuarioId) || null,
    });
  }
}

@Module({ controllers: [AManoController], providers: [AManoService] })
export class AManoModule {}
