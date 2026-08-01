/**
 * ESQUEMA DE BASE DE DATOS (Drizzle / PostgreSQL)
 * ============================================================================
 * Modela el subsistema de inventario del CRM (Compras + Almacén). Réplica del
 * modelo que hoy vive en el frontend (localStorage), ahora persistido.
 *
 * Modelo de stock SIN LOTE: **Producto × Sucursal × Presentación × Estado**.
 * Convención de columnas: snake_case (configurado en drizzle.config + db.provider).
 */
import {
  pgTable,
  pgEnum,
  serial,
  integer,
  text,
  doublePrecision,
  timestamp,
  boolean,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/* ---------------- Enums ---------------- */
export const tipoProductoEnum = pgEnum('tipo_producto', ['granel', 'entero']);
export const tipoSucursalEnum = pgEnum('tipo_sucursal', ['distribuidora', 'express']);
export const rolEnum = pgEnum('rol', ['admin', 'fraccionador', 'vendedor']);
export const estadoStockEnum = pgEnum('estado_stock', [
  'disponible', 'comprometido', 'retenido', 'defectuoso', 'vencido',
]);
export const estadoTransferEnum = pgEnum('estado_transferencia', [
  'pendiente', 'preparada', 'transito', 'recibida', 'cancelada',
]);
export const estadoIncidenciaEnum = pgEnum('estado_incidencia', [
  'pendiente', 'revision', 'resuelta',
]);
export const tipoMovEnum = pgEnum('tipo_movimiento', [
  'compra', 'fraccionamiento', 'venta_granel', 'venta_fraccionada', 'devolucion',
  'ajuste', 'merma', 'vencido', 'defectuoso', 'transferencia',
]);
/**
 * Condición frente al IVA. La usan las DOS puntas: en el cliente define la
 * letra del comprobante que emitimos; en el proveedor define si su factura
 * discrimina IVA (un monotributista no lo hace, y asumir 21% infla el total).
 */
export const condicionIvaEnum = pgEnum('condicion_iva', [
  'responsable_inscripto', 'monotributo', 'consumidor_final', 'exento', 'no_categorizado',
]);
export const tipoDocEnum = pgEnum('tipo_doc', ['cuit', 'cuil', 'dni', 'sin_identificar']);

/* ---------------- Catálogo base ---------------- */
export const sucursales = pgTable('sucursales', {
  id: serial('id').primaryKey(),
  nombre: text('nombre').notNull(),
  tipo: tipoSucursalEnum('tipo').notNull().default('express'),
});

export const proveedores = pgTable('proveedores', {
  id: serial('id').primaryKey(),
  nombre: text('nombre').notNull(),
  cuit: text('cuit').notNull().default(''),
  // Define si su factura discrimina IVA: de acá sale la alícuota por defecto
  // de los ítems del comprobante. Un monotributista factura sin IVA.
  condicionIva: condicionIvaEnum('condicion_iva').notNull().default('responsable_inscripto'),
  direccion: text('direccion').notNull().default(''),
  telefono: text('telefono').notNull().default(''),
  email: text('email').notNull().default(''),
});

export const usuarios = pgTable('usuarios', {
  id: serial('id').primaryKey(),
  nombre: text('nombre').notNull(),
  rol: rolEnum('rol').notNull().default('vendedor'),
});

export const productos = pgTable('productos', {
  id: serial('id').primaryKey(),
  nombre: text('nombre').notNull(),
  marca: text('marca').notNull().default(''),
  categoria: text('categoria').notNull().default('General'),
  iva: doublePrecision('iva').notNull().default(21),
  tipo: tipoProductoEnum('tipo').notNull().default('entero'),
  stockMin: doublePrecision('stock_min').notNull().default(0),
  // Código que lee el escáner del punto de venta. Vacío = se busca por nombre.
  codigoBarras: text('codigo_barras').notNull().default(''),
  // Proveedor "activo" (con el que vino la última vez); define costo y precios.
  proveedorActivoId: integer('proveedor_activo_id').references(() => proveedores.id, { onDelete: 'set null' }),
}, (t) => ({
  ixCodigo: index('ix_productos_codigo').on(t.codigoBarras),
}));

/**
 * Presentaciones (tamaños fraccionables) de un producto a granel.
 *
 * `recargo` es lo que agrega el FRACCIONAMIENTO (envase y mano de obra), no el
 * margen completo: el precio parte del precio por kg de la lista del cliente y
 * después se le suma este recargo. Así un mayorista paga la bolsa de 1 kg a
 * precio mayorista, que antes no pasaba.
 *
 *     precio = costoNeto/kg × (1 + ganancia_lista%) × tamKg × (1 + recargo%)
 */
export const presentaciones = pgTable('presentaciones', {
  id: serial('id').primaryKey(),
  productoId: integer('producto_id').notNull().references(() => productos.id, { onDelete: 'cascade' }),
  tamKg: doublePrecision('tam_kg').notNull(),
  recargo: doublePrecision('recargo').notNull().default(0),
  // Cada tamaño fraccionado lleva su propia etiqueta, así que su propio código.
  codigoBarras: text('codigo_barras').notNull().default(''),
}, (t) => ({
  ixCodigo: index('ix_presentaciones_codigo').on(t.codigoBarras),
}));

/* Costo de un producto según cada proveedor (descuento y flete en %). */
export const productoProveedores = pgTable('producto_proveedores', {
  id: serial('id').primaryKey(),
  productoId: integer('producto_id').notNull().references(() => productos.id, { onDelete: 'cascade' }),
  proveedorId: integer('proveedor_id').notNull().references(() => proveedores.id, { onDelete: 'cascade' }),
  costo: doublePrecision('costo').notNull().default(0),
  descuento: doublePrecision('descuento').notNull().default(0),
  flete: doublePrecision('flete').notNull().default(0),
}, (t) => ({
  uq: uniqueIndex('uq_producto_proveedor').on(t.productoId, t.proveedorId),
}));

/** De dónde salió un cambio de costo. Define cómo se lee la auditoría. */
export const origenCostoEnum = pgEnum('origen_costo', [
  'alta', 'manual', 'masiva', 'recepcion', 'reversion',
]);

/**
 * HISTORIAL DE COSTOS — append-only.
 * ============================================================================
 * `producto_proveedores` guarda el costo VIGENTE (desnormalizado, porque se lee
 * en cada cálculo de precio). Esta tabla guarda cómo se llegó hasta ahí.
 *
 * Cada fila lleva el valor anterior Y el nuevo. Es redundante a propósito:
 *  - deshacer es restaurar los `*Anterior` de la fila, sin buscar la anterior;
 *  - la fila se entiende sola al leerla ("pasó de 700 a 784").
 *
 * `lote` agrupa una actualización masiva: revertir = revertir el lote entero.
 */
export const productoProveedorCostos = pgTable('producto_proveedor_costos', {
  id: serial('id').primaryKey(),
  productoProveedorId: integer('producto_proveedor_id').notNull()
    .references(() => productoProveedores.id, { onDelete: 'cascade' }),
  fecha: timestamp('fecha', { withTimezone: true }).notNull().defaultNow(),
  costoAnterior: doublePrecision('costo_anterior').notNull().default(0),
  descuentoAnterior: doublePrecision('descuento_anterior').notNull().default(0),
  fleteAnterior: doublePrecision('flete_anterior').notNull().default(0),
  costo: doublePrecision('costo').notNull().default(0),
  descuento: doublePrecision('descuento').notNull().default(0),
  flete: doublePrecision('flete').notNull().default(0),
  origen: origenCostoEnum('origen').notNull().default('manual'),
  // Cambio de PROVEEDOR ACTIVO. Mueve el precio tanto como un cambio de costo,
  // así que se audita en la misma tabla: sin esto, el historial no puede
  // explicar por qué cambió un precio. Nulos = esta fila no tocó el activo.
  activoAnterior: integer('activo_anterior'),
  activoNuevo: integer('activo_nuevo'),
  motivo: text('motivo').notNull().default(''),
  lote: text('lote').notNull().default(''),
  usuarioId: integer('usuario_id').references(() => usuarios.id, { onDelete: 'set null' }),
  // Comprobante que originó el cambio, cuando vino de una recepción.
  comprobanteId: integer('comprobante_id'),
}, (t) => ({
  ixEntrada: index('ix_ppc_entrada').on(t.productoProveedorId, t.fecha),
  ixLote: index('ix_ppc_lote').on(t.lote),
}));

/* Listas de precio (minorista, mayorista, oferta…) por % de ganancia. */
export const listasPrecio = pgTable('listas_precio', {
  id: serial('id').primaryKey(),
  productoId: integer('producto_id').notNull().references(() => productos.id, { onDelete: 'cascade' }),
  nombre: text('nombre').notNull(),
  ganancia: doublePrecision('ganancia').notNull().default(0),
});

/* ---------------- Stock (Producto × Sucursal × Presentación × Estado) ---------------- */
export const stock = pgTable('stock', {
  id: serial('id').primaryKey(),
  productoId: integer('producto_id').notNull().references(() => productos.id, { onDelete: 'cascade' }),
  sucursalId: integer('sucursal_id').notNull().references(() => sucursales.id, { onDelete: 'cascade' }),
  presentacionId: integer('presentacion_id').references(() => presentaciones.id, { onDelete: 'cascade' }),
  estado: estadoStockEnum('estado').notNull().default('disponible'),
  cantidad: doublePrecision('cantidad').notNull().default(0),
});

/* ---------------- Movimientos (registro inmutable de altas/bajas) ---------------- */
export const movimientos = pgTable('movimientos', {
  id: serial('id').primaryKey(),
  fecha: timestamp('fecha', { withTimezone: true }).notNull().defaultNow(),
  tipo: tipoMovEnum('tipo').notNull(),
  productoId: integer('producto_id').references(() => productos.id, { onDelete: 'set null' }),
  sucursalId: integer('sucursal_id').references(() => sucursales.id, { onDelete: 'set null' }),
  presentacionId: integer('presentacion_id').references(() => presentaciones.id, { onDelete: 'set null' }),
  signo: integer('signo').notNull().default(0),
  cantidad: doublePrecision('cantidad').notNull().default(0),
  unidad: text('unidad').notNull().default(''),
  motivo: text('motivo').notNull().default(''),
  presLabel: text('pres_label').notNull().default(''),
  estadoDesde: estadoStockEnum('estado_desde'),
  estadoHacia: estadoStockEnum('estado_hacia'),
  sucursalDestinoId: integer('sucursal_destino_id').references(() => sucursales.id, { onDelete: 'set null' }),
  vencimiento: timestamp('vencimiento', { withTimezone: true }),
  proveedorNombre: text('proveedor_nombre').notNull().default(''),
  usuarioId: integer('usuario_id').references(() => usuarios.id, { onDelete: 'set null' }),
  refTransferenciaId: integer('ref_transferencia_id'),
  refIncidenciaId: integer('ref_incidencia_id'),
  descripcion: text('descripcion').notNull().default(''),
});

/* ---------------- Transferencias entre sucursales ---------------- */
export const transferencias = pgTable('transferencias', {
  id: serial('id').primaryKey(),
  codigo: text('codigo').notNull().default(''),
  fecha: timestamp('fecha', { withTimezone: true }).notNull().defaultNow(),
  origenId: integer('origen_id').notNull().references(() => sucursales.id, { onDelete: 'restrict' }),
  destinoId: integer('destino_id').notNull().references(() => sucursales.id, { onDelete: 'restrict' }),
  usuarioId: integer('usuario_id').references(() => usuarios.id, { onDelete: 'set null' }),
  estado: estadoTransferEnum('estado').notNull().default('pendiente'),
});

export const transferenciaItems = pgTable('transferencia_items', {
  id: serial('id').primaryKey(),
  transferenciaId: integer('transferencia_id').notNull().references(() => transferencias.id, { onDelete: 'cascade' }),
  productoId: integer('producto_id').notNull().references(() => productos.id, { onDelete: 'cascade' }),
  presentacionId: integer('presentacion_id').references(() => presentaciones.id, { onDelete: 'set null' }),
  cantidad: doublePrecision('cantidad').notNull().default(0),
});

export const transferenciaHist = pgTable('transferencia_hist', {
  id: serial('id').primaryKey(),
  transferenciaId: integer('transferencia_id').notNull().references(() => transferencias.id, { onDelete: 'cascade' }),
  estado: estadoTransferEnum('estado').notNull(),
  fecha: timestamp('fecha', { withTimezone: true }).notNull().defaultNow(),
  usuarioId: integer('usuario_id').references(() => usuarios.id, { onDelete: 'set null' }),
});

/* ---------------- Incidencias ---------------- */
export const incidencias = pgTable('incidencias', {
  id: serial('id').primaryKey(),
  codigo: text('codigo').notNull().default(''),
  fecha: timestamp('fecha', { withTimezone: true }).notNull().defaultNow(),
  tipo: text('tipo').notNull(),
  estado: estadoIncidenciaEnum('estado').notNull().default('pendiente'),
  responsableId: integer('responsable_id').references(() => usuarios.id, { onDelete: 'set null' }),
  motivo: text('motivo').notNull().default(''),
  productoId: integer('producto_id').notNull().references(() => productos.id, { onDelete: 'cascade' }),
  sucursalId: integer('sucursal_id').notNull().references(() => sucursales.id, { onDelete: 'cascade' }),
  presentacionId: integer('presentacion_id').references(() => presentaciones.id, { onDelete: 'set null' }),
  cantidad: doublePrecision('cantidad').notNull().default(0),
  unidad: text('unidad').notNull().default(''),
  resolucion: text('resolucion'),
  fechaResolucion: timestamp('fecha_resolucion', { withTimezone: true }),
  activa: boolean('activa').notNull().default(true),
});

/* ---------------- Facturación / comprobantes de compra ---------------- */
export const tipoComprobanteEnum = pgEnum('tipo_comprobante', [
  'orden_compra', 'remito', 'factura', 'nota_credito', 'nota_debito',
]);
export const letraComprobanteEnum = pgEnum('letra_comprobante', ['A', 'B', 'C', 'X']);
export const estadoComprobanteEnum = pgEnum('estado_comprobante', ['borrador', 'confirmado', 'anulado']);
export const condicionPagoEnum = pgEnum('condicion_pago', ['contado', 'cuenta_corriente']);

/**
 * Comprobante de compra (document-centric). Una sola tabla para factura, remito,
 * nota de crédito/débito y orden de compra; el `tipo` define el circuito y su
 * impacto en stock (recepción) y en la cuenta corriente del proveedor.
 */
export const comprobantes = pgTable('comprobantes', {
  id: serial('id').primaryKey(),
  tipo: tipoComprobanteEnum('tipo').notNull(),
  letra: letraComprobanteEnum('letra').notNull().default('A'),
  puntoVenta: text('punto_venta').notNull().default('0001'),
  numero: integer('numero'),
  // Dos fechas distintas y las dos importan: `fecha` es la que trae el papel
  // del proveedor (define el período fiscal) y `fechaCarga` es cuándo se
  // registró en el sistema (dice cuándo entró de verdad a la operación).
  fecha: timestamp('fecha', { withTimezone: true }).notNull().defaultNow(),
  fechaCarga: timestamp('fecha_carga', { withTimezone: true }).notNull().defaultNow(),
  proveedorId: integer('proveedor_id').notNull().references(() => proveedores.id, { onDelete: 'restrict' }),
  sucursalId: integer('sucursal_id').references(() => sucursales.id, { onDelete: 'set null' }),
  estado: estadoComprobanteEnum('estado').notNull().default('confirmado'),
  condicionPago: condicionPagoEnum('condicion_pago').notNull().default('cuenta_corriente'),
  vencimientoPago: timestamp('vencimiento_pago', { withTimezone: true }),
  // Si el comprobante ingresa mercadería (remito o factura con recepción) suma stock.
  recepcion: boolean('recepcion').notNull().default(false),
  subtotalNeto: doublePrecision('subtotal_neto').notNull().default(0),
  ivaTotal: doublePrecision('iva_total').notNull().default(0),
  total: doublePrecision('total').notNull().default(0),
  // NC/ND referencian la factura que ajustan (sin FK dura para evitar autorreferencia).
  refComprobanteId: integer('ref_comprobante_id'),
  observaciones: text('observaciones').notNull().default(''),
  usuarioId: integer('usuario_id').references(() => usuarios.id, { onDelete: 'set null' }),
});

export const comprobanteItems = pgTable('comprobante_items', {
  id: serial('id').primaryKey(),
  comprobanteId: integer('comprobante_id').notNull().references(() => comprobantes.id, { onDelete: 'cascade' }),
  productoId: integer('producto_id').notNull().references(() => productos.id, { onDelete: 'restrict' }),
  presentacionId: integer('presentacion_id').references(() => presentaciones.id, { onDelete: 'set null' }),
  cantidad: doublePrecision('cantidad').notNull().default(0),
  costoUnitario: doublePrecision('costo_unitario').notNull().default(0),
  descuento: doublePrecision('descuento').notNull().default(0),
  iva: doublePrecision('iva').notNull().default(21),
  subtotal: doublePrecision('subtotal').notNull().default(0),
});

/* ============================================================================
 * VENTAS
 * ==========================================================================*/

/**
 * Cliente. Más que una agenda: concentra las reglas comerciales que el circuito
 * de venta consulta (letra del comprobante, lista de precios, crédito).
 */
export const clientes = pgTable('clientes', {
  id: serial('id').primaryKey(),
  nombre: text('nombre').notNull(),                       // razón social
  nombreFantasia: text('nombre_fantasia').notNull().default(''),
  tipoDoc: tipoDocEnum('tipo_doc').notNull().default('dni'),
  numeroDoc: text('numero_doc').notNull().default(''),
  condicionIva: condicionIvaEnum('condicion_iva').notNull().default('consumidor_final'),
  direccion: text('direccion').notNull().default(''),
  localidad: text('localidad').notNull().default(''),
  telefono: text('telefono').notNull().default(''),
  email: text('email').notNull().default(''),
  // Comercial
  listaPrecio: text('lista_precio').notNull().default(''), // '' = la default de la config
  descuento: doublePrecision('descuento').notNull().default(0), // % general del cliente
  vendedorId: integer('vendedor_id').references(() => usuarios.id, { onDelete: 'set null' }),
  sucursalId: integer('sucursal_id').references(() => sucursales.id, { onDelete: 'set null' }),
  // Cuenta corriente
  ctaCteHabilitada: boolean('cta_cte_habilitada').notNull().default(false),
  limiteCredito: doublePrecision('limite_credito').notNull().default(0), // 0 = sin tope
  diasPlazo: integer('dias_plazo').notNull().default(0),
  observaciones: text('observaciones').notNull().default(''),
  // Baja lógica: un cliente con historial nunca se borra.
  activo: boolean('activo').notNull().default(true),
  // El "Consumidor Final" genérico del sistema: único, no editable en lo fiscal ni borrable.
  esConsumidorFinal: boolean('es_consumidor_final').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  ixNombre: index('ix_clientes_nombre').on(t.nombre),
  ixDoc: index('ix_clientes_doc').on(t.tipoDoc, t.numeroDoc),
}));

