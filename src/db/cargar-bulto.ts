/**
 * CARGAR EL BULTO DE LOS PRODUCTOS DESDE EL FORMATO DE COMPRA
 * ============================================================================
 * `productos.unidades_por_bulto` es lo que hace que la cajera pueda pedir "3
 * cajas" en vez de tipear 36. Cuando está en 1 el selector de caja ni aparece,
 * así que un producto sin este dato se sigue pidiendo por unidad — no se rompe
 * nada, simplemente no se gana nada.
 *
 * DE DÓNDE SALE EL NÚMERO, y por qué no se inventa. `producto_proveedores.
 * cantidad` es el formato de compra: el "Caja x12" que alguien ya cargó
 * MIRANDO LA FACTURA para poder comparar costos entre proveedores. Es el mismo
 * bulto físico, cargado con otro propósito. Este script lo copia y nada más.
 *
 * Poner un número a ojo sería peor que dejarlo vacío: la cajera pide 3 cajas
 * confiando en el dato, y si el bulto está mal le llegan 60 unidades en vez de
 * 36 — con el stock de dos sucursales quedando mal y nadie mirando el número
 * que lo causó.
 *
 * LAS CUATRO CONDICIONES, y cada una tiene su motivo:
 *
 *   · `unidades_por_bulto <= 1` — **solo rellena lo vacío, nunca pisa**. Si
 *     alguien lo cargó a mano mirando la caja, ese dato vale más que el
 *     formato de compra y no se toca.
 *   · un solo formato distinto — si dos proveedores declaran bultos distintos
 *     para el mismo producto no hay respuesta única, y elegir una sería
 *     inventar. Esos quedan para revisión humana.
 *   · `tipo = 'entero'` — en granel la unidad de pedido es el paquete, y "una
 *     caja de paquetes de 500 g" no es algo que el sistema sepa.
 *   · `estado = 'activo'` — un archivado no se pide.
 *
 * ES IDEMPOTENTE: correrlo dos veces seguidas no cambia nada la segunda vez
 * (después de la primera ya ninguno cumple `unidades_por_bulto <= 1`).
 *
 * NO ES UNA MIGRACIÓN A PROPÓSITO. Las migraciones corren solas al desplegar;
 * esto **escribe datos que dependen de lo que haya cargado en producción**, y
 * el resultado no se puede saber de antemano desde acá. Así que se mira
 * primero y se aplica después, igual que la importación de catálogos.
 *
 *   npm run db:bulto              → VISTA PREVIA, no escribe nada
 *   npm run db:bulto -- --aplicar → escribe, en una sola transacción
 */
import 'dotenv/config';
import { resolverDatabaseUrl } from './url';
import { Pool } from 'pg';

const log = (s = '') => {
  // eslint-disable-next-line no-console
  console.log(s);
};

/**
 * Los candidatos. El `HAVING` es el que descarta los ambiguos: agrupa por
 * producto y exige que TODOS sus proveedores declaren el mismo bulto.
 */
const CANDIDATOS = `
  SELECT p.id,
         p.nombre,
         f.cant,
         (SELECT string_agg(DISTINCT pr.nombre, ', ')
            FROM producto_proveedores pp2
            JOIN proveedores pr ON pr.id = pp2.proveedor_id
           WHERE pp2.producto_id = p.id AND pp2.cantidad > 1) AS proveedores
    FROM productos p
    JOIN (SELECT pp.producto_id, max(pp.cantidad) AS cant
            FROM producto_proveedores pp
           GROUP BY pp.producto_id
          HAVING count(DISTINCT pp.cantidad) = 1 AND max(pp.cantidad) > 1) f
      ON f.producto_id = p.id
   WHERE p.estado = 'activo' AND p.tipo = 'entero' AND p.unidades_por_bulto <= 1
   ORDER BY p.nombre`;

/** Los que quedan afuera y hay que cargar a mano: no tienen de dónde sacarlo. */
const SIN_FUENTE = `
  SELECT p.id, p.nombre
    FROM productos p
   WHERE p.estado = 'activo' AND p.tipo = 'entero' AND p.unidades_por_bulto <= 1
     AND NOT EXISTS (SELECT 1 FROM producto_proveedores pp
                      WHERE pp.producto_id = p.id AND pp.cantidad > 1)
   ORDER BY p.nombre`;

