/**
 * RESPALDOS (Sistema › Respaldos)
 * ============================================================================
 * La versión CHICA y honesta, decidida con el dueño el 26/8/2026: los backups
 * automáticos ya corren en Dokploy y la restauración se hace allá — esta
 * pantalla NO los duplica ni los ve (los archivos viven fuera del contenedor).
 * Lo que esta pieza agrega es lo que el VPS solo no cubre:
 *
 *   1. LA COPIA EXTERNA: un botón que genera el volcado completo de la base y
 *      lo baja a la máquina del dueño. Si el servidor (o el proveedor) se cae
 *      con sus backups adentro, la copia de afuera es la que salva.
 *   2. EL RASTRO: cada descarga queda en `auditoria` (quién, cuándo, tamaño),
 *      y la pantalla muestra la última — "hace tres meses que nadie baja una
 *      copia" es un dato que tiene que estar a la vista.
 *
 * EL VOLCADO SE GENERA SIN pg_dump a propósito: la imagen del contenedor es
 * `node` pelado y no trae el binario (y un pg_dump de otra versión que el
 * servidor directamente se niega a correr). En su lugar se lee cada tabla con
 * los valores EN SU REPRESENTACIÓN DE TEXTO de Postgres (sin parsear tipos:
 * timestamps, jsonb, arrays y bytea viajan tal cual los escribe el servidor)
 * y se emiten INSERTs. La restauración es: base con el esquema ya migrado
 * (node dist/db/migrate.js) + psql -f archivo.sql — las instrucciones van en
 * el encabezado del propio archivo, que es donde se las busca en la urgencia.
 */
import {
  BadRequestException, Body, Controller, ForbiddenException, Get, Inject, Injectable, Module, Post, Res,
} from '@nestjs/common';
import type { Response } from 'express';
import type { Pool } from 'pg';
import { desc, eq, and, sql } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import { Auth, Permiso, type Sesion } from '../auth/auth.decoradores';
import { auditoria, usuarios } from '../db/schema';
import { AuditoriaModule, AuditoriaService } from '../auditoria/auditoria.module';

/** Literal SQL: comillas simples dobladas. `standard_conforming_strings` es el
 *  default de Postgres, así que la barra invertida no necesita nada. */