/* ---------------- Caja (turnos del punto de venta) ---------------- */
export const estadoCajaEnum = pgEnum('estado_caja', ['abierta', 'cerrada']);
export const tipoMovCajaEnum = pgEnum('tipo_mov_caja', ['ingreso', 'egreso']);

/**
 * Turno de caja. Es lo PRIMERO del punto de venta: sin turno abierto no se
 * puede vender, y sin turno no hay forma de arquear ni de saber quién vendió
 * qué. Toda venta y toda cobranza en efectivo cuelgan de un turno.
 */
export const cajaSesiones = pgTable('caja_sesiones', {
  id: serial('id').primaryKey(),
  sucursalId: integer('sucursal_id').notNull().references(() => sucursales.id, { onDelete: 'restrict' }),
  usuarioId: integer('usuario_id').references(() => usuarios.id, { onDelete: 'set null' }),
  apertura: timestamp('apertura', { withTimezone: true }).notNull().defaultNow(),
  montoInicial: doublePrecision('monto_inicial').notNull().default(0),
  cierre: timestamp('cierre', { withTimezone: true }),
  // Al cerrar se cuenta el EFECTIVO; los demás medios se concilian por reporte.
  declaradoEfectivo: doublePrecision('declarado_efectivo').notNull().default(0),
  sistemaEfectivo: doublePrecision('sistema_efectivo').notNull().default(0),
  diferencia: doublePrecision('diferencia').notNull().default(0),
  // Foto de los totales por medio al momento del cierre (para el arqueo histórico).
  totales: jsonb('totales').notNull().default({}),
  estado: estadoCajaEnum('estado').notNull().default('abierta'),
  observaciones: text('observaciones').notNull().default(''),
}, (t) => ({
  ixSucursal: index('ix_caja_sesiones_sucursal').on(t.sucursalId, t.estado),
}));

