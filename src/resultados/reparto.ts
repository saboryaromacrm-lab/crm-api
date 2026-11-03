/**
 * REPARTIR UN GASTO ENTRE LOCALES POR PORCENTAJE (0216) — lo que comparten la
 * plantilla de un gasto fijo (Gastos) y el empleado (Resultados): el DTO y la
 * validación contra la base. La regla pura está en `normalizarReparto`.
 */
import { BadRequestException } from '@nestjs/common';
import { IsInt, IsNumber, Max, Min } from 'class-validator';
import { inArray } from 'drizzle-orm';
import type { Database } from '../db/drizzle';
import { sucursales } from '../db/schema';
import { normalizarReparto, type RepartoLocal } from './reglas';

export class RepartoDto {
  @IsInt() sucursalId!: number;
  @IsNumber() @Min(0) @Max(100) pct!: number;
}

/**
 * El reparto limpio, o null si no hay. Los locales tienen que existir y estar
 * activos; uno que ya estaba en el reparto (`antes`) se acepta aunque haya
 * cerrado, para poder editar lo demás sin trabarse.
 */
export async function exigirReparto(
  db: Pick<Database, 'select'>, reparto: RepartoLocal[] | null | undefined, antes: RepartoLocal[] | null = null,
): Promise<RepartoLocal[] | null> {
  const r = normalizarReparto(reparto);
  if ('error' in r) throw new BadRequestException(r.error);
  if (!r.reparto) return null;
  const ids = r.reparto.map((x) => x.sucursalId);
  const filas = await db.select({ id: sucursales.id, nombre: sucursales.nombre, activa: sucursales.activa })
    .from(sucursales).where(inArray(sucursales.id, ids));
  for (const id of ids) {
    const x = filas.find((f) => f.id === id);
    if (!x) throw new BadRequestException('Un local del reparto no existe.');
    if (!x.activa && !(antes ?? []).some((a) => a.sucursalId === id)) throw new BadRequestException(`${x.nombre} está desactivada: el local cerró.`);
  }
  return r.reparto;
}
