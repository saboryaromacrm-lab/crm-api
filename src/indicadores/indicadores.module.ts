/**
 * GERENCIA › INDICADORES (0209, 1/11/2026) — ver `calculo.ts`.
 * ============================================================================
 *   GET /indicadores               los % del período (llave `gerencia.indicadores`)
 *   GET /indicadores/sucursales    para el filtro
 *   GET /indicadores/objetivos     los objetivos que fijó el dueño
 *   PUT /indicadores/objetivos     cambiarlos: SOLO el superadmin (llave fuera del catálogo)
 *
 * Decisiones del dueño (no re-preguntar): la ve el rol Administrador (Karen,
 * la encargada; también Agustín), con todas las sucursales y el filtro; los
 * cuatro bloques, márgenes % incluidos; los objetivos los carga el dueño.
 * Los objetivos viven en `configuracion` (clave `indicadores_objetivos`):
 * un número por indicador; sin número, se usa el valor de partida de la pantalla.
 */
import { BadRequestException, Body, Controller, Get, Inject, Injectable, Module, Put, Query } from '@nestjs/common';
import { IsObject } from 'class-validator';
import { eq } from 'drizzle-orm';
import { Auth, Permiso, type Sesion } from '../auth/auth.decoradores';
import { hoyAr } from '../cafeteria/cuenta';
import { DRIZZLE, Database } from '../db/drizzle';
import { auditoria, configuracion } from '../db/schema';
import { MetricasModule, MetricasService } from '../metricas/metricas.module';
import { calcularIndicadores, resumenStock } from './calculo';

export const PERMISO_INDICADORES = 'gerencia.indicadores';
/** Cambiar objetivos: llave que no está en el catálogo, así que solo la tiene el superadmin («*»). */
const PERMISO_OBJETIVOS = 'gerencia.indicadores_objetivos';
const CLAVE = 'indicadores_objetivos';

/** Los indicadores que llevan objetivo (la pantalla tiene los textos y los valores de partida). */
export const CON_OBJETIVO = [
  'crecimiento', 'crecimientoAnual', 'tickets', 'ticketPromedio', 'credito',
  'margen', 'granel', 'descuentos', 'bajoCosto',
  'parado', 'sobrestock', 'porAgotarse',
  'cierresDiferencia', 'notas',
] as const;

const MAX_DIAS = 400;
const diaValido = (v?: string) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

class ObjetivosDto {
  @IsObject() objetivos!: Record<string, number | null>;
}

@Injectable()
export class IndicadoresService {
  constructor(private readonly metricas: MetricasService, @Inject(DRIZZLE) private readonly db: Database) {}

  private filtro(q: { desde?: string; hasta?: string; sucursalId?: string; comparar?: string }) {
    const hoy = hoyAr();
    const desde = diaValido(q.desde) ? q.desde! : `${hoy.slice(0, 8)}01`;
    const hasta = diaValido(q.hasta) ? q.hasta! : hoy;
    if (hasta < desde) throw new BadRequestException('«Hasta» es anterior a «desde».');
    const dias = Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000) + 1;
    if (dias > MAX_DIAS) throw new BadRequestException('El período puede ser de hasta un año.');
    const suc = Number(q.sucursalId);
    /* «Contra el período anterior» o contra el mismo período del mes anterior (7/11/2026). */
    return { desde, hasta, sucursalId: Number.isInteger(suc) && suc > 0 ? suc : null, comparar: q.comparar === 'mes' ? 'mes' as const : null };
  }

  async indicadores(q: any) {
    const f = this.filtro(q);
    const [base, stock] = await Promise.all([
      this.metricas.leer((c) => calcularIndicadores(c, f)),
      // El stock es el de HOY (no depende del período); el ritmo de venta, de los últimos 60 días.
      this.metricas.stockValorizado(f.sucursalId, 60),
    ]);
    const st = resumenStock(stock.lista);
    return {
      ...base,
      valores: { ...base.valores, parado: st.parado, sobrestock: st.sobrestock, porAgotarse: st.porAgotarse },
      detalle: { ...base.detalle, articulosConStock: st.articulos },
    };
  }

  sucursales() { return this.metricas.sucursales(); }

  async objetivos(): Promise<Record<string, number>> {
    const [fila] = await this.db.select({ valor: configuracion.valor }).from(configuracion).where(eq(configuracion.clave, CLAVE)).limit(1);
    const v: any = fila?.valor ?? {};
    const out: Record<string, number> = {};
    for (const k of CON_OBJETIVO) if (typeof v[k] === 'number' && Number.isFinite(v[k])) out[k] = v[k];
    return out;
  }

  async guardarObjetivos(dto: ObjetivosDto, s: Sesion) {
    const antes = await this.objetivos();
    const valor: Record<string, number> = { ...antes };
    const cambios: [string, string, string][] = [];
    for (const [k, v] of Object.entries(dto.objetivos ?? {})) {
      if (!(CON_OBJETIVO as readonly string[]).includes(k)) throw new BadRequestException(`Indicador desconocido: ${k}.`);
      if (v === null || v === undefined || (v as unknown) === '') {
        if (k in valor) { cambios.push([k, String(valor[k]), '(valor de partida)']); delete valor[k]; }
        continue;
      }
      const n = Math.round(Number(v) * 100) / 100;
      if (!Number.isFinite(n) || n < -100 || n > 1000) throw new BadRequestException(`Objetivo inválido para ${k}.`);
      if (valor[k] !== n) { cambios.push([k, k in valor ? String(valor[k]) : '(valor de partida)', String(n)]); valor[k] = n; }
    }
    await this.db.insert(configuracion).values({ clave: CLAVE, valor })
      .onConflictDoUpdate({ target: configuracion.clave, set: { valor, updatedAt: new Date() } });
    if (cambios.length) {
      await this.db.insert(auditoria).values(cambios.map(([campo, a, d]) => ({
        usuarioId: s.usuarioId, entidad: 'indicadores_objetivos', entidadId: 1, ambito: 'Gerencia · Indicadores', detalle: 'Objetivos', campo, antes: a, despues: d,
      })));
    }
    return this.objetivos();
  }
}

@Controller('indicadores')
@Permiso(PERMISO_INDICADORES)
export class IndicadoresController {
  constructor(private readonly svc: IndicadoresService) {}

  @Get() indicadores(@Query() q: any) { return this.svc.indicadores(q); }
  @Get('sucursales') sucursales() { return this.svc.sucursales(); }
  @Get('objetivos') objetivos() { return this.svc.objetivos(); }

  @Put('objetivos') @Permiso(PERMISO_OBJETIVOS)
  guardar(@Body() dto: ObjetivosDto, @Auth() s: Sesion) { return this.svc.guardarObjetivos(dto, s); }
}

@Module({
  imports: [MetricasModule],
  controllers: [IndicadoresController],
  providers: [IndicadoresService],
})
export class IndicadoresModule {}