/** Los ambiguos: tienen formato de compra, pero más de uno y distintos. */
const AMBIGUOS = `
  SELECT p.id, p.nombre, string_agg(DISTINCT pp.cantidad::int::text, ' / ') AS formatos
    FROM productos p
    JOIN producto_proveedores pp ON pp.producto_id = p.id
   WHERE p.estado = 'activo' AND p.tipo = 'entero' AND p.unidades_por_bulto <= 1
     AND pp.cantidad > 1
   GROUP BY p.id, p.nombre
  HAVING count(DISTINCT pp.cantidad) > 1
   ORDER BY p.nombre`;

/**
 * Los que YA tenían bulto y no coinciden con su formato de compra. No se tocan
 * —el dato de la ficha manda— pero se avisan: uno de los dos está mal tipeado,
 * y el que está mal puede ser cualquiera de los dos.
 */
const DISCREPANTES = `
  SELECT p.id, p.nombre, p.unidades_por_bulto::int AS ficha, pp.cantidad::int AS compra
    FROM productos p
    JOIN producto_proveedores pp ON pp.producto_id = p.id
   WHERE p.estado = 'activo' AND p.tipo = 'entero'
     AND p.unidades_por_bulto > 1 AND pp.cantidad > 1
     AND p.unidades_por_bulto <> pp.cantidad
   ORDER BY p.nombre`;

const APLICAR = `
  UPDATE productos p
     SET unidades_por_bulto = f.cant
    FROM (SELECT pp.producto_id, max(pp.cantidad) AS cant
            FROM producto_proveedores pp
           GROUP BY pp.producto_id
          HAVING count(DISTINCT pp.cantidad) = 1 AND max(pp.cantidad) > 1) f
   WHERE p.id = f.producto_id
     AND p.estado = 'activo'
     AND p.tipo = 'entero'
     AND p.unidades_por_bulto <= 1
  RETURNING p.id`;

async function main() {
  const aplicar = process.argv.includes('--aplicar');
  const pool = new Pool({ connectionString: resolverDatabaseUrl() });
  try {
    const [cand, sin, amb, disc] = await Promise.all([
      pool.query(CANDIDATOS), pool.query(SIN_FUENTE), pool.query(AMBIGUOS), pool.query(DISCREPANTES),
    ]);

    log(aplicar ? '=== APLICANDO ===' : '=== VISTA PREVIA (no se escribe nada) ===');
    log();
    log(`Se les cargaría el bulto desde el formato de compra: ${cand.rowCount}`);
    for (const r of cand.rows) {
      log(`   x${String(r.cant).padStart(3)}  ${String(r.nombre).slice(0, 46).padEnd(46)}  (${r.proveedores ?? ''})`);
    }

    if (amb.rowCount) {
      log();
      log(`AMBIGUOS — dos proveedores con bultos distintos, NO se tocan: ${amb.rowCount}`);
      for (const r of amb.rows) log(`   ${String(r.nombre).slice(0, 46).padEnd(46)}  formatos: ${r.formatos}`);
    }

    log();
    log(`SIN FUENTE — hay que cargarlos a mano mirando la caja: ${sin.rowCount}`);
    for (const r of sin.rows) log(`   #${String(r.id).padEnd(4)} ${String(r.nombre).slice(0, 50)}`);

    if (disc.rowCount) {
      log();
      log(`PARA REVISAR — la ficha y el formato de compra no coinciden (no se tocan): ${disc.rowCount}`);
      for (const r of disc.rows) {
        log(`   #${String(r.id).padEnd(4)} ${String(r.nombre).slice(0, 40).padEnd(40)} ficha x${r.ficha} vs compra x${r.compra}`);
      }
    }

    if (!aplicar) {
      log();
      log('Nada se escribió. Para aplicarlo:  npm run db:bulto -- --aplicar');
      return;
    }

    /* Todo o nada: son datos que alimentan pedidos, y quedar a mitad de camino
     * sería peor que no haber corrido — nadie sabría cuáles se cargaron. */
    const cliente = await pool.connect();
    try {
      await cliente.query('BEGIN');
      const r = await cliente.query(APLICAR);
      await cliente.query('COMMIT');
      log();
      log(`LISTO: ${r.rowCount} producto(s) actualizado(s).`);
      log(`Siguen sin bulto: ${sin.rowCount} (sin fuente)${amb.rowCount ? ` + ${amb.rowCount} (ambiguos)` : ''}.`);
    } catch (e) {
      await cliente.query('ROLLBACK');
      throw e;
    } finally {
      cliente.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('Error cargando el bulto:', e);
  process.exit(1);
});