/** Entradas y salidas de dinero que no son ventas ni cobranzas (retiros, gastos). */
export const cajaMovimientos = pgTable('caja_movimientos', {
  id: serial('id').primaryKey(),
  cajaSesionId: integer('caja_sesion_id').notNull().references(() => cajaSesiones.id, { onDelete: 'cascade' }),
  fecha: timestamp('fecha', { withTimezone: true }).notNull().defaultNow(),
  tipo: tipoMovCajaEnum('tipo').notNull(),
  motivo: text('motivo').notNull().default(''),
  importe: doublePrecision('importe').notNull().default(0),
  usuarioId: integer('usuario_id').references(() => usuarios.id, { onDelete: 'set null' }),
}, (t) => ({
  ixSesion: index('ix_caja_mov_sesion').on(t.cajaSesionId),
}));

export const tipoVentaEnum = pgEnum('tipo_venta', [
  'ticket', 'factura_a', 'factura_b', 'factura_c', 'nota_credito', 'nota_debito',
]);
export const estadoVentaEnum = pgEnum('estado_venta', [
  'borrador', 'confirmada', 'anulada', 'pendiente_cae',
]);
export const medioPagoEnum = pgEnum('medio_pago', [
  'efectivo', 'transferencia', 'tarjeta_debito', 'tarjeta_credito', 'cheque', 'qr', 'otro',
]);

