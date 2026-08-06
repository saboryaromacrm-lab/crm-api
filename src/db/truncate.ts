import { Pool } from 'pg';

/**
 * Vacía las tablas de datos y reinicia las secuencias de id.
 * `configuracion` queda intacta a propósito: son preferencias del usuario, no
 * datos de ejemplo, y volver a sembrar no debería perderlas.
 *
 * IMPORTANTE: toda tabla de datos nueva se agrega también acá. Si se olvida,
 * re-sembrar no la limpia y los datos de ejemplo se ACUMULAN en silencio —
 * pasó con `ofertas`, que terminó con tres copias de cada promoción.
 */
export async function truncateAll(pool: Pool) {
  await pool.query(`TRUNCATE TABLE
    movimientos, transferencia_hist, transferencia_items, transferencias, incidencias,
    comprobante_items, comprobantes,
    cobranza_imputaciones, cobranza_pagos, cobranzas,
    presupuesto_items, presupuestos,
    venta_pagos, venta_extras, venta_items, ventas, clientes,
    caja_controles, caja_movimientos, caja_sesiones, web_imagenes, web_eventos,
    oferta_componentes, oferta_alcances, ofertas,
    precio_historial, producto_proveedor_costos,
    stock, cliente_listas, producto_listas, reglas_marca, listas_venta, modalidades_venta,
    producto_proveedores, presentaciones,
    producto_etiquetas, etiquetas, subcategorias, categorias, marcas,
    productos, proveedores, usuarios, roles, sucursales
    RESTART IDENTITY CASCADE`);
}
