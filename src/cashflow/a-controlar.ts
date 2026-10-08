/**
 * CAJAS A CONTROLAR (0145, 8/10/2026, pedido del dueño)
 * ============================================================================
 * Al terminar un control —el del sobre en el Cash Flow, el cierre del turno o
 * un control a mitad de turno— el dueño ve la diferencia y, si le parece
 * mucha, marca LA CAJA (el turno): queda en «Cajas a controlar» hasta que la
 * resuelva escribiendo qué pasó. Si no marca nada, quedó todo bien.
 *
 * La pantalla PROPONE el tilde cuando la diferencia pasa de `umbral_controlar`
 * (lo fija el dueño); la decisión es siempre suya. No mueve plata: la
 * diferencia ya quedó registrada al contar, esto es el seguimiento.
 *
 * Vive aparte del módulo del Cash Flow porque también lo usa la caja al cerrar
 * el turno, y el Cash Flow ya importa la caja.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { sql } from 'drizzle-orm';

/** La llave: fuera del catálogo, solo la tiene el superadmin (`*`). Marcar y resolver van con ella. */
export const PERMISO_CASHFLOW = 'gerencia.cashflow';
/** Sin arranque del Cash Flow todavía, el límite de la propuesta. */
const UMBRAL_INICIAL = 5000;
const MAX_UMBRAL = 100_000_000;
export type OrigenMarca = 'sobre' | 'cierre' | 'control';
const filas = (r: any) => (r.rows ?? r) as any[];

/** Lo que manda la pantalla con el tilde puesto (sin tilde no viaja nada). */
export class MarcaDto {
  @IsOptional() @IsString() @MaxLength(300) nota?: string;
}

export async function umbralControlar(db: any): Promise<number> {
  const [c] = filas(await db.execute(sql`SELECT umbral_controlar AS u FROM cashflow_caja ORDER BY id LIMIT 1`));
  return c ? Number(c.u) : UMBRAL_INICIAL;
}

export async function cambiarUmbral(db: any, valor: unknown) {
  const umbral = Math.round(Number(valor) * 100) / 100;
  if (!Number.isFinite(umbral) || umbral < 0 || umbral > MAX_UMBRAL) throw new BadRequestException('El límite tiene que ser un importe de $0 en adelante.');
  const r = filas(await db.execute(sql`UPDATE cashflow_caja SET umbral_controlar = ${umbral} RETURNING id`));
  if (!r.length) throw new BadRequestException('Primero arrancá el Cash Flow.');
  return { umbral };
}

/**
 * Marca el turno. Ya marcado y sin resolver: no se duplica, se le suma la
 * nota (y queda dónde se marcó por última vez). Va dentro de la transacción
 * del control cuando la hay: o quedan los dos, o ninguno.
 */
export async function marcarCaja(db: any, o: { cajaSesionId: number; origen: OrigenMarca; nota?: string; usuarioId: number | null }) {
  const nota = String(o.nota ?? '').trim().slice(0, 300);
  const [m] = filas(await db.execute(sql`
    INSERT INTO cajas_a_controlar (caja_sesion_id, origen, nota, marcada_por)
    VALUES (${o.cajaSesionId}, ${o.origen}, ${nota}, ${o.usuarioId})
    ON CONFLICT (caja_sesion_id) WHERE resuelta_en IS NULL DO UPDATE SET
      origen = excluded.origen,
      nota = CASE WHEN excluded.nota = '' THEN cajas_a_controlar.nota
                  WHEN cajas_a_controlar.nota = '' THEN excluded.nota
                  ELSE left(cajas_a_controlar.nota || ' · ' || excluded.nota, 600) END
    RETURNING id`));
  return { ok: true, id: Number(m.id) };
}

