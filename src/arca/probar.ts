/**
 * PROBAR LA CONEXIÓN CON ARCA — el paso §2.4 de la guía
 * ============================================================================
 * Tres llamadas de SOLO LECTURA, en orden, que contestan tres preguntas
 * distintas. **No emite nada**: se puede correr las veces que haga falta.
 *
 *   1. FEDummy                 ¿el servicio de ARCA está vivo?
 *   2. login WSAA              ¿el certificado sirve y está autorizado?
 *   3. FECompUltimoAutorizado  ¿el permiso funciona sobre ESTE punto de venta?
 *
 * El orden importa para el diagnóstico: si (1) falla, el problema es de ARCA y
 * no tuyo; si (1) anda y (2) falla, es el certificado; si (1) y (2) andan y (3)
 * falla, es el punto de venta o la autorización al servicio.
 *
 * **Si esto no da OK, no sigas.** Cualquier cosa que se escriba después va a
 * parecer un bug del código cuando en realidad es un trámite a medias.
 *
 * Cómo correrlo:
 *   desarrollo   npx ts-node -r tsconfig-paths/register src/arca/probar.ts
 *   contenedor   node dist/arca/probar.js
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../db/schema';
import { resolverDatabaseUrl } from '../db/url';
import { ARCA, arcaDisponible, motivoNoDisponible } from './config';
import { CBTE_TIPO } from './comprobante';
import { obtenerTicket } from './wsaa';
import { feDummy, ultimoAutorizado } from './wsfe';

const ok = (s: string) => `  \x1b[32m✓\x1b[0m ${s}`;
const mal = (s: string) => `  \x1b[31m✗\x1b[0m ${s}`;
const info = (s: string) => `  \x1b[2m·\x1b[0m ${s}`;

async function main() {
  console.log('\n══ Prueba de conexión con ARCA ══\n');

  const entorno = ARCA.produccion
    ? '\x1b[41m\x1b[97m PRODUCCIÓN \x1b[0m (las facturas son REALES)'
    : '\x1b[46m\x1b[30m HOMOLOGACIÓN \x1b[0m (sin valor fiscal)';
  console.log(`  Entorno:        ${entorno}`);
  console.log(info(`CUIT:           ${ARCA.cuit || '(sin definir)'}`));
  console.log(info(`Punto de venta: ${ARCA.ptoVta || '(sin definir)'}`));
  console.log(info(`Certificado:    ${ARCA.certPath || '(sin definir)'}`));
  console.log(info(`Clave privada:  ${ARCA.keyPath ? '(definida)' : '(sin definir)'}`));
  console.log('');

  if (!arcaDisponible()) {
    console.log(mal(motivoNoDisponible() ?? 'ARCA no está configurado.'));
    console.log('\n  Cargá las variables ARCA_* y volvé a probar.\n');
    process.exit(1);
  }

  /* 1 · ¿Vive el servicio? Sin credenciales: aísla "ARCA caído" de "mi
   *     certificado no anda", que es la primera bifurcación del diagnóstico. */
  try {
    const d = await feDummy();
    if (d.ok) console.log(ok(`FEDummy — el servicio responde (app ${d.appServer}, db ${d.dbServer}, auth ${d.authServer})`));
    else console.log(mal(`FEDummy — ARCA responde pero con problemas: app ${d.appServer}, db ${d.dbServer}, auth ${d.authServer}`));
  } catch (e) {
    console.log(mal(`FEDummy — no se pudo contactar a ARCA: ${(e as Error).message}`));
    console.log('\n  Es un problema de ARCA o de la red del servidor, no del certificado.\n');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: resolverDatabaseUrl(process.env.DATABASE_URL) });
  const db = drizzle(pool, { schema });

  try {
    /* 2 · El certificado. Acá caen el certificado equivocado, el vencido, el
     *     que no está autorizado al servicio, y el desfasaje de reloj. */
    try {
      const ta = await obtenerTicket(db, 'wsfe');
      const horas = ((ta.expiresAt.getTime() - Date.now()) / 3600_000).toFixed(1);
      console.log(ok(`WSAA — ticket de acceso obtenido (vence en ${horas} h)`));
    } catch (e) {
      console.log(mal(`WSAA — el certificado no pudo autenticar: ${(e as Error).message}`));
      console.log('\n  Revisá: que el certificado sea del entorno correcto, que esté autorizado');
      console.log('  al servicio "wsfe" en el Administrador de Relaciones, y que el CUIT coincida.\n');
      process.exit(1);
    }

    /* 3 · El permiso sobre ESTE punto de venta. Un PV de "Factura en Línea"
     *     falla acá: el webservice no lo reconoce. */
    console.log('');
    for (const [nombre, tipo] of [
      ['Factura A', CBTE_TIPO.factura_a],
      ['Factura B', CBTE_TIPO.factura_b],
      ['Nota de crédito A', CBTE_TIPO.nota_credito_a],
      ['Nota de crédito B', CBTE_TIPO.nota_credito_b],
    ] as const) {
      try {
        const n = await ultimoAutorizado(db, tipo as number);
        console.log(ok(`${nombre.padEnd(18)} último emitido: N° ${n}${n === 0 ? '  (nunca se facturó por webservice)' : ''}`));
      } catch (e) {
        console.log(mal(`${nombre.padEnd(18)} ${(e as Error).message}`));
      }
    }

    console.log('\n  \x1b[32mListo.\x1b[0m Si las tres dieron OK, la conexión funciona y se puede seguir.\n');
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(`\n  Error inesperado: ${e?.message ?? e}\n`);
  process.exit(1);
});
