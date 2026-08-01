import { Pool } from 'pg';

/**
 * Vacía las tablas de datos y reinicia las secuencias de id.
 * `configuracion` queda intacta a propósito: son preferencias del usuario, no
 * datos de ejemplo, y volver a sembrar no debería perderlas.
 */
export async function truncateAll(pool: Pool) {
  await pool.query(`TRUNCATE TABLE
    movimientos, transferencia_hist, transferencia_items, transferencias, incidencias,
    comprobante_items, comprobantes,
    cobranza_imputaciones, cobranza_pagos, cobranzas,
    venta_pagos, venta_extras, venta_items, ventas, clientes,
    caja_movimientos, caja_sesiones,
    stock, listas_precio, producto_proveedores, presentaciones, productos, proveedores, usuarios, sucursales
    RESTART IDENTITY CASCADE`);
}