/** Marcar desde una pantalla que ya registró su control (el control a mitad de turno). */
export async function marcarDesdePantalla(db: any, dto: { cajaSesionId?: unknown; nota?: unknown }, usuarioId: number | null) {
  const id = Number(dto.cajaSesionId);
  if (!Number.isInteger(id) || id <= 0) throw new BadRequestException('Falta el turno de caja.');
  const [t] = filas(await db.execute(sql`SELECT id FROM caja_sesiones WHERE id = ${id}`));
  if (!t) throw new NotFoundException('Turno de caja inexistente.');
  return marcarCaja(db, { cajaSesionId: id, origen: 'control', nota: typeof dto.nota === 'string' ? dto.nota : '', usuarioId });
}

export async function resolverCaja(db: any, id: number, resolucion: unknown, usuarioId: number | null) {
  const texto = String(resolucion ?? '').trim();
  if (texto.length < 3) throw new BadRequestException('Escribí qué pasó con esta caja (lo que encontraste o cómo se arregló).');
  const r = filas(await db.execute(sql`
    UPDATE cajas_a_controlar SET resuelta_en = now(), resuelta_por = ${usuarioId}, resolucion = ${texto.slice(0, 500)}
     WHERE id = ${id} AND resuelta_en IS NULL RETURNING id`));
  if (!r.length) throw new BadRequestException('Esa caja ya estaba resuelta (o no existe): actualizá la lista.');
  return { ok: true };
}

/**
 * La lista: cada turno marcado con sus TRES diferencias en vivo (el cierre, el
 * sobre y los controles a mitad de turno), para mirar sin abrir nada más. El
 * control que firma el cierre por envío ES el cierre: no se repite.
 */
export async function listarCajas(db: any, resueltas: boolean) {
  const r = filas(await db.execute(sql`
    SELECT a.id, a.caja_sesion_id AS "cajaSesionId", a.origen, a.nota, a.marcada_en AS "marcadaEn", a.resuelta_en AS "resueltaEn",
           a.resolucion, ur.nombre AS "resueltaPor",
           s.nombre AS sucursal, uc.nombre AS cajero, cs.estado, cs.apertura, cs.cierre,
           cs.sistema_efectivo AS esperado, cs.declarado_efectivo AS declarado, cs.diferencia AS "difCierre",
           so.enviado AS "sobreEnviado", so.contado AS "sobreContado", so.diferencia AS "difSobre",
           (SELECT coalesce(json_agg(json_build_object('fecha', cc.fecha, 'diferencia', cc.diferencia, 'nota', cc.observaciones) ORDER BY cc.fecha), '[]')
              FROM caja_controles cc
             WHERE cc.caja_sesion_id = cs.id AND abs(cc.diferencia) >= 0.5 AND cc.observaciones NOT LIKE 'Cierre por envío%') AS controles
      FROM cajas_a_controlar a
      JOIN caja_sesiones cs ON cs.id = a.caja_sesion_id
      LEFT JOIN sucursales s ON s.id = cs.sucursal_id
      LEFT JOIN usuarios uc ON uc.id = cs.usuario_id
      LEFT JOIN usuarios ur ON ur.id = a.resuelta_por
      LEFT JOIN cashflow_sobres so ON so.caja_sesion_id = cs.id AND so.anulado_en IS NULL AND NOT so.descartado
     WHERE ${resueltas ? sql`a.resuelta_en IS NOT NULL` : sql`a.resuelta_en IS NULL`}
     ORDER BY coalesce(a.resuelta_en, a.marcada_en) DESC
     LIMIT 200`));
  const n = (v: unknown) => (v == null ? null : Math.round(Number(v) * 100) / 100);
  return {
    umbral: await umbralControlar(db),
    cajas: r.map((x) => ({
      ...x, esperado: n(x.esperado), declarado: n(x.declarado), difCierre: n(x.difCierre),
      sobreEnviado: n(x.sobreEnviado), sobreContado: n(x.sobreContado), difSobre: n(x.difSobre),
      controles: (x.controles ?? []).map((c: any) => ({ ...c, diferencia: n(c.diferencia) })),
    })),
  };
}

export async function cuantasPendientes(db: any) {
  const [x] = filas(await db.execute(sql`SELECT count(*)::int AS n FROM cajas_a_controlar WHERE resuelta_en IS NULL`));
  return Number(x?.n) || 0;
}
