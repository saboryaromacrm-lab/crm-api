/**
 * DE DÓNDE SALE LA CONEXIÓN A LA BASE — y por qué el default no puede ser mudo.
 * ============================================================================
 * Seis archivos leían `process.env.DATABASE_URL ?? 'postgres://…@localhost…'`.
 * En la máquina de desarrollo ese default es cómodo: la base está en localhost y
 * uno se olvida del `.env` sin consecuencias.
 *
 * EN UN CONTENEDOR ES UNA TRAMPA. Ahí `localhost` no es el servidor de base: es
 * el propio contenedor de la API, donde no hay ningún Postgres escuchando. Así
 * que olvidarse la variable no da "falta DATABASE_URL" —que sería el problema
 * real y se arregla en diez segundos— sino un `ECONNREFUSED 127.0.0.1:5432`
 * con veinte líneas de stack de `pg-pool`, que se lee como un problema de red y
 * manda a revisar el servicio de base, el firewall y la red de Docker.
 *
 * Pasó de verdad en el primer deploy (14/8/2026) y costó un rato.
 *
 * La regla: con `NODE_ENV=production` —que es lo que pone la imagen— la falta de
 * la variable es un ERROR EXPLÍCITO. Fuera de producción, el default de
 * siempre, para no romperle el arranque a nadie en local.
 */
const LOCAL = 'postgres://postgres:postgres@localhost:5432/crm';

export function resolverDatabaseUrl(valor?: string | null): string {
  const url = String(valor ?? process.env.DATABASE_URL ?? '').trim();
  if (url) return url;

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Falta la variable DATABASE_URL.\n'
      + 'Si esto corre en un contenedor, OJO: `localhost` es el propio contenedor, '
      + 'no el servidor de base. La URL tiene que apuntar al host INTERNO del '
      + 'servicio de Postgres (el que muestra Dokploy en la ficha de la base), '
      + 'con la forma  postgresql://usuario:clave@host-interno:5432/basedatos',
    );
  }
  return LOCAL;
}