const literal = (v: string | null) => (v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`);

/**
 * LIMPIEZA DE FIN DE PRÁCTICA (28/8/2026, pedido del dueño): las tablas
 * TRANSACCIONALES que se vacían cuando termina el período de prueba del
 * equipo. Todo lo que es CATÁLOGO o IDENTIDAD se conserva: productos y sus
 * formatos, proveedores con percepciones y cuentas, clientes, listas y
 * precios (con su historial), ofertas, usuarios/roles/sesiones, sucursales,
 * terminales, configuración, fotos de la tienda, chat y las plantillas de
 * gastos recurrentes.
 *
 * TRUNCATE SIN CASCADE a propósito: si alguna tabla nueva referencia a una de
 * estas y no está en la lista, Postgres se niega y la transacción aborta —
 * mejor un error que borrar de más en silencio. `RESTART IDENTITY` deja los
 * contadores en 1: la primera venta real es el ticket 1 (la numeración fiscal
 * la lleva ARCA y no se toca).
 */
const TABLAS_PRACTICA = [
  // stock y su película
  'stock', 'movimientos',
  // almacén: conteos, transferencias, incidencias, vencimientos
  'conteos', 'conteo_items',
  'transferencias', 'transferencia_items', 'transferencia_hist',
  'incidencias',
  'vencimiento_sesiones', 'vencimientos',
  // compras: comprobantes (facturas, remitos, liquidaciones) y la bandeja
  'comprobantes', 'comprobante_items', 'comprobante_percepciones',
  'factura_lecturas', 'factura_archivos',
  // ventas: tickets, presupuestos, cobranzas y caja
  'ventas', 'venta_items', 'venta_extras', 'venta_pagos',
  'presupuestos', 'presupuesto_items',
  'cobranzas', 'cobranza_pagos', 'cobranza_imputaciones',
  'caja_sesiones', 'caja_movimientos', 'caja_controles',
  // proveedores: pagos (con su split multi-medio), compromisos, echeqs,
  // ajustes EDOC y la pizarra. `pago_formas` la encontró la PRUEBA: el
  // TRUNCATE sin CASCADE se negó porque referencia a proveedor_pagos —
  // exactamente el aviso para el que existe ese diseño.
  'proveedor_pagos', 'pago_formas', 'proveedor_imputaciones',
  'proveedor_compromisos', 'proveedor_echeqs', 'proveedor_ajustes',
  'pedidos_proveedor',
  // gastos (los cargados; las plantillas recurrentes y los rubros quedan)
  'gastos', 'gasto_items', 'gasto_adjuntos',
  // cafetería
  'pedidos_cafeteria', 'pedido_cafeteria_items',
  'envios_cafeteria', 'envio_cafeteria_items',
  // tienda: eventos (las fotos quedan)
  'web_eventos',
  // el rastro de la práctica; el primer registro de la era nueva es la limpieza
  'auditoria',
];

@Injectable()
export class RespaldosService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditoriaService,
  ) {}

  private get pool(): Pool {
    return (this.db as any).$client as Pool;
  }

  /** Tablas del esquema público, orden alfabético (las FKs no importan: el
   *  archivo carga con los triggers apagados). */
  private async tablas(): Promise<string[]> {
    const r = await this.pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    return r.rows.map((x: any) => x.tablename as string);
  }

  async info() {
    const [tam, tablas, resumen, descargas] = await Promise.all([
      this.pool.query('SELECT pg_size_pretty(pg_database_size(current_database())) AS pretty'),
      this.tablas(),
      this.pool.query(`SELECT
        (SELECT count(*) FROM productos)     AS productos,
        (SELECT count(*) FROM ventas)        AS ventas,
        (SELECT count(*) FROM comprobantes)  AS comprobantes,
        (SELECT count(*) FROM clientes)      AS clientes`),
      this.db.select({
        fecha: auditoria.fecha,
        detalle: auditoria.despues,
        usuario: sql<string>`coalesce(${usuarios.nombre}, '')`,
      })
        .from(auditoria)
        .leftJoin(usuarios, eq(usuarios.id, auditoria.usuarioId))
        .where(and(eq(auditoria.entidad, 'sistema'), eq(auditoria.ambito, 'Respaldos')))
        .orderBy(desc(auditoria.id))
        .limit(10),
    ]);
    return {
      tamano: tam.rows[0]?.pretty ?? '—',
      tablas: tablas.length,
      resumen: resumen.rows[0] ?? {},
      descargas,
    };
  }

  /**
   * Escribe el volcado completo sobre la respuesta HTTP y devuelve el tamaño.
   * Valores como TEXTO crudo (sin type parsers): lo que Postgres escribe es
   * exactamente lo que Postgres sabe volver a leer.
   */
  async volcar(res: Response, usuarioId: number | null) {
    const tablas = await this.tablas();
    const fecha = new Date();
    const sello = fecha.toISOString().slice(0, 16).replace('T', '-').replace(':', '');

    res.setHeader('Content-Type', 'application/sql; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="respaldo-crm-${sello}.sql"`);

    let bytes = 0;
    let filasTotal = 0;
    const escribir = (s: string) => { bytes += Buffer.byteLength(s); res.write(s); };

    escribir([
      `-- Respaldo del CRM Sabor y Aroma — ${fecha.toISOString()}`,
      `-- ${tablas.length} tablas. Generado desde Sistema › Respaldos.`,
      '--',
      '-- CÓMO SE RESTAURA (en una base NUEVA):',
      '--   1. Crear la base y correr las migraciones del sistema:  node dist/db/migrate.js',
      '--   2. Cargar este archivo como superusuario (postgres):    psql "DATABASE_URL" -f este_archivo.sql',
      '-- El archivo vacía las tablas y las vuelve a llenar; corre con los',
      '-- triggers apagados (session_replication_role), por eso pide superusuario.',
      '',
      'BEGIN;',
      'SET session_replication_role = replica;',
      `TRUNCATE ${tablas.map((t) => `"${t}"`).join(', ')} CASCADE;`,
      '',
    ].join('\n'));

    // Sin parsers: cada valor llega como el texto que Postgres emitiría en un COPY.
    const crudo = { getTypeParser: () => (v: string) => v } as any;

    for (const t of tablas) {
      const r = await this.pool.query({ text: `SELECT * FROM "${t}"`, types: crudo });
      if (!r.rows.length) continue;
      const cols = r.fields.map((f: any) => `"${f.name}"`).join(', ');
      escribir(`-- ${t}: ${r.rows.length} fila(s)\n`);
      const LOTE = 200;
      for (let i = 0; i < r.rows.length; i += LOTE) {
        const filas = r.rows.slice(i, i + LOTE)
          .map((row: any) => `(${r.fields.map((f: any) => literal(row[f.name])).join(', ')})`);
        escribir(`INSERT INTO "${t}" (${cols}) VALUES\n${filas.join(',\n')};\n`);
      }
      filasTotal += r.rows.length;
    }

    // Las secuencias arrancan después del último id insertado, tabla por tabla.
    const conSerial = await this.pool.query(`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'id' AND column_default LIKE 'nextval%'`);
    escribir('\n-- Secuencias al día\n');
    for (const row of conSerial.rows as any[]) {
      escribir(`SELECT setval(pg_get_serial_sequence('"${row.table_name}"', 'id'), COALESCE((SELECT MAX(id) FROM "${row.table_name}"), 0) + 1, false);\n`);
    }
    escribir('\nSET session_replication_role = DEFAULT;\nCOMMIT;\n');
    res.end();

    /* El rastro: quién bajó la copia, cuándo y qué tamaño tenía. Después de
     * cerrar la respuesta a propósito — un fallo del registro no puede
     * cortarle la descarga al que la está bajando. */
    const mb = (bytes / 1024 / 1024).toFixed(1);
    await this.audit.registrar([{
      entidad: 'sistema', entidadId: 0, ambito: 'Respaldos',
      campo: 'Descarga del respaldo', usuarioId,
      despues: `${tablas.length} tablas · ${filasTotal.toLocaleString('es-AR')} filas · ${mb} MB`,
    }]);
  }

  /** El ensayo de la limpieza: cuántas filas se irían, tabla por tabla. */
  async ensayoLimpieza() {
    const detalle: { tabla: string; filas: number }[] = [];
    let total = 0;
    for (const t of TABLAS_PRACTICA) {
      const r = await this.pool.query(`SELECT count(*)::int AS n FROM "${t}"`);
      const n = Number(r.rows[0]?.n) || 0;
      if (n > 0) detalle.push({ tabla: t, filas: n });
      total += n;
    }
    return { tablas: TABLAS_PRACTICA.length, total, detalle };
  }

  /**
   * LA LIMPIEZA. Una sola transacción sobre UNA conexión (un BEGIN por
   * `pool.query` iría a conexiones distintas y no ataría nada). El registro
   * de auditoría se escribe DESPUÉS del commit: es el primer rastro de la era
   * nueva — dentro de la transacción lo borraría el propio TRUNCATE.
   */
  async limpiarPractica(usuarioId: number | null) {
    const antes = await this.ensayoLimpieza();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`TRUNCATE ${TABLAS_PRACTICA.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY`);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw new BadRequestException(
        'La limpieza se canceló entera (no quedó nada a medias): ' + ((e as Error).message ?? e),
      );
    } finally {
      client.release();
    }
    await this.audit.registrar([{
      entidad: 'sistema', entidadId: 0, ambito: 'Limpieza',
      campo: 'Fin del período de prueba', usuarioId,
      despues: `Se vaciaron ${antes.total.toLocaleString('es-AR')} filas de ${antes.detalle.length} tablas (stock, ventas, compras, caja, cobranzas y demás operatoria de práctica). El catálogo, los proveedores, los clientes y la configuración quedaron intactos.`,
    }]);
    return { ok: true, borradas: antes.total, detalle: antes.detalle };
  }
}

