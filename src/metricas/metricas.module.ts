/**
 * MÉTRICAS Y RENTABILIDADES (0122, 29/9/2026)
 * ============================================================================
 * Pedido del dueño: «van a ser muchos cálculos y datos; mi miedo es que se me
 * enlentezca el sistema de ventas». Este módulo está hecho para que eso no
 * pueda pasar, con cuatro reglas:
 *
 *   1. LA VENTA NO ESPERA. Nada de esto corre dentro de una venta. Las métricas
 *      leen lo ya vendido y escriben solo en sus tablas (`metricas_*`).
 *   2. LAS PANTALLAS LEEN RESÚMENES. Totales por día ya calculados: una
 *      consulta tarda lo mismo con un mes que con diez años de historia.
 *   3. CONEXIONES PROPIAS Y POCAS. Este módulo tiene su propio pool de 2
 *      conexiones a la base: aunque un reporte se estire, jamás le quita una
 *      conexión a una caja. Cada consulta corre en SOLO LECTURA y con tope de
 *      tiempo; si se pasa, se corta sola.
 *   4. SE PUEDE MUDAR. Todo vive acá. Si algún día las mediciones lo pidieran,
 *      se levanta un segundo contenedor con la MISMA imagen, se enruta
 *      /api/metricas hacia él en Traefik y en el principal se apaga el reloj
 *      (`METRICAS_RELOJ=0`). Sin reescribir nada.
 *
 * «CASI EN VIVO»: cada 10 minutos se rearman hoy y ayer (milisegundos), a la
 * madrugada los últimos 40 días (lo que se anuló o corrigió después) y la
 * primera vez, toda la historia. El botón «Sincronizar» hace lo mismo a pedido.
 *
 * SOLO EL SUPERADMIN: la llave `gerencia.metricas` no la tiene ningún rol ni se
 * puede asignar desde la pantalla de roles; solo pasa el comodín `*`.
 */
import {
  BadRequestException, Body, Controller, Get, Injectable, Logger, Module, OnModuleDestroy, OnModuleInit, Post, Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsIn, IsOptional } from 'class-validator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';
import { Permiso } from '../auth/auth.decoradores';
import { hoyAr } from '../cafeteria/cuenta';
import type { Database } from '../db/drizzle';
import { schema } from '../db/schema';
import { resolverDatabaseUrl } from '../db/url';
import {
  LENTES, PASOS, TIPOS, periodoAnterior, reporteComparar, reporteGranel, reporteMargenes, reporteVentas,
  type Filtro, type Lente, type Paso, type TipoVenta,
} from './consultas';
import { reporteIva } from './iva';
import { CUENTAS, FIRMA_TIPOS, MODOS, porMeses, rangoDe, rearmarRango, type ModoSync } from './sincronizar';
import { reporteProductos } from './productos';
import { reporteStock } from './stock';

/** La llave: no está en el catálogo de permisos, así que solo la tiene el superadmin (`*`). */
export const PERMISO_METRICAS = 'gerencia.metricas';

const CADA_MS = 10 * 60_000;
/** La madrugada (hora argentina) en que se rearman los últimos 40 días. */
const HORA_NOCHE = 4;
/** Tope de una lectura de pantalla y de un rango de sincronización. */
const TOPE_LECTURA_MS = 15_000;
const TOPE_SYNC_MS = 120_000;
/** El período más largo que se deja pedir: 3 años (con resúmenes sigue siendo instantáneo). */
const MAX_DIAS = 1100;

const diaValido = (v?: string) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

class SincronizarDto {
  @IsOptional() @IsIn(MODOS as unknown as string[]) modo?: ModoSync;
}