/**
 * Comprobante de VENTA. Tabla propia (no reusa `comprobantes`): la numeración la
 * asigna el sistema, lleva CAE, y su libro IVA es otro. `estado` nunca vuelve
 * atrás: una venta confirmada se anula o se corrige por nota de crédito.
 */
export const ventas = pgTable('ventas', {
  id: serial('id').primaryKey(),
  tipo: tipoVentaEnum('tipo').notNull().default('ticket'),
  puntoVenta: text('punto_venta').notNull().default('0001'),
  // Se asigna recién al CONFIRMAR: los borradores del punto de venta todavía no
  // consumen numeración (por eso el índice único de abajo es parcial).
  numero: integer('numero'),
  fecha: timestamp('fecha', { withTimezone: true }).notNull().defaultNow(),
  clienteId: integer('cliente_id').notNull().references(() => clientes.id, { onDelete: 'restrict' }),
  sucursalId: integer('sucursal_id').references(() => sucursales.id, { onDelete: 'set null' }),
  usuarioId: integer('usuario_id').references(() => usuarios.id, { onDelete: 'set null' }),
  cajaSesionId: integer('caja_sesion_id').references(() => cajaSesiones.id, { onDelete: 'set null' }),
  estado: estadoVentaEnum('estado').notNull().default('confirmada'),
  condicionPago: condicionPagoEnum('condicion_pago').notNull().default('contado'),
  vencimientoPago: timestamp('vencimiento_pago', { withTimezone: true }),
  listaPrecio: text('lista_precio').notNull().default(''),
  subtotalNeto: doublePrecision('subtotal_neto').notNull().default(0),
  descuentoTotal: doublePrecision('descuento_total').notNull().default(0),
  ivaTotal: doublePrecision('iva_total').notNull().default(0),
  total: doublePrecision('total').notNull().default(0),
  // Facturación electrónica (ARCA). Vacío mientras se opere con ticket interno.
  cae: text('cae').notNull().default(''),
  caeVencimiento: timestamp('cae_vencimiento', { withTimezone: true }),
  refVentaId: integer('ref_venta_id'),                    // NC/ND → venta que ajustan
  observaciones: text('observaciones').notNull().default(''),
}, (t) => ({
  ixCliente: index('ix_ventas_cliente').on(t.clienteId),
  ixFecha: index('ix_ventas_fecha').on(t.fecha),
  // Parcial: varios borradores conviven sin número; los emitidos no se repiten.
  uqNumero: uniqueIndex('uq_ventas_numero')
    .on(t.tipo, t.puntoVenta, t.numero)
    .where(sql`${t.numero} is not null`),
  ixAbiertas: index('ix_ventas_abiertas').on(t.sucursalId, t.estado),
}));