@Controller('sistema/respaldos')
export class RespaldosController {
  constructor(private readonly svc: RespaldosService) {}

  @Get('info') @Permiso('sistema.respaldos')
  info() { return this.svc.info(); }

  @Get('descargar') @Permiso('sistema.respaldos')
  descargar(@Res() res: Response, @Auth() sesion: Sesion) {
    return this.svc.volcar(res, sesion?.usuarioId ?? null);
  }

  /* La limpieza de fin de práctica es DEL SUPERADMIN y de nadie más: no es un
   * permiso delegable como los demás — borra la operatoria entera. El comodín
   * `*` es la definición de superadmin en todo el sistema. */
  private soloSuperadmin(sesion: Sesion) {
    if (!sesion?.permisos?.includes('*')) {
      throw new ForbiddenException('La limpieza del sistema es exclusiva del superadmin.');
    }
  }

  @Get('limpieza/ensayo') @Permiso('sistema.respaldos')
  ensayoLimpieza(@Auth() sesion: Sesion) {
    this.soloSuperadmin(sesion);
    return this.svc.ensayoLimpieza();
  }

  @Post('limpieza') @Permiso('sistema.respaldos')
  limpiar(@Body() body: any, @Auth() sesion: Sesion) {
    this.soloSuperadmin(sesion);
    /* La palabra tipeada es el segundo seguro: un clic solo, aunque pase por
     * dos modales, sigue siendo un clic. */
    if (String(body?.confirmar ?? '') !== 'LIMPIAR') {
      throw new BadRequestException('Para confirmar, escribí LIMPIAR tal cual.');
    }
    return this.svc.limpiarPractica(sesion?.usuarioId ?? null);
  }
}

@Module({
  imports: [AuditoriaModule],
  controllers: [RespaldosController],
  providers: [RespaldosService],
})
export class RespaldosModule {}