@Injectable()
export class MetricasService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Metricas');
  /** El pool propio (ver regla 3). */
  private readonly pool: Pool;
  private reloj: ReturnType<typeof setInterval> | null = null;
  private corriendo: ModoSync | null = null;

  /** Drizzle sobre el pool PROPIO: ni las lecturas de stock tocan las conexiones de las cajas. */
  private readonly db: Database;

  constructor(config: ConfigService) {
    this.pool = new Pool({
      connectionString: resolverDatabaseUrl(config.get<string>('DATABASE_URL')),
      max: 2,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      // Tope por defecto de CUALQUIER consulta de este módulo; la sincronización lo amplía en su transacción.
      statement_timeout: TOPE_LECTURA_MS,
      application_name: 'erp-metricas',
      keepAlive: true,
    });
    // Sin esto, una conexión ociosa que se corta voltea el proceso entero (ver db.module.ts).
    this.pool.on('error', (e) => this.log.warn(`conexión ociosa caída: ${e.message}`));
    this.db = drizzle(this.pool, { schema, casing: 'snake_case' }) as unknown as Database;
  }

  /* ------------------------------ lectura ------------------------------ */
  /** Corre `fn` en una transacción de SOLO LECTURA, con tope de tiempo. */
  private async leer<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN READ ONLY');
      await c.query(`SET LOCAL statement_timeout = ${TOPE_LECTURA_MS}`);
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      if (/statement timeout|canceling statement/i.test(String((e as Error).message))) {
        throw new BadRequestException('La consulta tardó demasiado y se cortó para no frenar el sistema. Probá con un período más corto.');
      }
      throw e;
    } finally {
      c.release();
    }
  }

  /** Desde, hasta y sucursal, validados. Por defecto: del 1° del mes a hoy. */
  private filtro(q: { desde?: string; hasta?: string; sucursalId?: string }): Filtro {
    const hoy = hoyAr();
    const desde = diaValido(q.desde) ? q.desde! : `${hoy.slice(0, 8)}01`;
    const hasta = diaValido(q.hasta) ? q.hasta! : hoy;
    if (hasta < desde) throw new BadRequestException('«Hasta» es anterior a «desde».');
    const dias = Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000) + 1;
    if (dias > MAX_DIAS) throw new BadRequestException('El período puede ser de hasta 3 años.');
    const suc = Number(q.sucursalId);
    return { desde, hasta, sucursalId: Number.isInteger(suc) && suc > 0 ? suc : null };
  }

  private paso(v?: string): Paso { return (v && v in PASOS ? v : 'dia') as Paso; }

  ventas(q: any) { const f = this.filtro(q); return this.leer((c) => reporteVentas(c, f, this.paso(q.paso))); }

  /** Resultados IVA (3/10/2026): facturado contra sin factura y la posición de IVA mes a mes. */
  iva(q: any) {
    const f = this.filtro(q);
    return this.leer(async (c) => {
      const r = await c.query(`select valor from configuracion where clave = 'empresa'`);
      const v: any = r.rows[0]?.valor ?? {};
      return reporteIva(c, f, { importe: Number(v.ivaSaldoInicial) || 0, mes: String(v.ivaSaldoMes ?? '') });
    });
  }

  margenes(q: any) {
    const f = this.filtro(q);
    const lente = (LENTES as readonly string[]).includes(q.lente) ? (q.lente as Lente) : 'producto';
    // Solo granel o solo enteros (0123); cualquier otro valor = todo.
    const tipo = (TIPOS as readonly string[]).includes(q.tipo) ? (q.tipo as TipoVenta) : null;
    return this.leer((c) => reporteMargenes(c, { ...f, tipo }, this.paso(q.paso), lente));
  }

  granel(q: any) { const f = this.filtro(q); return this.leer((c) => reporteGranel(c, f, this.paso(q.paso))); }

  /**
   * Productos, categorías y subcategorías (2/10/2026). `categoriaId` y
   * `subcategoriaId` dicen dónde se está parado en el árbol (`0` = sin
   * clasificar), `productoId` abre el detalle de uno y `plano=1` lista todos
   * los productos del nivel. `tipo`: solo granel o solo enteros.
   * `porMarca=1` recorre por marca (7/10/2026) y `marcaId` abre una.
   */
  productos(q: any) {
    const f = this.filtro(q);
    const tipo = (TIPOS as readonly string[]).includes(q.tipo) ? (q.tipo as TipoVenta) : null;
    const id = (v: unknown) => { if (v === undefined || v === null || v === '') return null; const n = Number(v); return Number.isInteger(n) && n >= 0 ? n : null; };
    const productoId = id(q.productoId);
    return this.leer((c) => reporteProductos(c, { ...f, tipo }, this.paso(q.paso), {
      categoriaId: id(q.categoriaId), subcategoriaId: id(q.subcategoriaId), productoId: productoId || null, plano: q.plano === '1' || q.plano === 'true',
      porMarca: q.porMarca === '1' || q.porMarca === 'true', marcaId: id(q.marcaId),
    }));
  }

  /**
   * A = desde/hasta (el período de arriba); B = bDesde/bHasta. Sin B, el período
   * anterior del mismo largo. La sucursal vale para los dos.
   */
  comparar(q: any) {
    const a = this.filtro(q);
    const b = diaValido(q.bDesde) && diaValido(q.bHasta)
      ? this.filtro({ desde: q.bDesde, hasta: q.bHasta, sucursalId: q.sucursalId })
      : periodoAnterior(a);
    return this.leer((c) => reporteComparar(c, a, b, this.paso(q.paso)));
  }

  stock(q: any) {
    const suc = Number(q.sucursalId);
    return reporteStock(this.db, this.pool, { sucursalId: Number.isInteger(suc) && suc > 0 ? suc : null, ventana: Number(q.ventana) || 60 });
  }

  async sucursales() {
    // Para el filtro: solo las activas (0143). Los totales siguen incluyendo lo que vendió un local cerrado.
    const r = await this.pool.query('SELECT id, nombre FROM sucursales WHERE activa ORDER BY id');
    return r.rows;
  }

  /* --------------------------- sincronización --------------------------- */
  async estado() {
    const [e] = (await this.pool.query('SELECT * FROM metricas_estado WHERE id = 1')).rows;
    const firma = (await this.pool.query(FIRMA_TIPOS)).rows[0]?.f ?? '';
    return {
      corriendo: this.corriendo,
      ultimaSync: e?.ultima_sync ?? null,
      ultimaOk: e?.ultima_ok ?? null,
      ultimaNoche: e?.ultima_noche ?? null,
      modo: e?.modo ?? '',
      duracionMs: e?.duracion_ms ?? 0,
      primerDato: e?.primer_dato ?? null,
      filas: e?.filas ?? {},
      error: e?.error ?? '',
      /** Nunca se armó: hay que correr «todo» una vez (el reloj lo hace solo). */
      vacio: !e?.ultima_ok,
      /** Alguien cambió el tipo (granel/entero) de un producto: el reloj rearma toda la historia en su próxima vuelta. */
      tiposCambiaron: !!e?.ultima_ok && (e?.firma_tipos ?? '') !== firma,
    };
  }

  /**
   * Rearma el rango del modo. Nunca lanza para el reloj: el resultado queda en
   * `metricas_estado`. Un candado de Postgres evita que dos sincronizaciones
   * (dos contenedores, o el reloj y el botón) pisen el mismo rango a la vez.
   */
  async sincronizar(modo: ModoSync): Promise<{ ok: boolean; modo: ModoSync; filas?: number; ms?: number; motivo?: string }> {
    if (this.corriendo) return { ok: false, modo, motivo: `Ya hay una sincronización en marcha (${this.corriendo}).` };
    this.corriendo = modo;
    const inicio = Date.now();
    /* UNA sola conexión para todo (candado, rearmado y estado): la otra del pool
     * queda siempre libre para que la pantalla lea mientras se sincroniza. */
    let lock: PoolClient | null = null;
    try {
      lock = await this.pool.connect();
      const { rows } = await lock.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', ['metricas:sync']);
      if (!rows[0]?.ok) return { ok: false, modo, motivo: 'Otro proceso está sincronizando: probá en un minuto.' };
      try {
        const hoy = hoyAr();
        // La firma se toma ANTES de rearmar: si alguien cambia un tipo mientras tanto, la próxima vuelta lo nota.
        const firma = modo === 'todo' ? (await lock.query(FIRMA_TIPOS)).rows[0]?.f ?? '' : null;
        const rango = await rangoDe(lock, modo, hoy);
        let filas = 0;
        if (rango) {
          const tramos = modo === 'todo' ? porMeses(rango.desde, rango.hasta) : [[rango.desde, rango.hasta] as [string, string]];
          for (const [d, h] of tramos) filas += await rearmarRango(lock, d, h, TOPE_SYNC_MS);
        }
        const cuentas = (await lock.query(CUENTAS)).rows[0];
        const primer = (await lock.query('SELECT min(dia)::text AS d FROM metricas_venta_dia')).rows[0]?.d ?? null;
        const ms = Date.now() - inicio;
        await lock.query(
          `INSERT INTO metricas_estado (id, ultima_sync, ultima_ok, ultima_noche, modo, duracion_ms, desde_dia, hasta_dia, primer_dato, filas, error, firma_tipos)
           VALUES (1, now(), now(), CASE WHEN $1 IN ('noche', 'todo') THEN now() END, $1, $2, $3, $4, $5, $6, '', coalesce($7, ''))
           ON CONFLICT (id) DO UPDATE SET ultima_sync = now(), ultima_ok = now(),
             ultima_noche = CASE WHEN $1 IN ('noche', 'todo') THEN now() ELSE metricas_estado.ultima_noche END,
             modo = $1, duracion_ms = $2, desde_dia = $3, hasta_dia = $4, primer_dato = $5, filas = $6, error = '',
             firma_tipos = coalesce($7, metricas_estado.firma_tipos)`,
          [modo, ms, rango?.desde ?? null, rango?.hasta ?? null, primer, cuentas, firma]);
        if (modo !== 'reciente' || ms > 5_000) this.log.log(`Sincronización ${modo}: ${filas} filas en ${ms} ms`);
        return { ok: true, modo, filas, ms };
      } finally {
        await lock.query('SELECT pg_advisory_unlock(hashtext($1))', ['metricas:sync']).catch(() => undefined);
      }
    } catch (e) {
      const msg = String((e as Error).message ?? e).slice(0, 400);
      this.log.error(`Sincronización ${modo} falló: ${msg}`);
      await (lock ?? this.pool).query(
        `INSERT INTO metricas_estado (id, ultima_sync, modo, error) VALUES (1, now(), $1, $2)
         ON CONFLICT (id) DO UPDATE SET ultima_sync = now(), modo = $1, error = $2`, [modo, msg]).catch(() => undefined);
      return { ok: false, modo, motivo: msg };
    } finally {
      lock?.release();
      this.corriendo = null;
    }
  }

  /* ------------------------------- el reloj ------------------------------- */
  onModuleInit() {
    if (process.env.NODE_ENV === 'test' || process.env.METRICAS_RELOJ === '0') return;
    // Arranca un minuto después del inicio: el servidor recién levantado atiende primero a las cajas.
    const primero = setTimeout(() => { void this.tick(); }, 60_000);
    primero.unref();
    this.reloj = setInterval(() => { void this.tick(); }, CADA_MS);
    this.reloj.unref();
  }

  async onModuleDestroy() {
    if (this.reloj) clearInterval(this.reloj);
    await this.pool.end().catch(() => undefined);
  }

  /**
   * Qué toca ahora: la primera vez (o si cambió el tipo de un producto) todo,
   * una vez por madrugada los 40 días, y si no, hoy y ayer.
   */
  async tick() {
    try {
      if (this.corriendo) return;
      const e = await this.estado();
      if (e.vacio || e.tiposCambiaron) { await this.sincronizar('todo'); return; }
      const ahora = new Date();
      const horaAr = Number(ahora.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires', hour: 'numeric', hour12: false }));
      const noche = e.ultimaNoche ? new Date(e.ultimaNoche) : null;
      const horasDesdeNoche = noche ? (ahora.getTime() - noche.getTime()) / 3_600_000 : Infinity;
      if (horaAr >= HORA_NOCHE && horasDesdeNoche > 20) { await this.sincronizar('noche'); return; }
      await this.sincronizar('reciente');
    } catch (err) {
      this.log.warn(`reloj: ${(err as Error).message}`);
    }
  }
}