export const ventaItems = pgTable('venta_items', {
  id: serial('id').primaryKey(),
  ventaId: integer('venta_id').notNull().references(() => ventas.id, { onDelete: 'cascade' }),
  productoId: integer('producto_id').notNull().references(() => productos.id, { onDelete: 'restrict' }),
  presentacionId: integer('presentacion_id').references(() => presentaciones.id, { onDelete: 'set null' }),
  cantidad: doublePrecision('cantidad').notNull().default(0),
  // Se guardan los DOS precios: sin el de lista no se puede auditar el descuento.
  precioLista: doublePrecision('precio_lista').notNull().default(0),
  descuento: doublePrecision('descuento').notNull().default(0),
  precioUnitario: doublePrecision('precio_unitario').notNull().default(0),
  iva: doublePrecision('iva').notNull().default(21),
  subtotal: doublePrecision('subtotal').notNull().default(0),
  refItemId: integer('ref_item_id'),                      // NC parcial → ítem original
}, (t) => ({
  ixVenta: index('ix_venta_items_venta').on(t.ventaId),
}));

/**
 * Cargos que no son mercadería: envío por Uber/cadete, packaging, un ajuste
 * puntual. Van como tabla y no como una columna suelta porque una venta puede
 * llevar más de uno y cada uno tiene su propia alícuota de IVA.
 */
