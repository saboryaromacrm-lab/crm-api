import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { schema } from './schema';
import { DRIZZLE } from './drizzle';
import { resolverDatabaseUrl } from './url';

/**
 * Módulo global que provee el cliente Drizzle (token DRIZZLE) a toda la app.
 * Una sola pool de conexiones a PostgreSQL, leída de DATABASE_URL.
 */

/**
 * CUÁNTAS CONEXIONES A LA BASE, Y QUÉ PASA CUANDO SE ACABAN.
 *
 * El default de `pg` son 10, y este sistema pide MUCHAS MÁS DE 10 POR PEDIDO:
 * `GET /bootstrap` dispara ~20 consultas en paralelo (inventario.service.ts) y
 * `GET /ventas/catalogo` unas 14. O sea que UN SOLO pedido de esos se lleva el
 * pool entero y hace esperar a todo lo demás — los pollers del sidebar, el
 * chat, la venta que está cobrando otra caja.
 *
 * 20 no es un número mágico: es el techo razonable para un Postgres chico
 * (su default es 100 conexiones en total) dejando lugar a los respaldos y a
 * cualquier consulta manual. Se puede subir con DB_POOL_MAX sin tocar código.
 */
const POOL_MAX_DEFAULT = 20;

/**
 * LO MÁS IMPORTANTE DE ESTE ARCHIVO: el default de `connectionTimeoutMillis`
 * es 0, que NO significa "sin espera" sino "esperar PARA SIEMPRE".
 *
 * Con el pool agotado, los pedidos no fallaban: se COLGABAN. Se quedaban
 * esperando una conexión hasta que el navegador del cajero cortaba a los 20
 * segundos y mostraba "Failed to fetch" — sin dejar UNA SOLA LÍNEA en el log
 * del servidor, porque el pedido nunca llegó a ejecutarse. Por eso el problema
 * era invisible desde el lado del servidor.
 *
 * Con un plazo de 5 segundos, ese mismo caso ahora devuelve un error de verdad,
 * con su mensaje y su línea en el log. Falla igual, pero se puede diagnosticar.
 */
const CONNECTION_TIMEOUT_MS = 5_000;

/** Una consulta que se descontroló no puede retener su conexión para siempre. */
const STATEMENT_TIMEOUT_MS = 20_000;

/** Una conexión ociosa más de esto se devuelve: no tiene sentido retenerla. */
const IDLE_TIMEOUT_MS = 30_000;

@Global()
@Module({
  providers: [
    {
      provide: DRIZZLE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = resolverDatabaseUrl(config.get<string>('DATABASE_URL'));
        const max = Number(config.get<string>('DB_POOL_MAX')) || POOL_MAX_DEFAULT;
        const pool = new Pool({
          connectionString: url,
          max,
          idleTimeoutMillis: IDLE_TIMEOUT_MS,
          connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
          statement_timeout: STATEMENT_TIMEOUT_MS,
          /*
           * Mantiene viva la conexión TCP con paquetes de latido. Entre la API
           * y la base hay una red de Docker y, en el VPS, a veces un firewall:
           * cualquiera de los dos puede cortar en silencio una conexión que
           * lleva rato quieta, y el pool no se entera hasta que la usa.
           */
          keepAlive: true,
        });

        /*
         * ESTA ES LA LÍNEA QUE EVITA QUE SE CAIGA TODO EL SISTEMA DE GOLPE.
         *
         * Cuando una conexión que está guardada sin usar se muere —porque se
         * reinició Postgres, porque corrió el respaldo de la noche, porque la
         * red de Docker tosió—, la librería avisa emitiendo un evento `error`.
         *
         * En Node, un evento `error` QUE NADIE ESCUCHA no es un aviso: es una
         * excepción que voltea el proceso entero. Sin estas tres líneas, algo
         * tan menor como una conexión ociosa que se corta mataba la API, el
         * contenedor reiniciaba, y TODAS las cajas veían "Failed to fetch" al
         * mismo tiempo, sin ninguna explicación en ningún lado.
         *
         * Escuchándolo, la conexión rota se descarta y la vida sigue: el
         * próximo pedido abre una nueva y nadie se entera.
         */
        pool.on('error', (err) => {
          // eslint-disable-next-line no-console
          console.error('[pg] se murió una conexión ociosa del pool:', err.message);
        });

        /*
         * EL TERMÓMETRO. Cada 60 segundos deja escrito cómo está el pool, y
         * solo cuando hay algo para contar (alguien esperando, o el pool casi
         * lleno). Es lo que permite responder "¿se está quedando sin
         * conexiones?" mirando el log, en vez de suponer.
         *
         *   esperando > 0 sostenido  →  el pool quedó chico: subir DB_POOL_MAX
         *   abiertas que suben y nunca bajan  →  hay conexiones que se filtran
         */
        const termometro = setInterval(() => {
          const { totalCount, idleCount, waitingCount } = pool;
          if (waitingCount > 0 || totalCount >= max - 2) {
            // eslint-disable-next-line no-console
            console.warn(
              `[pg] pool exigido: abiertas=${totalCount}/${max} libres=${idleCount} esperando=${waitingCount}`,
            );
          }
        }, 60_000);
        // Que el termómetro no sea lo único que mantenga vivo al proceso.
        termometro.unref();

        return drizzle(pool, { schema, casing: 'snake_case' });
      },
    },
  ],
  exports: [DRIZZLE],
})
export class DbModule {}