@Controller('metricas')
@Permiso(PERMISO_METRICAS)
export class MetricasController {
  constructor(private readonly svc: MetricasService) {}

  @Get('estado') estado() { return this.svc.estado(); }
  @Get('sucursales') sucursales() { return this.svc.sucursales(); }
  @Get('ventas') ventas(@Query() q: any) { return this.svc.ventas(q); }
  @Get('margenes') margenes(@Query() q: any) { return this.svc.margenes(q); }
  @Get('granel') granel(@Query() q: any) { return this.svc.granel(q); }
  @Get('productos') productos(@Query() q: any) { return this.svc.productos(q); }
  @Get('comparar') comparar(@Query() q: any) { return this.svc.comparar(q); }
  @Get('stock') stock(@Query() q: any) { return this.svc.stock(q); }
  @Get('iva') iva(@Query() q: any) { return this.svc.iva(q); }

  /** El botón «Sincronizar»: por defecto, hoy y ayer (un instante). */
  @Post('sincronizar')
  async sincronizar(@Body() dto: SincronizarDto) {
    const r = await this.svc.sincronizar(dto.modo ?? 'reciente');
    if (!r.ok) throw new BadRequestException(r.motivo ?? 'No se pudo sincronizar.');
    return { ...r, estado: await this.svc.estado() };
  }
}

@Module({
  controllers: [MetricasController],
  providers: [MetricasService],
  exports: [MetricasService],
})
export class MetricasModule {}