export const ventaExtras = pgTable('venta_extras', {
  id: serial('id').primaryKey(),
  ventaId: integer('venta_id').notNull().references(() => ventas.id, { onDelete: 'cascade' }),
  concepto: text('concepto').notNull().default(''),
  importe: doublePrecision('importe').notNull().default(0),   // neto, sin IVA
  iva: doublePrecision('iva').notNull().default(21),
}, (t) => ({
  ixVenta: index('ix_venta_extras_venta').on(t.ventaId),
}));

export const ventaPagos = pgTable('venta_pagos', {
  id: serial('id').primaryKey(),
  ventaId: integer('venta_id').notNull().references(() => ventas.id, { onDelete: 'cascade' }),
  medio: medioPagoEnum('medio').notNull().default('efectivo'),
  importe: doublePrecision('importe').notNull().default(0),
  referencia: text('referencia').notNull().default(''),
}, (t) => ({
  ixVenta: index('ix_venta_pagos_venta').on(t.ventaId),
}));

/* ---------------- Cobranzas (recibos) ---------------- */
export const estadoCobranzaEnum = pgEnum('estado_cobranza', ['confirmada', 'anulada']);

/**
 * Recibo de cobranza. Es el gemelo de la orden de pago a proveedores:
 * medios de pago (N) + imputación a comprobantes de venta (N). Lo que no se
 * imputa queda `aCuenta` y sigue bajando el saldo del cliente.
 */
