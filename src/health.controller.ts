import { Controller, Get, Inject } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Publico } from './auth/auth.decoradores';
import { DRIZZLE, Database } from './db/drizzle';

@Controller('health')
export class HealthController {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Público: es lo que consulta el deploy para saber si el servicio quedó
   * andando, y en ese momento todavía no hay ninguna sesión. No dice nada del
   * negocio — solo que el proceso está vivo.
   *
   * DELIBERADAMENTE NO TOCA LA BASE. Es el `HEALTHCHECK` del contenedor: si
   * consultara la base, un hipo de Postgres marcaría el contenedor como
   * enfermo y Docker lo reiniciaría — convirtiendo una demora de la base en
   * una caída del servicio. Lo que necesita base vive en `/health/version`.
   */
  @Publico()
  @Get()
  check() {
    return { status: 'ok', service: 'crm-api', ts: new Date().toISOString() };
  }

  /**
   * QUÉ VERSIÓN ESTÁ CORRIENDO, sin tener que entrar al sistema.
   *
   * Nació de un problema real (21/9/2026): después de un deploy no había forma
   * de saber desde afuera si el contenedor que contestaba era el nuevo o el
   * viejo. `/health` devuelve 200 en los dos casos, y todas las rutas que
   * podrían delatarlo piden sesión. Cuando una función nueva no aparecía,
   * "¿no funciona?" y "¿no se deployó?" eran indistinguibles.
   *
   * `migraciones` es el número de migraciones aplicadas EN LA BASE: sube con
   * cada una, así que alcanza para saber si la última llegó. Es un conteo —
   * no dice nada del negocio ni de nadie, y por eso puede ser público.
   *
   * Si la base no contesta devuelve `null` en vez de romper: esto es un
   * diagnóstico, y un diagnóstico que se cae cuando hay un problema es
   * exactamente lo contrario de lo que hace falta.
   */
  @Publico()
  @Get('version')
  async version() {
    let migraciones: number | null = null;
    try {
      const r: any = await this.db.execute(
        sql`select count(*)::int as n from drizzle.__drizzle_migrations`,
      );
      const fila = (r?.rows ?? r)?.[0];
      migraciones = Number(fila?.n ?? fila?.count) || 0;
    } catch { /* la base no contesta: el diagnóstico no puede ser el problema */ }
    return { service: 'crm-api', migraciones, ts: new Date().toISOString() };
  }
}
