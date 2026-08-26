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
import { Controller, Get, Inject, Injectable, Module, Res } from '@nestjs/common';
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
}

@Module({
  imports: [AuditoriaModule],
  controllers: [RespaldosController],
  providers: [RespaldosService],
})
export class RespaldosModule {}