export const cobranzas = pgTable('cobranzas', {
  id: serial('id').primaryKey(),
  puntoVenta: text('punto_venta').notNull().default('0001'),
  numero: integer('numero').notNull().default(0),
  fecha: timestamp('fecha', { withTimezone: true }).notNull().defaultNow(),
  clienteId: integer('cliente_id').notNull().references(() => clientes.id, { onDelete: 'restrict' }),
  sucursalId: integer('sucursal_id').references(() => sucursales.id, { onDelete: 'set null' }),
  usuarioId: integer('usuario_id').references(() => usuarios.id, { onDelete: 'set null' }),
  cajaSesionId: integer('caja_sesion_id').references(() => cajaSesiones.id, { onDelete: 'set null' }),
  total: doublePrecision('total').notNull().default(0),
  aCuenta: doublePrecision('a_cuenta').notNull().default(0),
  estado: estadoCobranzaEnum('estado').notNull().default('confirmada'),
  observaciones: text('observaciones').notNull().default(''),
}, (t) => ({
  ixCliente: index('ix_cobranzas_cliente').on(t.clienteId),
  uqNumero: uniqueIndex('uq_cobranzas_numero').on(t.puntoVenta, t.numero),
}));

export const cobranzaPagos = pgTable('cobranza_pagos', {
  id: serial('id').primaryKey(),
  cobranzaId: integer('cobranza_id').notNull().references(() => cobranzas.id, { onDelete: 'cascade' }),
  medio: medioPagoEnum('medio').notNull().default('efectivo'),
  importe: doublePrecision('importe').notNull().default(0),
  referencia: text('referencia').notNull().default(''),
}, (t) => ({
  ixCobranza: index('ix_cobranza_pagos_cobranza').on(t.cobranzaId),
}));

