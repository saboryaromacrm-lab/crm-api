/**
 * STOCK PROVISORIO DE GRANEL (0138, 5/10/2026) — TEMPORAL
 * ============================================================================
 * Pedido del dueño: mientras el stock real del sistema no está confiable, un
 * operario cuenta A OJO cuántas BOLSAS CERRADAS hay de cada producto a granel
 * madre en el depósito, y administración lo asienta en esta planilla.
 *
 * Es una isla a propósito: no lee ni escribe `stock`, ventas ni compras, y
 * nada del sistema la lee a ella. Cada conteo se GUARDA (fecha, quién,
 * cuántas): la planilla muestra el último y el historial de cada producto.
 *
 * PARA ELIMINARLA: borrar esta carpeta, su línea en app.module, el panel
 * `StockProvisorioPanel` del ERP con su entrada en proveedores.config, la
 * clave del catálogo de permisos, y una migración que haga DROP de la tabla.
 */
import { BadRequestException, Body, Controller, Get, Inject, Injectable, Module, Param, ParseIntPipe, Post } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { sql } from 'drizzle-orm';
import { Auth, Permiso, type Sesion } from '../auth/auth.decoradores';
import { DRIZZLE, Database } from '../db/drizzle';
import { stockProvisorioConteos } from '../db/schema';

export const PERMISO_STOCK_PROVISORIO = 'proveedores.stock_provisorio';

class ConteoItemDto {
  @IsInt() productoId!: number;
  @IsInt() @Min(0) @Max(100000) bolsas!: number;
}
class ConteosDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(2000) @ValidateNested({ each: true }) @Type(() => ConteoItemDto) items!: ConteoItemDto[];
  @IsOptional() @IsString() @MaxLength(300) observacion?: string;
}

@Injectable()
export class StockProvisorioService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * La planilla: cada producto a granel madre que no está archivado, con su
   * categoría y el ÚLTIMO conteo (un lateral por el índice producto+id: una
   * sola consulta para los ~350 productos).
   */
  async planilla() {
    const r = await this.db.execute(sql`
      select p.id, p.nombre, p.codigo_propio as codigo, p.estado,
        coalesce(sc.nombre, 'Sin clasificar') as categoria, coalesce(m.nombre, '') as marca,
        u.bolsas, u.fecha, u.usuario, coalesce(n.n, 0) as conteos
      from productos p
      left join subcategorias sc on sc.id = p.subcategoria_id
      left join marcas m on m.id = p.marca_id
      left join lateral (
        select k.bolsas, k.fecha, us.nombre as usuario
        from stock_provisorio_conteos k left join usuarios us on us.id = k.usuario_id
        where k.producto_id = p.id order by k.id desc limit 1
      ) u on true
      left join lateral (select count(*)::int as n from stock_provisorio_conteos k where k.producto_id = p.id) n on true
      where p.tipo = 'granel' and p.estado <> 'archivado'
      order by (sc.nombre is null), sc.nombre, p.nombre`);
    return r.rows.map((x: any) => ({ ...x, bolsas: x.bolsas == null ? null : Number(x.bolsas), conteos: Number(x.conteos) || 0 }));
  }

  /** Asienta una tanda de conteos (lo que el operario dictó), todo junto o nada. */
  async asentar(dto: ConteosDto, usuarioId: number | null) {
    const porProducto = new Map<number, number>();
    for (const it of dto.items) porProducto.set(it.productoId, it.bolsas); // el mismo producto dos veces: vale el último
    const ids = [...porProducto.keys()];
    const validos = await this.db.execute(sql`
      select id from productos where id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}) and tipo = 'granel'`);
    const ok = new Set(validos.rows.map((x: any) => Number(x.id)));
    const malos = ids.filter((i) => !ok.has(i));
    if (malos.length) throw new BadRequestException(`Hay ${malos.length} producto(s) que no son granel madre o no existen: recargá la planilla.`);
    const observacion = String(dto.observacion ?? '').trim();
    await this.db.insert(stockProvisorioConteos).values(
      ids.map((productoId) => ({ productoId, bolsas: porProducto.get(productoId)!, usuarioId, observacion })),
    );
    return { ok: true, guardados: ids.length };
  }

  /** Todos los conteos de un producto, del más nuevo al más viejo. */
  async historial(productoId: number) {
    const r = await this.db.execute(sql`
      select k.id, k.bolsas, k.fecha, k.observacion, coalesce(u.nombre, '') as usuario
      from stock_provisorio_conteos k left join usuarios u on u.id = k.usuario_id
      where k.producto_id = ${productoId} order by k.id desc limit 200`);
    return r.rows;
  }
}

@Controller('stock-provisorio')
@Permiso(PERMISO_STOCK_PROVISORIO)
export class StockProvisorioController {
  constructor(private readonly svc: StockProvisorioService) {}

  @Get() planilla() { return this.svc.planilla(); }
  @Post('conteos') asentar(@Body() dto: ConteosDto, @Auth() s: Sesion) { return this.svc.asentar(dto, s?.usuarioId ?? null); }
  @Get(':productoId/historial') historial(@Param('productoId', ParseIntPipe) id: number) { return this.svc.historial(id); }
}

@Module({ controllers: [StockProvisorioController], providers: [StockProvisorioService] })
export class StockProvisorioModule {}