export const cobranzaImputaciones = pgTable('cobranza_imputaciones', {
  id: serial('id').primaryKey(),
  cobranzaId: integer('cobranza_id').notNull().references(() => cobranzas.id, { onDelete: 'cascade' }),
  ventaId: integer('venta_id').notNull().references(() => ventas.id, { onDelete: 'restrict' }),
  importe: doublePrecision('importe').notNull().default(0),
}, (t) => ({
  ixCobranza: index('ix_cobranza_imput_cobranza').on(t.cobranzaId),
  ixVenta: index('ix_cobranza_imput_venta').on(t.ventaId),
}));

/* ---------------- Configuración (clave → JSON) ---------------- */
/**
 * Preferencias por área (`clave` = 'ventas', luego 'compras', …). Un JSON por
 * área evita una migración por cada opción nueva; el backend valida contra un
 * catálogo de defaults y descarta claves desconocidas.
 */
export const configuracion = pgTable('configuracion', {
  id: serial('id').primaryKey(),
  clave: text('clave').notNull(),
  valor: jsonb('valor').notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uqClave: uniqueIndex('uq_configuracion_clave').on(t.clave),
}));

/** Todas las tablas para pasar al cliente de Drizzle. */
export const schema = {
  sucursales, proveedores, usuarios, productos, presentaciones, productoProveedores,
  listasPrecio, productoProveedorCostos, stock, movimientos, transferencias, transferenciaItems, transferenciaHist,
  incidencias, comprobantes, comprobanteItems,
  clientes, cajaSesiones, cajaMovimientos, ventas, ventaItems, ventaExtras, ventaPagos,
  cobranzas, cobranzaPagos, cobranzaImputaciones, configuracion,
};
