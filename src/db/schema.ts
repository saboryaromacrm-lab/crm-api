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
  date,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/* ---------------- Enums ---------------- */
export const tipoProductoEnum = pgEnum('tipo_producto', ['granel', 'entero']);
/** Cómo se carga el costo de un formato de compra. Ver `producto_proveedores`. */
export const modoCostoEnum = pgEnum('modo_costo', ['lista', 'final']);
/**
 * CICLO DE VIDA DEL PRODUCTO. "No lo traigo más" y "no lo vendo más" son dos
 * decisiones distintas que pasan en momentos distintos, y confundirlas cuesta
 * plata: apagar todo de golpe deja sin vender lo que queda en góndola, y no
 * apagar nada ensucia las compras para siempre.
 *
 *   activo         se compra y se vende, todo normal
 *   discontinuado  NO se compra más (el proveedor lo bajó o se decidió no
 *                  reponer) pero SE SIGUE VENDIENDO hasta agotar el stock
 *   archivado      fuera de catálogo: no se compra ni se vende
 *
 * El camino natural es activo → discontinuado → (se agota) → archivado, y
 * volver es un clic: reactivar conserva TODO (códigos, historial de precios,
 * presentaciones, formatos de compra, cuántas veces venció).
 */
export const estadoProductoEnum = pgEnum('estado_producto', [
  'activo', 'discontinuado', 'archivado',
]);
export const tipoSucursalEnum = pgEnum('tipo_sucursal', ['distribuidora', 'express']);
export const estadoStockEnum = pgEnum('estado_stock', [
  'disponible', 'comprometido', 'retenido', 'defectuoso', 'vencido',
  /**
   * Despachado y todavía no recibido. Queda EN EL ORIGEN: la responsabilidad
   * es del que despachó hasta que el destino firme, y así el inventario total
   * nunca "pierde" mercadería que está arriba de un camión.
   */
  'en_transito',
]);
export const estadoTransferEnum = pgEnum('estado_transferencia', [
  'pendiente', 'preparada', 'transito', 'recibida', 'cancelada',
]);
export const estadoIncidenciaEnum = pgEnum('estado_incidencia', [
  'pendiente', 'revision', 'resuelta',
]);
export const tipoMovEnum = pgEnum('tipo_movimiento', [
  'compra', 'fraccionamiento', 'venta_granel', 'venta_fraccionada', 'devolucion',
  'ajuste', 'merma', 'vencido', 'defectuoso', 'transferencia', 'envio_cafeteria',
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

/**
 * Proveedor. UNA sola tabla para el que trae mercadería y para el que factura
 * gastos (la luz, el contador, el seguro): es la misma persona jurídica, con un
 * solo CUIT y una sola cuenta corriente. Lo que cambia no es el proveedor sino
 * el DOCUMENTO — comprobante de compra con productos vs. gasto con categoría.
 *
 * Los dos flags son de CLASIFICACIÓN, no de permiso: dicen en qué buscador
 * aparece por defecto. Un fletero que además te vende bolsas es los dos.
 */
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
  /** Vende mercadería que entra al stock (los que ya existían: default true). */
  proveeMercaderia: boolean('provee_mercaderia').notNull().default(true),
  /** Factura gastos de la empresa (servicios, fletes, honorarios, alquiler…). */
  proveeGastos: boolean('provee_gastos').notNull().default(false),
});

/**
 * ROLES DINÁMICOS. El rol dejó de ser un enum: es una fila con su lista de
 * permisos (claves del catálogo de roles.module). `['*']` = todos los
 * permisos. `esSistema` = no se puede borrar; el superadmin además no se
 * puede editar — es el que maneja todo.
 */
export const roles = pgTable('roles', {
  id: serial('id').primaryKey(),
  clave: text('clave').notNull().unique(),
  nombre: text('nombre').notNull(),
  descripcion: text('descripcion').notNull().default(''),
  permisos: jsonb('permisos').$type<string[]>().notNull().default([]),
  esSistema: boolean('es_sistema').notNull().default(false),
});

export const usuarios = pgTable('usuarios', {
  id: serial('id').primaryKey(),
  nombre: text('nombre').notNull(),
  rolId: integer('rol_id').notNull().references(() => roles.id, { onDelete: 'restrict' }),
  /** Formato `s2:<salt>:<scrypt hex>`. Vacío = sin contraseña definida. */
  passwordHash: text('password_hash').notNull().default(''),
  /** Los usuarios no se borran (están en el historial): se desactivan. */
  activo: boolean('activo').notNull().default(true),
});

/* ==================================================================== *
 * CATÁLOGOS DEL PRODUCTO — marca, categoría › subcategoría, etiquetas
 * ==================================================================== *
 * Antes eran texto suelto dentro de `productos`. Como entidades con id:
 * renombrar deja de romper nada, "Cachafaz" y "CACHAFAZ" dejan de ser dos
 * marcas distintas, y las reglas que apuntan a una marca sobreviven al cambio
 * de nombre. El costo es una tabla más; la ganancia es que el catálogo no se
 * ensucia solo.
 *
 * Se dan de baja (`activa: false`), no se borran: hay productos y ventas
 * viejas que los referencian y tienen que seguir siendo explicables.
 */

export const marcas = pgTable('marcas', {
  id: serial('id').primaryKey(),
  nombre: text('nombre').notNull(),
  activa: boolean('activa').notNull().default(true),
}, (t) => ({
  uq: uniqueIndex('uq_marca_nombre').on(t.nombre),
}));

export const categorias = pgTable('categorias', {
  id: serial('id').primaryKey(),
  nombre: text('nombre').notNull(),
  activa: boolean('activa').notNull().default(true),
}, (t) => ({
  uq: uniqueIndex('uq_categoria_nombre').on(t.nombre),
}));

/** Segundo nivel. Cuelga de una categoría: el desplegable se filtra por ella. */
export const subcategorias = pgTable('subcategorias', {
  id: serial('id').primaryKey(),
  categoriaId: integer('categoria_id').notNull().references(() => categorias.id, { onDelete: 'cascade' }),
  nombre: text('nombre').notNull(),
  activa: boolean('activa').notNull().default(true),
}, (t) => ({
  // El mismo nombre puede repetirse en otra categoría ("Tradicionales" en
  // Alfajores y en Galletitas): la unicidad es por par, no global.
  uq: uniqueIndex('uq_subcategoria_nombre').on(t.categoriaId, t.nombre),
}));

/** Transversales a la categoría: SIN TACC, SIN AZÚCAR, VEGANO, ORGÁNICO. */
export const etiquetas = pgTable('etiquetas', {
  id: serial('id').primaryKey(),
  nombre: text('nombre').notNull(),
  /** Color del chip. Vacío = el neutro del tema. */
  color: text('color').notNull().default(''),
  activa: boolean('activa').notNull().default(true),
}, (t) => ({
  uq: uniqueIndex('uq_etiqueta_nombre').on(t.nombre),
}));

export const productos = pgTable('productos', {
  id: serial('id').primaryKey(),
  nombre: text('nombre').notNull(),
  /** Texto libre que amplía el nombre; no participa de la búsqueda por código. */
  descripcion: text('descripcion').notNull().default(''),

  /* Códigos ------------------------------------------------------------ *
   * Tres, y cada uno identifica algo distinto:
   *   codigoPropio  el SKU interno, el que se tipea cuando no hay etiqueta
   *   codigoBarras  el EAN de la unidad de venta
   *   dun           el EAN-14 del BULTO cerrado (caja/pallet)
   * Los tres son únicos cuando no están vacíos, y además no pueden pisarse
   * entre sí ni contra los de las presentaciones: si dos cosas responden al
   * mismo código, el escáner de la caja queda sin desempate. Eso lo valida el
   * servicio, porque cruza dos tablas y ningún índice lo puede expresar. */
  codigoPropio: text('codigo_propio').notNull().default(''),
  codigoBarras: text('codigo_barras').notNull().default(''),
  dun: text('dun').notNull().default(''),
  /** Cuántas unidades trae el bulto que identifica el DUN. */
  unidadesPorBulto: doublePrecision('unidades_por_bulto').notNull().default(1),

  /* Clasificación ------------------------------------------------------ */
  marcaId: integer('marca_id').references(() => marcas.id, { onDelete: 'set null' }),
  categoriaId: integer('categoria_id').references(() => categorias.id, { onDelete: 'set null' }),
  subcategoriaId: integer('subcategoria_id').references(() => subcategorias.id, { onDelete: 'set null' }),

  iva: doublePrecision('iva').notNull().default(21),
  tipo: tipoProductoEnum('tipo').notNull().default('entero'),

  /* Ciclo de vida ------------------------------------------------------ *
   * Ver `estadoProductoEnum`. El producto NO se borra: se da de baja y se
   * puede reactivar — es el principio del sistema ("lo que está en uso se
   * desactiva, no se borra"), que hasta la 0051 cumplían las marcas, las
   * listas y las ofertas pero no el producto, que es el que más historia
   * acumula. Eliminar de verdad queda solo para el que no tiene NINGUNA
   * huella (un duplicado del importador, un alta con el dedo). */
  estado: estadoProductoEnum('estado').notNull().default('activo'),
  /** Cuándo pasó al estado actual: da el "discontinuado hace 8 meses". */
  estadoDesde: timestamp('estado_desde', { withTimezone: true }),
  /** Por qué se dio de baja. Lo lee quien decide si vale la pena reactivarlo. */
  motivoBaja: text('motivo_baja').notNull().default(''),
  /**
   * El "SOLO STOCK" del sistema viejo: granel que NO se vende suelto — existe
   * únicamente para fraccionarse. La Pimienta de Jamaica llega 1 kg y se
   * fracciona entera en 20 paquetes de 50 g: el POS no tiene que poder vender
   * "0,5 kg de pimienta suelta", solo sus paquetes. El candado vive en la
   * venta (API) y el POS ni la ofrece suelta.
   */
  soloFraccionar: boolean('solo_fraccionar').notNull().default(false),
  stockMin: doublePrecision('stock_min').notNull().default(0),
  /**
   * Redondeo de góndola propio. NULL = hereda el de configuración, que es lo
   * normal: así el redondeo se define una vez y solo se toca en el producto
   * que necesita otra cosa.
   */
  redondeo: integer('redondeo'),

  /* Tienda ------------------------------------------------------------- */
  /**
   * `publicado` quedó SIN uso en el sitio: el criterio de publicación es tener
   * precio en la lista Mayorista (regla del módulo Web). Se conserva la columna
   * por si algún día hace falta un veto manual, pero nada la lee.
   */
  publicado: boolean('publicado').notNull().default(false),
  /** Id del producto en la tienda externa. Genérico a propósito: hoy WooCommerce. */
  idExterno: text('id_externo').notNull().default(''),
  /**
   * Foto para el sitio web por URL EXTERNA. Vacío = se usa la imagen subida en
   * el módulo Web (`web_imagenes`) y, si tampoco hay, la genérica del sitio.
   */
  imagenUrl: text('imagen_url').notNull().default(''),
  /** Aparece en el carrusel "Destacados" del sitio. Se marca en el módulo Web. */
  destacado: boolean('destacado').notNull().default(false),
  /**
   * Piso de stock para la venta ONLINE: cuando el disponible de la
   * Distribuidora llega a este número, el sitio muestra "Sin stock" — lo que
   * queda se prioriza para fraccionar o para la venta minorista del mostrador.
   * 0 = sin piso (disponible hasta la última unidad). Se ajusta por producto
   * en el módulo Web.
   */
  webStockMin: doublePrecision('web_stock_min').notNull().default(0),

  // Proveedor "activo" (con el que vino la última vez); define costo y precios.
  /*
   * NO hay `proveedorActivoId`: el proveedor que define el costo se deduce del
   * FORMATO DE COMPRA marcado con `usarParaPrecio`. Tener las dos cosas era
   * tener dos fuentes de verdad para el mismo dato, y con varios formatos por
   * proveedor el id del proveedor ya no alcanza para saber cuál manda.
   */
}, (t) => ({
  ixCodigo: index('ix_productos_codigo').on(t.codigoBarras),
  ixPropio: index('ix_productos_codigo_propio').on(t.codigoPropio),
  ixMarca: index('ix_productos_marca').on(t.marcaId),
  ixCategoria: index('ix_productos_categoria').on(t.categoriaId),
  // Parciales: el vacío es "sin código" y puede repetirse cuanto haga falta.
  uqPropio: uniqueIndex('uq_producto_codigo_propio').on(t.codigoPropio).where(sql`${t.codigoPropio} <> ''`),
  uqBarras: uniqueIndex('uq_producto_codigo_barras').on(t.codigoBarras).where(sql`${t.codigoBarras} <> ''`),
  uqDun: uniqueIndex('uq_producto_dun').on(t.dun).where(sql`${t.dun} <> ''`),
}));

/** Etiquetas de un producto (N a N). */
export const productoEtiquetas = pgTable('producto_etiquetas', {
  id: serial('id').primaryKey(),
  productoId: integer('producto_id').notNull().references(() => productos.id, { onDelete: 'cascade' }),
  etiquetaId: integer('etiqueta_id').notNull().references(() => etiquetas.id, { onDelete: 'cascade' }),
}, (t) => ({
  uq: uniqueIndex('uq_producto_etiqueta').on(t.productoId, t.etiquetaId),
  ixEtiqueta: index('ix_producto_etiquetas_etiqueta').on(t.etiquetaId),
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
  uqCodigo: uniqueIndex('uq_presentacion_codigo_barras').on(t.codigoBarras).where(sql`${t.codigoBarras} <> ''`),
}));

/* Costo de un producto según cada proveedor (descuento y flete en %). */
export const productoProveedores = pgTable('producto_proveedores', {
  id: serial('id').primaryKey(),
  productoId: integer('producto_id').notNull().references(() => productos.id, { onDelete: 'cascade' }),
  proveedorId: integer('proveedor_id').notNull().references(() => proveedores.id, { onDelete: 'cascade' }),
  /**
   * Unidades que trae el formato. "Caja x12" → 12. Es lo que permite comparar
   * dos proveedores que venden el mismo producto en bultos distintos: el costo
   * unitario los pone en la misma escala.
   */
  cantidad: doublePrecision('cantidad').notNull().default(1),
  /** Costo de lista del BULTO entero, sin descuentos ni flete. */
  costo: doublePrecision('costo').notNull().default(0),
  /**
   * Escala de descuentos del proveedor ("treinta y diez y cinco"). Se aplican
   * EN CASCADA, no se suman: 30 y 10 es 37%, no 40%. Por eso son cuatro campos
   * y no uno — así se cargan tal como los da el proveedor.
   */
  descuento: doublePrecision('descuento').notNull().default(0),
  descuento2: doublePrecision('descuento2').notNull().default(0),
  descuento3: doublePrecision('descuento3').notNull().default(0),
  descuento4: doublePrecision('descuento4').notNull().default(0),
  flete: doublePrecision('flete').notNull().default(0),
  /**
   * De dónde sale el costo:
   *   'lista' — se carga el costo de lista y el sistema aplica descuentos y flete
   *   'final' — se carga directo el costo final CON IVA y se deriva hacia atrás
   *
   * Es un interruptor explícito a propósito. El sistema viejo cambiaba de modo
   * cuando el costo de lista quedaba en 0: alguien lo borraba para corregir un
   * tipeo y cambiaba el cálculo de todo el producto sin enterarse.
   */
  modoCosto: modoCostoEnum('modo_costo').notNull().default('lista'),
  /** Solo en modo 'final': costo del bulto CON IVA, tal como lo factura el proveedor. */
  costoFinal: doublePrecision('costo_final').notNull().default(0),
  /**
   * Este formato es el que define el costo con el que se calcula el precio de
   * venta. Uno solo por producto: el servicio lo garantiza al guardar.
   */
  usarParaPrecio: boolean('usar_para_precio').notNull().default(false),
  /**
   * El código con el que ESTE proveedor identifica al producto. Va acá y no en
   * `productos` porque el mismo artículo tiene un código distinto en cada
   * proveedor: ponerlo en el producto obligaría a elegir cuál de todos guardar.
   */
  codigoProveedor: text('codigo_proveedor').notNull().default(''),
}, (t) => ({
  // SIN índice único de (producto, proveedor): el mismo proveedor puede vender
  // el mismo producto en dos formatos (caja x12 y caja x24), y son dos filas.
  ixProducto: index('ix_producto_proveedores_producto').on(t.productoId),
  ixProveedor: index('ix_producto_proveedores_proveedor').on(t.proveedorId),
}));

/**
 * MAPEO APRENDIDO: el código del artículo EN LA FACTURA del proveedor → nuestro
 * producto. Es lo que hace que la lectura del PDF reconozca "33800 SALMON NAT
 * TROZOS" la segunda vez: la primera lo asocia el admin a mano en el alta, y al
 * GUARDAR el comprobante el sistema lo recuerda. Si se cancela, no se aprende.
 *
 * NO es lo mismo que `productoProveedores.codigoProveedor`: aquel es dato
 * curado del catálogo, y en la práctica vino del sistema viejo con corrimientos
 * (la factura real dice 10206 donde el catálogo dice 10200 para el mismo
 * artículo). Este se aprende de facturas CONFIRMADAS por una persona, y por eso
 * resuelve PRIMERO. Un mapeo mal aprendido se corrige solo: en la próxima
 * factura el admin cambia el producto del renglón y el guardado lo pisa.
 */
export const proveedorArticulos = pgTable('proveedor_articulos', {
  id: serial('id').primaryKey(),
  proveedorId: integer('proveedor_id').notNull().references(() => proveedores.id, { onDelete: 'cascade' }),
  /** El código tal como lo imprime la factura. */
  codigo: text('codigo').notNull(),
  productoId: integer('producto_id').notNull().references(() => productos.id, { onDelete: 'cascade' }),
  /** La última descripción vista en el papel, para poder auditar el mapeo. */
  descripcion: text('descripcion').notNull().default(''),
  actualizadoEn: timestamp('actualizado_en', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uqCodigo: uniqueIndex('uq_proveedor_articulo').on(t.proveedorId, t.codigo),
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

/* ==================================================================== *
 * FORMATO DE VENTA — cómo se vende cada producto
 * ==================================================================== *
 * El negocio NO se maneja por listas globales: se maneja por producto. La misma
 * lista "Mayorista 1" puede ir al 30% en un producto y al 50% en otro, así que
 * el markup NO puede vivir en la lista — vive en la fila producto × lista.
 *
 *   modalidades_venta   Agrupación visual: "Minorista", "Mayorista". Solo una
 *                       carpeta; no lleva markup ni condiciones.
 *   listas_venta        IDENTIDAD nada más: número + nombre dentro de la
 *                       modalidad, y el `orden` de preferencia. Ni un precio.
 *   producto_listas     EL FORMATO DE VENTA. Una fila = "este producto se vende
 *                       en esta lista, con este markup". Sin fila, el producto
 *                       NO se vende en esa lista (y punto: nada se hereda).
 *   reglas_marca        La ÚNICA regla global, porque alcanza a muchos
 *                       productos a la vez: "12 unidades de Coca-Cola habilitan
 *                       la modalidad Mayorista".
 *
 * Las tres puertas de acceso a una lista son un OR: la tiene asignada el
 * cliente, o el ticket llegó al mínimo de unidades del producto, o una regla de
 * marca (o el monto, que se configura aparte) desbloqueó su modalidad. Si el
 * producto no tiene fila en ninguna lista de la modalidad desbloqueada, no pasa
 * nada: no hay nada que asignarle.
 */

/**
 * Por qué un renglón terminó con la lista que tiene. Es lo que después permite
 * auditar si alguien está regalando precio mayorista a mano.
 */
export const origenListaEnum = pgEnum('origen_lista', [
  'base',      // el piso: la lista por defecto del sistema
  'cliente',   // una de las predeterminadas del cliente
  'auto',      // llegó al mínimo de unidades de ESE producto
  'manual',    // la eligió una persona
  'marca',     // una regla de marca desbloqueó la modalidad
  'monto',     // el monto del ticket la desbloqueó (sujeta a medio de pago)
]);

export const modalidadesVenta = pgTable('modalidades_venta', {
  id: serial('id').primaryKey(),
  nombre: text('nombre').notNull(),
  orden: integer('orden').notNull().default(0),
  activa: boolean('activa').notNull().default(true),
});

/**
 * La lista es pura identidad. Todo lo que es plata o condición propia del
 * producto está en `producto_listas`.
 */
export const listasVenta = pgTable('listas_venta', {
  id: serial('id').primaryKey(),
  modalidadId: integer('modalidad_id').notNull().references(() => modalidadesVenta.id, { onDelete: 'cascade' }),
  /**
   * Número dentro de la modalidad ("Mayorista 1"). NO se reordena ni se
   * reutiliza: es parte de la identidad que referencian clientes y ventas
   * viejas. Dar de baja = `activa: false`, nunca renumerar.
   */
  numero: integer('numero').notNull(),
  nombre: text('nombre').notNull(),
  /** Preferencia: entre las listas que el renglón habilita, gana el orden menor. */
  orden: integer('orden').notNull().default(0),
  activa: boolean('activa').notNull().default(true),
}, (t) => ({
  uqNumero: uniqueIndex('uq_lista_modalidad_numero').on(t.modalidadId, t.numero),
  ixOrden: index('ix_listas_venta_orden').on(t.orden),
}));

/**
 * FORMATO DE VENTA de un producto. La fila ES la habilitación: existe = se
 * vende así. No hay `disponible` porque borrar la fila dice lo mismo con una
 * sola verdad.
 */
/** Cómo se define el precio de un formato de venta. */
export const modoPrecioEnum = pgEnum('modo_precio', [
  'markup',   // % sobre el costo neto: el precio acompaña al costo
  'precio',   // precio FINAL definido a mano: no se mueve aunque cambie el costo
]);

export const productoListas = pgTable('producto_listas', {
  id: serial('id').primaryKey(),
  productoId: integer('producto_id').notNull().references(() => productos.id, { onDelete: 'cascade' }),
  listaId: integer('lista_id').notNull().references(() => listasVenta.id, { onDelete: 'cascade' }),
  /**
   * En cuántas unidades se vende este formato: 1 = por unidad (minorista),
   * 12 = por caja de 12 (mayorista). Es del PAR producto×lista — el mismo
   * alfajor se vende suelto en minorista y por caja en mayorista.
   */
  unidades: doublePrecision('unidades').notNull().default(1),
  /**
   * Código de barras PROPIO del formato (el EAN de la caja). Escanearlo en la
   * caja carga las `unidades` del formato de una vez.
   */
  codigoBarras: text('codigo_barras').notNull().default(''),
  /** Cómo se define el precio (ver enum). */
  modoPrecio: modoPrecioEnum('modo_precio').notNull().default('markup'),
  /** % sobre el costo neto. Solo manda en modo 'markup'. */
  markup: doublePrecision('markup').notNull().default(0),
  /**
   * Precio FINAL (con IVA) del FORMATO completo, en modo 'precio': es el
   * número del cartel — "caja x12 $10.000". No se le aplica redondeo de
   * góndola: es la voluntad exacta del que lo fijó.
   */
  precioFijo: doublePrecision('precio_fijo').notNull().default(0),
  /**
   * Mínimo de unidades del producto en el ticket para habilitarla por sí sola.
   * 0 = sin puerta propia: se llega por el cliente, por regla de marca o por
   * monto. Se mide en CANTIDADES (no en pesos), que es lo que la hace estable
   * y permite aplicarla sin intervención.
   */
  unidadesMinimas: doublePrecision('unidades_minimas').notNull().default(0),
}, (t) => ({
  uq: uniqueIndex('uq_producto_lista').on(t.productoId, t.listaId),
  ixProd: index('ix_producto_listas_producto').on(t.productoId),
  uqCodigo: uniqueIndex('uq_producto_lista_codigo').on(t.codigoBarras).where(sql`${t.codigoBarras} <> ''`),
}));

/**
 * Regla de marca: la única condición GLOBAL, porque por definición alcanza a
 * muchos productos. Desbloquea una MODALIDAD entera, no una lista: cada
 * producto entra con la lista de esa modalidad que tenga cargada, y el que no
 * tenga ninguna sigue con su precio de siempre.
 *
 * Pueden convivir varias (Coca-Cola desde 12, Quilmes desde 6).
 */
export const reglasMarca = pgTable('reglas_marca', {
  id: serial('id').primaryKey(),
  /**
   * Apunta a la marca por id, no por texto: renombrar "Coca Cola" a
   * "Coca-Cola" no puede desarmar la regla en silencio, y no hay que
   * normalizar acentos ni mayúsculas para comparar.
   */
  marcaId: integer('marca_id').notNull().references(() => marcas.id, { onDelete: 'cascade' }),
  unidadesMinimas: doublePrecision('unidades_minimas').notNull().default(0),
  modalidadId: integer('modalidad_id').notNull().references(() => modalidadesVenta.id, { onDelete: 'cascade' }),
  activa: boolean('activa').notNull().default(true),
}, (t) => ({
  uq: uniqueIndex('uq_regla_marca').on(t.marcaId, t.modalidadId),
}));

/* ==================================================================== *
 * EVOLUCIÓN DE PRECIOS — el precio de venta a lo largo del tiempo
 * ==================================================================== *
 * El precio no se edita: se DERIVA (costo × markup, redondeado). Por eso no
 * hay ningún evento natural de "cambió el precio" — cambia porque se movió una
 * palanca en otro lado. Esta tabla lo convierte en un hecho registrable:
 * después de cada operación que puede mover precios, un snapshot compara el
 * precio derivado actual contra el último registrado y anota SOLO lo que
 * cambió.
 *
 * Se guarda el precio FINAL (con IVA y redondeo de góndola): es el número de
 * la etiqueta, que es del que se habla cuando alguien pregunta "¿cuánto
 * aumentó?".
 */
export const origenPrecioEnum = pgEnum('origen_precio', [
  'inicial',         // primera vez que el producto×lista tiene precio
  'costo',           // cambió el costo del proveedor (manual/masiva/recepción)
  'formato_compra',  // se editó el formato de compra (cantidad, descuentos, flete…)
  'formato_venta',   // se editó el markup o las listas del producto
  'activacion',      // cambió QUÉ formato fija el precio
  'reversion',       // se deshizo un lote de costos
]);

export const precioHistorial = pgTable('precio_historial', {
  id: serial('id').primaryKey(),
  productoId: integer('producto_id').notNull().references(() => productos.id, { onDelete: 'cascade' }),
  listaId: integer('lista_id').notNull().references(() => listasVenta.id, { onDelete: 'cascade' }),
  fecha: timestamp('fecha', { withTimezone: true }).notNull().defaultNow(),
  /** Null = alta: no había precio anterior contra el cual medir el %. */
  precioAnterior: doublePrecision('precio_anterior'),
  precio: doublePrecision('precio').notNull().default(0),
  origen: origenPrecioEnum('origen').notNull().default('costo'),
  detalle: text('detalle').notNull().default(''),
  usuarioId: integer('usuario_id').references(() => usuarios.id, { onDelete: 'set null' }),
}, (t) => ({
  ixProducto: index('ix_precio_historial_producto').on(t.productoId, t.fecha),
  ixFecha: index('ix_precio_historial_fecha').on(t.fecha),
}));

/* ==================================================================== *
 * OFERTAS — promociones del punto de venta
 * ==================================================================== *
 * Una oferta = un TIPO (la mecánica), un ALCANCE (a qué artículos les toca) y
 * CONDICIONES de vigencia (fechas, días, sucursales, medio de pago).
 *
 * La MISMA regla de oro del formato de venta: las mecánicas que se miden sobre
 * CANTIDADES (3×2, 2ª unidad, pack) son estables y se aplican solas; la de
 * MONTO del ticket se mide sobre pesos —aplicarla baja el total y podría
 * des-calificarse a sí misma— así que se SUGIERE y el cajero la aplica con un
 * clic.
 *
 * Por renglón aplica UNA sola oferta: la de mayor beneficio. Sin esa regla,
 * apilar promociones vuelve el ticket inexplicable (y el margen, negativo).
 */

export const tipoOfertaEnum = pgEnum('tipo_oferta', [
  'porcentaje',     // X% de descuento en el alcance
  'precio_fijo',    // precio de oferta por unidad (final, con IVA)
  'nxm',            // llevá N pagá M (3×2)
  'segunda_unidad', // 2ª unidad con X% de descuento
  'pack',           // N unidades por $X (final, con IVA)
  'combo',          // conjunto de productos DISTINTOS por $X (final, con IVA)
  'ticket',         // X% al total desde $monto — se sugiere, nunca sola
]);

export const alcanceOfertaEnum = pgEnum('alcance_oferta', [
  'producto', 'marca', 'categoria', 'etiqueta',
]);

export const ofertas = pgTable('ofertas', {
  id: serial('id').primaryKey(),
  nombre: text('nombre').notNull(),
  tipo: tipoOfertaEnum('tipo').notNull(),

  /* Parámetros de la mecánica: cada tipo usa los suyos y el resto queda en 0.
   * Columnas explícitas y no un JSON: el formulario y la validación saben
   * exactamente qué existe, y una consulta SQL puede leerlos sin parsear. */
  porcentaje: doublePrecision('porcentaje').notNull().default(0),   // porcentaje / segunda_unidad / ticket
  /** Precio FINAL (con IVA): es el número del cartel. El motor deriva el neto. */
  precio: doublePrecision('precio').notNull().default(0),           // precio_fijo / pack / combo
  lleva: doublePrecision('lleva').notNull().default(0),             // nxm / pack: N
  paga: doublePrecision('paga').notNull().default(0),               // nxm: M
  montoMinimo: doublePrecision('monto_minimo').notNull().default(0), // ticket

  /* Vigencia. Nulos/vacíos = sin límite. */
  desde: timestamp('desde', { withTimezone: true }),
  hasta: timestamp('hasta', { withTimezone: true }),
  /** Máscara de 7 chars lunes→domingo ('1111100' = hábiles). '' = todos. */
  dias: text('dias').notNull().default(''),
  /** Ids de sucursal en CSV. '' = todas. Chico y estable: no amerita tabla. */
  sucursales: text('sucursales').notNull().default(''),
  /** Solo tipo ticket: medios de pago que la habilitan, CSV. '' = cualquiera. */
  mediosPago: text('medios_pago').notNull().default(''),

  /**
   * true = solo aplica sobre renglones al precio de mostrador (origen 'base').
   * Un cliente con lista mayorista ya tiene SU beneficio: sumarle la promo de
   * vidriera es descontar dos veces sin que nadie lo haya decidido.
   */
  soloPrecioBase: boolean('solo_precio_base').notNull().default(true),
  activa: boolean('activa').notNull().default(true),
});

/** A qué artículos alcanza. Varias filas = unión (cualquiera la habilita). */
export const ofertaAlcances = pgTable('oferta_alcances', {
  id: serial('id').primaryKey(),
  ofertaId: integer('oferta_id').notNull().references(() => ofertas.id, { onDelete: 'cascade' }),
  tipo: alcanceOfertaEnum('tipo').notNull(),
  refId: integer('ref_id').notNull(),
}, (t) => ({
  uq: uniqueIndex('uq_oferta_alcance').on(t.ofertaId, t.tipo, t.refId),
}));

/** Componentes de un COMBO: qué productos y cuántos arman el conjunto. */
export const ofertaComponentes = pgTable('oferta_componentes', {
  id: serial('id').primaryKey(),
  ofertaId: integer('oferta_id').notNull().references(() => ofertas.id, { onDelete: 'cascade' }),
  productoId: integer('producto_id').notNull().references(() => productos.id, { onDelete: 'cascade' }),
  cantidad: doublePrecision('cantidad').notNull().default(1),
}, (t) => ({
  uq: uniqueIndex('uq_oferta_componente').on(t.ofertaId, t.productoId),
}));

/**
 * Listas predeterminadas del cliente. Puede tener varias: al cotizar se prueban
 * por `listas_venta.orden` y gana la primera que el renglón califique.
 */
export const clienteListas = pgTable('cliente_listas', {
  id: serial('id').primaryKey(),
  clienteId: integer('cliente_id').notNull().references(() => clientes.id, { onDelete: 'cascade' }),
  listaId: integer('lista_id').notNull().references(() => listasVenta.id, { onDelete: 'cascade' }),
}, (t) => ({
  uq: uniqueIndex('uq_cliente_lista').on(t.clienteId, t.listaId),
}));

/* ---------------- Stock (Producto × Sucursal × Presentación × Estado) ---------------- */
export const stock = pgTable('stock', {
  id: serial('id').primaryKey(),
  /**
   * `restrict`, no cascade (0051): borrar un producto NO puede hacer
   * desaparecer existencias en silencio. El borrado real limpia antes las
   * filas en CERO (que no son información) y si queda cantidad, el candado
   * explícito del servicio corta con un mensaje entendible.
   */
  productoId: integer('producto_id').notNull().references(() => productos.id, { onDelete: 'restrict' }),
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
  /**
   * Costo unitario CONGELADO al momento del movimiento (0 = no valuado).
   * Solo lo llenan las bajas por pérdida (merma / vencido / defectuoso): son
   * las que un reporte suma en pesos, y valuarlas al costo del día en que se
   * mira cambiaría retroactivamente un período ya cerrado.
   */
  costoUnitario: doublePrecision('costo_unitario').notNull().default(0),
  proveedorNombre: text('proveedor_nombre').notNull().default(''),
  usuarioId: integer('usuario_id').references(() => usuarios.id, { onDelete: 'set null' }),
  refTransferenciaId: integer('ref_transferencia_id'),
  refIncidenciaId: integer('ref_incidencia_id'),
  descripcion: text('descripcion').notNull().default(''),
});

/* ---------------- Transferencias entre sucursales ---------------- */
/**
 * Transferencia entre sucursales — modelo PULL: la arma el DESTINO (el local
 * que necesita mercadería) y el origen la prepara, despacha y el solicitante
 * la recibe contando lo que llegó.
 *
 * El stock acompaña los estados:
 *   pendiente   documento de demanda: NO toca stock
 *   preparada   el origen la armó: disponible → comprometido (reserva)
 *   transito    salió: comprometido → en_transito (sigue siendo del origen)
 *   recibida    en_transito baja por lo RECIBIDO; el destino lo suma a
 *               disponible; la diferencia vuelve a comprometido en el origen
 *               atada a una incidencia automática
 */
export const transferencias = pgTable('transferencias', {
  id: serial('id').primaryKey(),
  codigo: text('codigo').notNull().default(''),
  fecha: timestamp('fecha', { withTimezone: true }).notNull().defaultNow(),
  origenId: integer('origen_id').notNull().references(() => sucursales.id, { onDelete: 'restrict' }),
  destinoId: integer('destino_id').notNull().references(() => sucursales.id, { onDelete: 'restrict' }),
  usuarioId: integer('usuario_id').references(() => usuarios.id, { onDelete: 'set null' }),
  estado: estadoTransferEnum('estado').notNull().default('pendiente'),
  /** Notas del circuito ("faltó espacio en el flete") — es columna y filtro en Operaciones. */
  observaciones: text('observaciones').notNull().default(''),
  /**
   * PREPARACIÓN EN DOS LISTAS. En el estado `preparada` (fase "En preparación")
   * el pedido se divide por tipo de producto: ENTEROS para el preparador y
   * GRANEL para el fraccionador. Cada encargado confirma la suya cuando la
   * mercadería está apartada — y ESE es el momento en que se reserva el stock
   * (disponible → comprometido). El despacho exige las dos confirmaciones.
   */
  enterosListo: boolean('enteros_listo').notNull().default(false),
  granelListo: boolean('granel_listo').notNull().default(false),
});

export const transferenciaItems = pgTable('transferencia_items', {
  id: serial('id').primaryKey(),
  transferenciaId: integer('transferencia_id').notNull().references(() => transferencias.id, { onDelete: 'cascade' }),
  /** `restrict` (0051): un remito viejo no puede quedar mutilado en silencio. */
  productoId: integer('producto_id').notNull().references(() => productos.id, { onDelete: 'restrict' }),
  presentacionId: integer('presentacion_id').references(() => presentaciones.id, { onDelete: 'set null' }),
  cantidad: doublePrecision('cantidad').notNull().default(0),
  /**
   * Lo que el origen PREPARÓ de verdad. Arranca igual a `cantidad` (lo pedido)
   * y el encargado lo ajusta durante la preparación: "pidieron 20, hay 14".
   * Es la cantidad que se reserva, se despacha y contra la que se recibe.
   */
  cantidadPreparada: doublePrecision('cantidad_preparada').notNull().default(0),
  /**
   * Lo que el destino CONTÓ al recibir. Null = todavía no se recibió. La
   * diferencia contra `cantidadPreparada` es lo que genera la incidencia automática.
   */
  cantidadRecibida: doublePrecision('cantidad_recibida'),
  /** Renglón que el ORIGEN sumó durante la preparación (llegó mercadería a último momento). */
  agregado: boolean('agregado').notNull().default(false),
  /** Observación del renglón: por qué va otra cantidad, o por qué se agregó. */
  motivo: text('motivo').notNull().default(''),
  /**
   * Costo neto unitario CONGELADO al despachar. Es lo que permite valuar la
   * operación "a costo" meses después aunque el costo del producto haya
   * cambiado — el remito viejo tiene que decir siempre lo mismo.
   */
  costoUnitario: doublePrecision('costo_unitario').notNull().default(0),
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
  /** `restrict` (0051): la incidencia es historia — no se borra por arrastre. */
  productoId: integer('producto_id').notNull().references(() => productos.id, { onDelete: 'restrict' }),
  sucursalId: integer('sucursal_id').notNull().references(() => sucursales.id, { onDelete: 'cascade' }),
  presentacionId: integer('presentacion_id').references(() => presentaciones.id, { onDelete: 'set null' }),
  cantidad: doublePrecision('cantidad').notNull().default(0),
  unidad: text('unidad').notNull().default(''),
  resolucion: text('resolucion'),
  fechaResolucion: timestamp('fecha_resolucion', { withTimezone: true }),
  activa: boolean('activa').notNull().default(true),
});

/* ---------------- Facturación / comprobantes de compra ---------------- */
/**
 * Tipos de comprobante de COMPRA.
 *
 * `liquidacion` es el único NO FISCAL de la lista, y existe por un caso real:
 * hay proveedores que entregan mitad facturado y mitad sin factura. Esa segunda
 * mitad **entró al depósito y hay que pagarla**, así que tiene que estar en el
 * sistema o el stock y la deuda quedan mintiendo — pero NO lleva IVA, no tiene
 * CAE y no puede aparecer en nada fiscal.
 *
 * Por qué un tipo propio y no una factura con letra X ni un flag `fiscal:false`:
 * lo que importa es qué pasa cuando alguien se olvida. Con un tipo aparte, toda
 * consulta que pide "facturas" la excluye sola y hay que **optar por incluirla**;
 * con una letra o un flag, todo la incluye por defecto y hay que acordarse de
 * sacarla — y ese olvido infla el IVA computado, que es el lado caro del error.
 */
export const tipoComprobanteEnum = pgEnum('tipo_comprobante', [
  'orden_compra', 'remito', 'factura', 'liquidacion', 'nota_credito', 'nota_debito',
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
  /**
   * CAE — el número con el que ARCA autorizó la factura del proveedor. NO se
   * tipea: sale del QR del papel (RG 4892), que es la única parte de la factura
   * que se puede leer sin interpretar la imagen. Guardarlo permite después
   * cruzar lo cargado contra "Mis Comprobantes" y encontrar facturas perdidas.
   */
  cae: text('cae').notNull().default(''),
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
  /**
   * EL PIE DE LA FACTURA, en el orden en que lo lee el papel:
   *   subtotal de los ítems  (con los descuentos de cada renglón ya aplicados)
   *   − bonificación general (el descuento de pie: "Bonif. 21,38 %")
   *   = subtotalNeto         ← la base gravada
   *   + ivaTotal             (se calcula sobre el neto YA bonificado)
   *   + percepcionesTotal    (RG 5329, IIBB…, cada una en `comprobante_percepciones`)
   *   = total                ← lo que hay que pagarle al proveedor
   *
   * La bonificación se guarda como PORCENTAJE y como IMPORTE: el porcentaje es
   * lo que dice el papel, pero el importe manda — el proveedor redondea a su
   * manera y el total tiene que coincidir al centavo con la factura.
   */
  bonificacion: doublePrecision('bonificacion').notNull().default(0),
  bonificacionImporte: doublePrecision('bonificacion_importe').notNull().default(0),
  subtotalNeto: doublePrecision('subtotal_neto').notNull().default(0),
  ivaTotal: doublePrecision('iva_total').notNull().default(0),
  /** Suma de las percepciones. NO es IVA: es pago a cuenta de otro impuesto. */
  percepcionesTotal: doublePrecision('percepciones_total').notNull().default(0),
  total: doublePrecision('total').notNull().default(0),
  /**
   * Cuánto de este comprobante ya se le pagó al proveedor. Suma de las
   * imputaciones de `proveedor_pagos` — se recalcula, no se acumula. Sin esto
   * la cuenta corriente del proveedor solo podía crecer.
   */
  pagado: doublePrecision('pagado').notNull().default(0),
  // NC/ND referencian la factura que ajustan (sin FK dura para evitar autorreferencia).
  refComprobanteId: integer('ref_comprobante_id'),
  observaciones: text('observaciones').notNull().default(''),
  usuarioId: integer('usuario_id').references(() => usuarios.id, { onDelete: 'set null' }),
}, (t) => ({
  /**
   * EL MISMO COMPROBANTE NO SE CARGA DOS VECES.
   *
   * Faltaba: `ventas` y `cobranzas` ya lo tenían y compras no. Con carga manual
   * no molestaba porque el que cargaba se acordaba; con facturas que entran
   * desde una bandeja de papeles subidos, el duplicado deja de ser improbable y
   * pasa a ser cuestión de tiempo — y entra dos veces al stock y a la deuda.
   *
   * Va en la BASE y no solo en el servicio: dos pestañas en paralelo se pasan
   * por arriba de cualquier chequeo previo. Solo aplica con número cargado (una
   * orden de compra interna puede no tenerlo).
   */
  uqNumero: uniqueIndex('uq_comprobantes_numero')
    .on(t.proveedorId, t.tipo, t.puntoVenta, t.numero)
    .where(sql`${t.numero} is not null`),
  /**
   * "¿Qué notas ajustan a esta factura?" se pregunta MUCHO: una vez por cada
   * imputación (para saber el saldo real antes de aceptar un pago) y otra por
   * cada apertura de la bandeja de pagos. Sin índice cada una era un scan de la
   * tabla entera, en el camino de pagar. Parcial porque la enorme mayoría de los
   * comprobantes no referencia a nadie.
   */
  ixRef: index('ix_comprobantes_ref')
    .on(t.refComprobanteId)
    .where(sql`${t.refComprobanteId} is not null`),
}));

/**
 * PERCEPCIONES — los impuestos que el proveedor cobra por adelantado.
 * ============================================================================
 * No son IVA: son pago a cuenta de OTRO impuesto (IVA RG 5329, Ingresos
 * Brutos, Ganancias), y al cierre hay que declarar cada una por separado. Por
 * eso van con nombre y alícuota propios y no sumadas en un "otros".
 *
 * Se configuran POR PROVEEDOR —cada uno cobra las suyas, algunos varias— y al
 * cargar la factura se ofrecen tildadas o no: el mismo proveedor a veces las
 * trae y a veces no, así que el papel siempre manda.
 */
export const basePercepcionEnum = pgEnum('base_percepcion', ['neto', 'total']);

export const proveedorPercepciones = pgTable('proveedor_percepciones', {
  id: serial('id').primaryKey(),
  proveedorId: integer('proveedor_id').notNull().references(() => proveedores.id, { onDelete: 'cascade' }),
  /** Como figura en la factura: "Perc. IVA RG 5329", "Perc. IIBB Formosa". */
  nombre: text('nombre').notNull(),
  alicuota: doublePrecision('alicuota').notNull().default(0),
  /** Sobre qué se calcula: el neto gravado (lo habitual) o el total con IVA. */
  base: basePercepcionEnum('base').notNull().default('neto'),
  activa: boolean('activa').notNull().default(true),
}, (t) => ({
  ixProveedor: index('ix_proveedor_percepciones').on(t.proveedorId),
}));

/**
 * Las percepciones de UN comprobante, con su nombre y alícuota COPIADOS: si
 * mañana cambia la alícuota del proveedor, la factura del año pasado tiene que
 * seguir explicando su propio total.
 */
export const comprobantePercepciones = pgTable('comprobante_percepciones', {
  id: serial('id').primaryKey(),
  comprobanteId: integer('comprobante_id').notNull().references(() => comprobantes.id, { onDelete: 'cascade' }),
  nombre: text('nombre').notNull(),
  alicuota: doublePrecision('alicuota').notNull().default(0),
  base: basePercepcionEnum('base').notNull().default('neto'),
  importe: doublePrecision('importe').notNull().default(0),
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

/* ----------------------------------------------------------------------------
 * FACTURAS POR PROCESAR — la bandeja de papeles subidos
 * --------------------------------------------------------------------------*/

/**
 * `pendiente` está esperando que alguien la revise · `cargada` se convirtió en
 * un comprobante (o se enganchó a uno que ya estaba cargado a mano) ·
 * `descartada` no correspondía (duplicada, ilegible, no era nuestra).
 */
export const estadoLecturaEnum = pgEnum('estado_lectura', ['pendiente', 'cargada', 'descartada']);

/**
 * UNA FACTURA SUBIDA, TODAVÍA NO CARGADA.
 * ============================================================================
 * Separa dos momentos que hoy son uno solo y no tienen por qué serlo: **recibir
 * el papel** (la cajera saca la foto cuando llega el camión) y **cargar la
 * factura** (el admin la procesa el viernes). Ese desacople es el que ahorra
 * tiempo de verdad; leer el QR es la yapa.
 *
 * NO es un comprobante en borrador, y no puede serlo: `comprobante_items`
 * exige `producto_id` y `comprobantes` exige `proveedor_id`, así que una
 * factura recién subida —con renglones que todavía no se reconocieron, o de un
 * CUIT que no está en el padrón— literalmente no se podría guardar ahí. El
 * comprobante se crea al confirmar, ya `confirmado`, por el camino que ya
 * funciona.
 *
 * El encabezado NO se adivina: sale del **QR de la RG 4892**, que es un JSON
 * dentro del papel. Eso da CUIT, tipo, punto de venta, número, fecha, total y
 * CAE con exactitud, sin interpretar la imagen. El `total` de ahí es el número
 * contra el que después se valida que los renglones cierren.
 */
export const facturaLecturas = pgTable('factura_lecturas', {
  id: serial('id').primaryKey(),
  estado: estadoLecturaEnum('estado').notNull().default('pendiente'),
  /** Si el QR se pudo leer. En false, todo el encabezado se carga a mano. */
  leido: boolean('leido').notNull().default(false),

  /* --- Lo que salió del QR (exacto, no interpretado) --- */
  cuit: text('cuit').notNull().default(''),                 // emisor
  tipo: tipoComprobanteEnum('tipo'),
  letra: letraComprobanteEnum('letra'),
  puntoVenta: text('punto_venta').notNull().default(''),
  numero: integer('numero'),
  fecha: timestamp('fecha', { withTimezone: true }),
  total: doublePrecision('total').notNull().default(0),
  cae: text('cae').notNull().default(''),
  moneda: text('moneda').notNull().default(''),
  /**
   * El CUIT al que la factura está dirigida. Se guarda para poder avisar
   * "esta factura no es nuestra": pasa cuando el proveedor factura a otra razón
   * social del mismo dueño, y cargarla mete crédito fiscal que no corresponde.
   */
  cuitReceptor: text('cuit_receptor').notNull().default(''),

  /* --- Resuelto por el sistema o corregido a mano --- */
  proveedorId: integer('proveedor_id').references(() => proveedores.id, { onDelete: 'set null' }),
  /** La sucursal que recibió la mercadería. NO está en el papel: se pregunta. */
  sucursalId: integer('sucursal_id').references(() => sucursales.id, { onDelete: 'set null' }),
  /** Quién subió el papel (no necesariamente quién lo carga después). */
  usuarioId: integer('usuario_id').references(() => usuarios.id, { onDelete: 'set null' }),
  /** Con qué comprobante se cerró. Es el vínculo papel ↔ factura cargada. */
  comprobanteId: integer('comprobante_id').references(() => comprobantes.id, { onDelete: 'set null' }),
  observaciones: text('observaciones').notNull().default(''),
  /** sha256 del contenido: la misma foto subida dos veces se detecta al toque. */
  hash: text('hash').notNull().default(''),
  subidoEn: timestamp('subido_en', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  ixEstado: index('ix_factura_lecturas_estado').on(t.estado),
  // Para buscar si ya existe un comprobante con este número de este proveedor.
  ixNumero: index('ix_factura_lecturas_numero').on(t.proveedorId, t.numero),
  ixHash: index('ix_factura_lecturas_hash').on(t.hash),
}));

/**
 * El papel en sí. En tabla aparte —igual que `gasto_adjuntos` y `web_imagenes`—
 * para que el listado de la bandeja, que se pide entero y seguido, no arrastre
 * nunca los bytes.
 *
 * Es 1:N a propósito: una factura de tres páginas es UNA lectura con tres
 * fotos, no tres facturas.
 */
export const facturaArchivos = pgTable('factura_archivos', {
  id: serial('id').primaryKey(),
  lecturaId: integer('lectura_id').notNull().references(() => facturaLecturas.id, { onDelete: 'cascade' }),
  nombre: text('nombre').notNull().default(''),
  mime: text('mime').notNull().default('image/webp'),
  /** Base64 SIN el prefijo data-URL. */
  data: text('data').notNull(),
  subidoEn: timestamp('subido_en', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  ixLectura: index('ix_factura_archivos_lectura').on(t.lecturaId),
}));

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
  // Comercial. Las listas del cliente están en `cliente_listas` (puede tener
  // varias predeterminadas); sin ninguna, se usa la lista base de la config.
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

/**
 * Control de caja INTERMEDIO: un conteo de efectivo en medio del turno, sin
 * cerrar nada. Registra la foto del momento — cuánto debería haber (sistema),
 * cuánto se contó y la diferencia — para que el faltante se detecte a las
 * 14:00 y no recién en el cierre de la noche. Solo control: no mueve dinero.
 */
export const cajaControles = pgTable('caja_controles', {
  id: serial('id').primaryKey(),
  cajaSesionId: integer('caja_sesion_id').notNull().references(() => cajaSesiones.id, { onDelete: 'cascade' }),
  fecha: timestamp('fecha', { withTimezone: true }).notNull().defaultNow(),
  esperadoEfectivo: doublePrecision('esperado_efectivo').notNull().default(0),
  contadoEfectivo: doublePrecision('contado_efectivo').notNull().default(0),
  diferencia: doublePrecision('diferencia').notNull().default(0),
  observaciones: text('observaciones').notNull().default(''),
  usuarioId: integer('usuario_id').references(() => usuarios.id, { onDelete: 'set null' }),
}, (t) => ({
  ixSesion: index('ix_caja_controles_sesion').on(t.cajaSesionId),
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
  /** De qué presupuesto nació esta venta (null = venta de mostrador común). */
  presupuestoId: integer('presupuesto_id'),
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
  // Con qué lista se vendió ESTE renglón. Las condiciones se evalúan por
  // renglón (12 unidades de una marca habilitan solo esos renglones), así que
  // un mismo ticket puede mezclar listas con total normalidad.
  //   · `listaId` es la referencia estable, para reportes y agrupaciones.
  //   · `lista` es el nombre CONGELADO al momento de vender, para que un ticket
  //     viejo se reimprima igual aunque después se renombre o se dé de baja.
  //   · `listaOrigen` dice por qué quedó esa: es lo que permite auditar si
  //     alguien aplica precio mayorista a mano a quien no califica.
  listaId: integer('lista_id').references(() => listasVenta.id, { onDelete: 'set null' }),
  lista: text('lista').notNull().default(''),
  listaOrigen: origenListaEnum('lista_origen').notNull().default('base'),
  // Se guardan los DOS precios: sin el de lista no se puede auditar el descuento.
  precioLista: doublePrecision('precio_lista').notNull().default(0),
  descuento: doublePrecision('descuento').notNull().default(0),
  precioUnitario: doublePrecision('precio_unitario').notNull().default(0),
  iva: doublePrecision('iva').notNull().default(21),
  /**
   * Oferta aplicada al renglón (una sola: la de mayor beneficio).
   *   · `ofertaId` referencia estable para reportes.
   *   · `oferta` nombre CONGELADO al vender, como `lista`.
   *   · `ofertaDescuento` importe NETO que se restó — sin él no se puede
   *     auditar cuánto costó la promoción.
   */
  ofertaId: integer('oferta_id').references(() => ofertas.id, { onDelete: 'set null' }),
  oferta: text('oferta').notNull().default(''),
  ofertaDescuento: doublePrecision('oferta_descuento').notNull().default(0),
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

/* ---------------- Presupuestos (pedidos mayoristas) ---------------- */
/**
 * La BANDEJA DE ENTRADA de los pedidos mayoristas: hoy llegan por WhatsApp,
 * mañana entrarán solos desde la tienda web. NO es un comprobante fiscal ni
 * toca la caja — es una cotización con ciclo de vida:
 *
 *   borrador → enviado (precios congelados + vencimiento) → confirmado
 *   (el cliente dijo sí: acá SE RESERVA el stock mientras se arma el pedido)
 *   → cerrado (se convirtió en venta real, ref. `ventaId`) | cancelado
 *
 * "Vencido" no es un estado: es un ENVIADO cuya fecha pasó — se calcula al
 * mirarlo, sin procesos nocturnos. Un confirmado nunca vence solo: tiene
 * mercadería apartada; se cierra o se cancela a mano.
 */
/* La venta recuerda de qué presupuesto nació (reportes: cuánto entra por pedidos). */
/**
 * `pendiente` es EXCLUSIVO de los pedidos web: llegó desde el sitio y nadie de
 * la casa lo miró todavía. Aceptarlo lo convierte en `enviado` (la palabra de
 * la empresa); rechazarlo lo cancela. Los cotizados a mano nunca pasan por acá.
 */
export const estadoPresupuestoEnum = pgEnum('estado_presupuesto', [
  'borrador', 'enviado', 'confirmado', 'cerrado', 'cancelado', 'pendiente',
]);

export const presupuestos = pgTable('presupuestos', {
  id: serial('id').primaryKey(),
  codigo: text('codigo').notNull().default(''),
  fecha: timestamp('fecha', { withTimezone: true }).notNull().defaultNow(),
  /**
   * NULLABLE a propósito: un pedido web de un DNI desconocido llega SIN cliente
   * (los datos del formulario esperan en `webCliente`) y el alta se decide al
   * aceptar la orden — así una prueba o un spam no ensucian la base.
   */
  clienteId: integer('cliente_id').references(() => clientes.id, { onDelete: 'restrict' }),
  sucursalId: integer('sucursal_id').notNull().references(() => sucursales.id, { onDelete: 'restrict' }),
  /** Quién lo cotizó (el admin) y a quién se le delegó el armado/cierre. */
  usuarioId: integer('usuario_id').references(() => usuarios.id, { onDelete: 'set null' }),
  vendedorId: integer('vendedor_id').references(() => usuarios.id, { onDelete: 'set null' }),
  estado: estadoPresupuestoEnum('estado').notNull().default('borrador'),
  /** Cómo se entrega: retiro en local | cadete | camioneta de la empresa. */
  entrega: text('entrega').notNull().default('retiro'),
  /** Se fija al ENVIAR: fecha de envío + validez configurada. */
  vencimiento: timestamp('vencimiento', { withTimezone: true }),
  ventaId: integer('venta_id').references(() => ventas.id, { onDelete: 'set null' }),
  /** true = al confirmar SE RESERVÓ stock; el cierre o la cancelación lo liberan. */
  reservado: boolean('reservado').notNull().default(false),
  /**
   * De dónde nació: 'manual' (cotizado en el POS) | 'web' (pedido del sitio).
   * Columna propia y no una marca en observaciones: el texto lo escribe el
   * cliente y pisaba la única forma de saber el origen.
   */
  origen: text('origen').notNull().default('manual'),
  /**
   * Foto del formulario del sitio: { nombre, apellido, telefono, dni }.
   * Queda SIEMPRE en los pedidos web (aunque el DNI haya matcheado un cliente):
   * es el registro de qué dijo el cliente, con su teléfono del momento.
   */
  webCliente: jsonb('web_cliente'),
  observaciones: text('observaciones').notNull().default(''),
  /** Totales CONGELADOS al cotizar: son la palabra dada al cliente. */
  subtotalNeto: doublePrecision('subtotal_neto').notNull().default(0),
  ivaTotal: doublePrecision('iva_total').notNull().default(0),
  total: doublePrecision('total').notNull().default(0),
});

export const presupuestoItems = pgTable('presupuesto_items', {
  id: serial('id').primaryKey(),
  presupuestoId: integer('presupuesto_id').notNull().references(() => presupuestos.id, { onDelete: 'cascade' }),
  productoId: integer('producto_id').notNull().references(() => productos.id, { onDelete: 'restrict' }),
  presentacionId: integer('presentacion_id').references(() => presentaciones.id, { onDelete: 'set null' }),
  /** Etiquetas congeladas: el papel dice lo mismo aunque se renombre el producto. */
  nombre: text('nombre').notNull().default(''),
  detalle: text('detalle').notNull().default(''),
  cantidad: doublePrecision('cantidad').notNull().default(0),
  /** Lo que el vendedor ARMÓ de verdad. Null = todavía no se armó (= pedida). */
  cantidadArmada: doublePrecision('cantidad_armada'),
  /** Precio NETO unitario congelado + condiciones con las que se cotizó. */
  precioLista: doublePrecision('precio_lista').notNull().default(0),
  descuento: doublePrecision('descuento').notNull().default(0),
  iva: doublePrecision('iva').notNull().default(21),
  lista: text('lista').notNull().default(''),
  ofertaNombre: text('oferta_nombre').notNull().default(''),
  motivo: text('motivo').notNull().default(''),
}, (t) => ({
  ixPresupuesto: index('ix_presupuesto_items_presupuesto').on(t.presupuestoId),
}));

/* ---------------- Imágenes del sitio web ---------------- */
/**
 * Imágenes que carga el módulo Web: fotos de producto, imagen de categoría,
 * logo de marca y banners del sitio. POLIMÓRFICA (`tipo` + `refId`, sin FK):
 * una tabla y un endpoint en vez de cuatro. El binario vive como base64 y se
 * sirve por `GET /tienda/imagenes/:tipo/:refId` — el catálogo público solo
 * lleva la URL, nunca los bytes.
 */
export const tipoImagenWebEnum = pgEnum('tipo_imagen_web', ['producto', 'categoria', 'marca', 'banner', 'logo', 'favicon']);

export const webImagenes = pgTable('web_imagenes', {
  id: serial('id').primaryKey(),
  tipo: tipoImagenWebEnum('tipo').notNull(),
  refId: integer('ref_id').notNull(),
  mime: text('mime').notNull().default('image/jpeg'),
  /** Base64 SIN el prefijo data-URL. */
  data: text('data').notNull(),
  actualizadoEn: timestamp('actualizado_en', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uqRef: uniqueIndex('uq_web_imagen').on(t.tipo, t.refId),
}));

/**
 * Telemetría ANÓNIMA del sitio web: qué se mira y cuánto tiempo. La sesión es
 * un UUID que vive en el navegador del visitante — sin nombre, sin IP, sin
 * cookie de terceros. `productoId` va SIN foreign key a propósito: es registro
 * histórico, no debe frenar un borrado de producto ni encarecer cada insert.
 *
 * Tipos: 'vista_pagina' (ruta) · 'vista_producto' (productoId + segundos EN
 * PANTALLA medidos por visibilidad real) · 'agregar_carrito' (productoId).
 */
export const webEventos = pgTable('web_eventos', {
  id: serial('id').primaryKey(),
  fecha: timestamp('fecha', { withTimezone: true }).notNull().defaultNow(),
  sesion: text('sesion').notNull().default(''),
  tipo: text('tipo').notNull(),
  ruta: text('ruta').notNull().default(''),
  productoId: integer('producto_id'),
  segundos: doublePrecision('segundos').notNull().default(0),
}, (t) => ({
  ixFecha: index('ix_web_eventos_fecha').on(t.fecha),
  ixProducto: index('ix_web_eventos_producto').on(t.productoId),
}));

/* ============================================================================
 * GASTOS — lo que la empresa PAGA y no es mercadería
 * ==========================================================================*/
/**
 * Por qué NO reusa `comprobantes` (el de compras):
 *   - Un comprobante de compra tiene ÍTEMS con producto y mueve stock; un gasto
 *     no tiene producto ninguno: tiene una categoría contable.
 *   - El comprobante alimenta el costo del catálogo y el precio de venta; el
 *     gasto no toca ni un precio.
 *   - Mezclarlos obligaría a que la mitad de las columnas fueran nulas en la
 *     mitad de las filas, y a filtrar por tipo en cada consulta de compras.
 *
 * Lo que SÍ comparten es el proveedor (misma tabla) y el libro de IVA compras,
 * que se arma con la unión de los dos — cada uno con su consulta.
 */
export const tipoGastoEnum = pgEnum('tipo_gasto', ['fijo', 'variable']);
export const tipoDocGastoEnum = pgEnum('tipo_doc_gasto', [
  'factura', 'ticket', 'recibo', 'nota_credito', 'otro',
]);
export const estadoGastoEnum = pgEnum('estado_gasto', ['pendiente', 'pagado', 'anulado']);
export const frecuenciaGastoEnum = pgEnum('frecuencia_gasto', [
  'mensual', 'bimestral', 'trimestral', 'semestral', 'anual',
]);

/**
 * Plan de gastos: la lista de rubros contra la que se imputa cada gasto. El
 * `tipo` (fijo/variable) es lo que hace útil el reporte de gerencia: el
 * alquiler no se compara con el combustible.
 *
 * No se borran si tienen gastos imputados (restrict): la historia tiene que
 * seguir siendo explicable. Se dan de baja con `activa: false`.
 */
export const gastoCategorias = pgTable('gasto_categorias', {
  id: serial('id').primaryKey(),
  nombre: text('nombre').notNull(),
  tipo: tipoGastoEnum('tipo').notNull().default('variable'),
  descripcion: text('descripcion').notNull().default(''),
  activa: boolean('activa').notNull().default(true),
  orden: integer('orden').notNull().default(0),
}, (t) => ({
  uqNombre: uniqueIndex('uq_gasto_categoria_nombre').on(t.nombre),
}));

/**
 * El gasto: un comprobante que la empresa recibió y tiene que pagar.
 *
 * `proveedorId` es opcional a propósito: el ticket de nafta o la changa del
 * momento no justifican dar de alta un proveedor, y obligar a hacerlo termina
 * en un "Varios" que junta todo. Para esos casos queda `proveedorTexto`, que
 * es dato descriptivo y nada más — sin proveedor no hay cuenta corriente.
 *
 * `pagado` está DESNORMALIZADO (es la suma de las imputaciones que apuntan a
 * este gasto) porque la bandeja de cuentas a pagar lo filtra y ordena en cada
 * carga. Se recalcula dentro de la misma transacción que la imputación.
 */
/**
 * A qué negocio se imputa el gasto. Mismo CUIT, misma empresa, pero el dueño
 * tiene DOS negocios (la distribuidora y la cafetería): separar la imputación
 * es lo que permite responder "¿cuánto me cuesta la cafetería por mes?" sin
 * inventar un CUIT ni una sucursal con stock.
 */
export const negocioGastoEnum = pgEnum('negocio_gasto', ['distribuidora', 'cafeteria']);

export const gastos = pgTable('gastos', {
  id: serial('id').primaryKey(),
  // La del papel (define el período) y la de carga (cuándo entró al sistema).
  fecha: timestamp('fecha', { withTimezone: true }).notNull().defaultNow(),
  fechaCarga: timestamp('fecha_carga', { withTimezone: true }).notNull().defaultNow(),
  tipoDoc: tipoDocGastoEnum('tipo_doc').notNull().default('factura'),
  letra: letraComprobanteEnum('letra').notNull().default('B'),
  /** Libre: los servicios numeran como se les da la gana ("0002-00013456"). */
  numero: text('numero').notNull().default(''),
  proveedorId: integer('proveedor_id').references(() => proveedores.id, { onDelete: 'restrict' }),
  proveedorTexto: text('proveedor_texto').notNull().default(''),
  categoriaId: integer('categoria_id').notNull().references(() => gastoCategorias.id, { onDelete: 'restrict' }),
  sucursalId: integer('sucursal_id').references(() => sucursales.id, { onDelete: 'set null' }),
  descripcion: text('descripcion').notNull().default(''),
  condicionPago: condicionPagoEnum('condicion_pago').notNull().default('contado'),
  vencimiento: timestamp('vencimiento', { withTimezone: true }),
  neto: doublePrecision('neto').notNull().default(0),
  iva: doublePrecision('iva').notNull().default(0),
  /** Percepciones, impuestos internos y todo lo que suma sin ser IVA. */
  otros: doublePrecision('otros').notNull().default(0),
  total: doublePrecision('total').notNull().default(0),
  pagado: doublePrecision('pagado').notNull().default(0),
  estado: estadoGastoEnum('estado').notNull().default('pendiente'),
  negocio: negocioGastoEnum('negocio').notNull().default('distribuidora'),
  /** Si lo generó un gasto fijo, de cuál salió (para no duplicar el período). */
  recurrenteId: integer('recurrente_id'),
  observaciones: text('observaciones').notNull().default(''),
  usuarioId: integer('usuario_id').references(() => usuarios.id, { onDelete: 'set null' }),
}, (t) => ({
  ixFecha: index('ix_gastos_fecha').on(t.fecha),
  ixEstado: index('ix_gastos_estado').on(t.estado, t.vencimiento),
  ixCategoria: index('ix_gastos_categoria').on(t.categoriaId),
  ixProveedor: index('ix_gastos_proveedor').on(t.proveedorId),
}));

/* ============================================================================
 * ENVÍOS A CAFETERÍA — el puente con coffit
 * ============================================================================
 * La cafetería es del MISMO dueño y el MISMO CUIT, pero su stock lo maneja
 * OTRO sistema (coffit). Por eso esto NO es una transferencia entre
 * sucursales: no hay receptor en el CRM. Es un PUNTO DE SALIDA — la mercadería
 * egresa del stock de la distribuidora valorizada A COSTO (congelado en el
 * documento, porque los costos cambian) y ahí termina la responsabilidad del
 * CRM. El CRM nunca muestra existencias de Cafetería: dos sistemas contando la
 * misma leche siempre terminan descuadrando.
 *
 * Los renglones llevan SNAPSHOT (nombre, unidad, códigos): el remito que lee
 * coffit tiene que decir lo mismo dentro de seis meses aunque el producto se
 * renombre, y el código de barras es la clave del mapeo del lado coffit.
 */
/*
 * Sin `tipo_envio_cafe` ni `destino_envio_cafe` desde el 9/8/2026: no hay
 * devoluciones (coffit recibe y punto: una corrección es EDITAR el envío), y el
 * destino de cada renglón (venta/uso) es una decisión DE COFFIT — el CRM la
 * pedía, la guardaba y jamás la leía. La clasificación vive donde vive el stock.
 */
/**
 * Ciclo de vida en DOS estados: el envío nace 'enviado' (egresa stock y congela
 * costo en el mismo acto — con el envío ya se da por hecho que coffit lo
 * recibió) y solo puede pasar a 'anulado' (reversión completa). Las etapas
 * pedido/transito/recibido se colapsaron el 9/8/2026: eran teatro de un viaje
 * que en la práctica es cruzar la calle, y cada etapa era un lugar más donde
 * el estado del CRM y el de coffit podían divergir.
 */
export const estadoEnvioCafeEnum = pgEnum('estado_envio_cafe', ['enviado', 'anulado']);
/**
 * En qué unidad habla `cantidad`, EXPLÍCITO. Antes se deducía de si
 * `presentacionId` venía en null — la ambigüedad exacta que puede convertir 10
 * paquetes de 500 g en 10 kg del lado de coffit.
 *   granel  → cantidad en KG (tamKg = 1)
 *   paquete → cantidad en PAQUETES de la presentación (tamKg = kg por paquete)
 *   unidad  → cantidad en UNIDADES de producto entero (tamKg = 0: no aplica)
 */
export const modoEnvioCafeEnum = pgEnum('modo_envio_cafe', ['granel', 'paquete', 'unidad']);

/**
 * EL PEDIDO DE LA CAFETERÍA — la demanda, no el envío.
 *
 * Lo arma el usuario del rol Cafetería desde SU pantalla (el CRM con una sola
 * sección visible): elige del catálogo completo con disponibilidad a la vista.
 * NO toca stock ni congela costo — es un pedido, la vieja lección: la realidad
 * entra recién con el ENVÍO, que se crea desde el pedido y lo cierra.
 *
 *   pendiente ──tomar──► armando ──convertir en envío──► enviado
 *        └──────────────anular (con motivo)──────────────► anulado
 */
export const estadoPedidoCafeEnum = pgEnum('estado_pedido_cafe', ['pendiente', 'armando', 'enviado', 'anulado']);

export const pedidosCafeteria = pgTable('pedidos_cafeteria', {
  id: serial('id').primaryKey(),
  codigo: text('codigo').notNull().default(''),
  fecha: timestamp('fecha', { withTimezone: true }).notNull().defaultNow(),
  /** Quién lo pidió (el usuario del rol Cafetería). */
  usuarioId: integer('usuario_id').references(() => usuarios.id, { onDelete: 'set null' }),
  estado: estadoPedidoCafeEnum('estado').notNull().default('pendiente'),
  observaciones: text('observaciones').notNull().default(''),
  motivoAnulacion: text('motivo_anulacion').notNull().default(''),
  actualizadoEn: timestamp('actualizado_en', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // El badge y el aviso del admin preguntan esto en cada poll.
  ixEstado: index('ix_pedidos_cafe_estado').on(t.estado),
}));

export const pedidoCafeteriaItems = pgTable('pedido_cafeteria_items', {
  id: serial('id').primaryKey(),
  pedidoId: integer('pedido_id').notNull().references(() => pedidosCafeteria.id, { onDelete: 'cascade' }),
  productoId: integer('producto_id').notNull().references(() => productos.id, { onDelete: 'restrict' }),
  presentacionId: integer('presentacion_id').references(() => presentaciones.id, { onDelete: 'restrict' }),
  cantidad: doublePrecision('cantidad').notNull().default(0),
  /* Snapshot para que el pedido histórico siga siendo legible tal como se pidió. */
  nombre: text('nombre').notNull().default(''),
  unidad: text('unidad').notNull().default(''),
});

export const enviosCafeteria = pgTable('envios_cafeteria', {
  id: serial('id').primaryKey(),
  codigo: text('codigo').notNull().default(''),
  fecha: timestamp('fecha', { withTimezone: true }).notNull().defaultNow(),
  /** De qué sucursal sale la mercadería. */
  sucursalId: integer('sucursal_id').notNull().references(() => sucursales.id, { onDelete: 'restrict' }),
  usuarioId: integer('usuario_id').references(() => usuarios.id, { onDelete: 'set null' }),
  estado: estadoEnvioCafeEnum('estado').notNull().default('enviado'),
  /** Suma de renglones a costo — lo que este envío le "cuesta" a la cafetería. */
  totalCosto: doublePrecision('total_costo').notNull().default(0),
  observaciones: text('observaciones').notNull().default(''),
  motivoAnulacion: text('motivo_anulacion').notNull().default(''),
  /**
   * EL PULSO PARA COFFIT. Un envío enviado se puede EDITAR (y anular), así que
   * coffit necesita saber que algo cambió después de haberlo ingresado:
   * `version` sube en cada cambio y `actualizadoEn` es el cursor de
   * sincronización (GET /cafeteria/sync?desde=… devuelve lo tocado desde ahí).
   */
  version: integer('version').notNull().default(1),
  actualizadoEn: timestamp('actualizado_en', { withTimezone: true }).notNull().defaultNow(),
  /**
   * El pedido que este envío vino a cumplir (null = envío espontáneo). Una
   * sola dirección a propósito: el envío conoce su origen y el pedido se
   * resuelve por consulta — dos punteros cruzados terminan en desacuerdo.
   * Viaja en el sync: coffit puede cruzar su pedido con lo que llegó.
   */
  pedidoId: integer('pedido_id'),
}, (t) => ({
  ixFecha: index('ix_envios_cafe_fecha').on(t.fecha),
  // La consulta de sincronización de coffit entra por acá.
  ixActualizado: index('ix_envios_cafe_actualizado').on(t.actualizadoEn),
}));

/* ============================================================================
 * CHAT INTERNO — el mostrador le pregunta a administración sin dejar el puesto
 * ============================================================================
 * Un canal por sucursal (hoy habilitado SOLO en la distribuidora: el gate lo
 * decide la API por el tipo de sucursal, no el cliente). Sin WebSockets: el
 * cliente pollea como los demás avisos del sistema, y la base es la verdad —
 * historial consultable, sobrevive recargas, y el que llega tarde ve todo.
 * `chat_lecturas` guarda hasta dónde leyó cada usuario: el "no leídos" es por
 * usuario y sobrevive al F5 (no vive en el navegador).
 */
export const chatMensajes = pgTable('chat_mensajes', {
  id: serial('id').primaryKey(),
  fecha: timestamp('fecha', { withTimezone: true }).notNull().defaultNow(),
  sucursalId: integer('sucursal_id').notNull().references(() => sucursales.id, { onDelete: 'cascade' }),
  usuarioId: integer('usuario_id').references(() => usuarios.id, { onDelete: 'set null' }),
  /** NULL = canal grupal del local; con valor = mensaje PRIVADO para ese usuario. */
  paraUsuarioId: integer('para_usuario_id').references(() => usuarios.id, { onDelete: 'set null' }),
  texto: text('texto').notNull(),
}, (t) => ({
  ixCanal: index('ix_chat_mensajes_canal').on(t.sucursalId, t.id),
  ixPara: index('ix_chat_mensajes_para').on(t.sucursalId, t.paraUsuarioId, t.id),
}));

export const chatLecturas = pgTable('chat_lecturas', {
  id: serial('id').primaryKey(),
  sucursalId: integer('sucursal_id').notNull().references(() => sucursales.id, { onDelete: 'cascade' }),
  usuarioId: integer('usuario_id').notNull().references(() => usuarios.id, { onDelete: 'cascade' }),
  /** Qué conversación: 0 = canal grupal; otro valor = el privado con ESE usuario. */
  canalUsuarioId: integer('canal_usuario_id').notNull().default(0),
  ultimoMensajeId: integer('ultimo_mensaje_id').notNull().default(0),
}, (t) => ({
  uq: uniqueIndex('uq_chat_lectura').on(t.sucursalId, t.usuarioId, t.canalUsuarioId),
}));

export const envioCafeteriaItems = pgTable('envio_cafeteria_items', {
  id: serial('id').primaryKey(),
  envioId: integer('envio_id').notNull().references(() => enviosCafeteria.id, { onDelete: 'cascade' }),
  /**
   * productoId + presentacionId son LA CLAVE ESTABLE para coffit: seriales
   * inmutables. Coffit matchea a mano una vez (su almacén "Sabor y Aroma") y el
   * mapeo no se rompe aunque acá se recodifique o renombre el producto —
   * códigos y nombre viajan solo como legibles.
   */
  productoId: integer('producto_id').notNull().references(() => productos.id, { onDelete: 'restrict' }),
  presentacionId: integer('presentacion_id').references(() => presentaciones.id, { onDelete: 'restrict' }),
  /** En qué unidad habla `cantidad` (ver el enum): la trampa del 20× cerrada. */
  modo: modoEnvioCafeEnum('modo').notNull().default('unidad'),
  cantidad: doublePrecision('cantidad').notNull().default(0),
  /** Kg por unidad de cantidad (granel: 1, paquete: tamKg de la presentación, unidad: 0). */
  tamKg: doublePrecision('tam_kg').notNull().default(0),
  /**
   * Costo unitario CONGELADO al enviar ($/kg, $/paquete o $/unidad). Editar el
   * envío NO re-valúa los renglones que ya estaban: solo un renglón nuevo entra
   * al costo del día. Re-valuar sería cambiar retroactivamente cuánto costó la
   * cafetería en un período ya mirado.
   */
  costoUnitario: doublePrecision('costo_unitario').notNull().default(0),
  /* Snapshot para el remito y para que la pantalla de matcheo en coffit sea legible. */
  nombre: text('nombre').notNull().default(''),
  unidad: text('unidad').notNull().default(''),
  codigoBarras: text('codigo_barras').notNull().default(''),
  codigoPropio: text('codigo_propio').notNull().default(''),
});

/* ============================================================================
 * PAGOS A PROVEEDORES — la plata que sale, en un solo lugar
 * ==========================================================================*/
/**
 * El pago es DEL PROVEEDOR, no del documento. Ese giro es lo que hace posible
 * el caso real: llega el pedido de Coca-Cola a la sucursal, la cajera paga
 * $100.000 del cajón y NO carga la factura (no le corresponde). Al otro día el
 * admin carga la factura y aplica ese pago.
 *
 * Si el pago colgara del documento, ese pago no podría existir hasta que
 * alguien cargue la factura — y la plata ya salió del cajón a las 10:40.
 *
 * Tres invariantes que sostienen todo:
 *
 *   1. La plata sale UNA SOLA VEZ, al crear el pago. Aplicarlo después a una
 *      factura es una IMPUTACIÓN: mueve a qué se debe, no vuelve a mover plata.
 *   2. Un pago sin imputar todavía NO es un gasto ni un costo: es un crédito
 *      contra el proveedor. Contarlo como gasto y después contar la factura
 *      duplicaría el mes.
 *   3. `aplicado` y los `pagado` de los documentos se RECALCULAN sumando las
 *      imputaciones — nunca sumando o restando deltas. Un recálculo no puede
 *      desincronizarse; una aritmética incremental sí, y en silencio.
 */
export const estadoPagoProvEnum = pgEnum('estado_pago_prov', ['activo', 'anulado']);
/**
 * A qué mundo pertenece el pago: compras de mercadería o gastos. Lo elige la
 * cajera al registrar el egreso y NO se puede inferir del proveedor — el que
 * provee las dos cosas es ambiguo. Reparte las bandejas (Compras › Pagos en
 * sucursal vs Gastos › Pagos en sucursal) y RESTRINGE la aplicación: un pago
 * de mercadería solo se aplica a comprobantes de compra, uno de gastos solo a
 * gastos. Si la cajera se equivocó, el destino se corrige mientras el pago no
 * tenga nada aplicado.
 */
export const destinoPagoProvEnum = pgEnum('destino_pago_prov', ['mercaderia', 'gastos']);

export const proveedorPagos = pgTable('proveedor_pagos', {
  id: serial('id').primaryKey(),
  /** La hora exacta en que la plata salió del cajón. Es dato de control. */
  fecha: timestamp('fecha', { withTimezone: true }).notNull().defaultNow(),
  /**
   * Opcional SOLO para el pago que nace pegado a su documento (el ticket de
   * nafta que no tiene proveedor cargado). Un pago a cuenta —el que va a
   * aplicarse después— exige proveedor: sin él no hay cuenta a la que imputar.
   */
  proveedorId: integer('proveedor_id').references(() => proveedores.id, { onDelete: 'restrict' }),
  medio: medioPagoEnum('medio').notNull().default('efectivo'),
  importe: doublePrecision('importe').notNull().default(0),
  /** En qué bandeja vive y contra qué documentos puede aplicarse. */
  destino: destinoPagoProvEnum('destino').notNull().default('mercaderia'),
  /** Suma de las imputaciones. Desnormalizado: la bandeja lo filtra siempre. */
  aplicado: doublePrecision('aplicado').notNull().default(0),
  /** Qué se pagó, en palabras del cajero: "pedido Coca-Cola", "plomero baño". */
  concepto: text('concepto').notNull().default(''),
  /** Nº de remito, de transferencia, quién lo recibió. */
  referencia: text('referencia').notNull().default(''),
  sucursalId: integer('sucursal_id').references(() => sucursales.id, { onDelete: 'set null' }),
  cajaSesionId: integer('caja_sesion_id').references(() => cajaSesiones.id, { onDelete: 'set null' }),
  /** El egreso que este pago generó en la caja, si salió de un turno. */
  cajaMovimientoId: integer('caja_movimiento_id').references(() => cajaMovimientos.id, { onDelete: 'set null' }),
  usuarioId: integer('usuario_id').references(() => usuarios.id, { onDelete: 'set null' }),
  estado: estadoPagoProvEnum('estado').notNull().default('activo'),
  observaciones: text('observaciones').notNull().default(''),
}, (t) => ({
  ixProveedor: index('ix_proveedor_pagos_proveedor').on(t.proveedorId, t.estado),
  ixFecha: index('ix_proveedor_pagos_fecha').on(t.fecha),
  ixCaja: index('ix_proveedor_pagos_caja').on(t.cajaSesionId),
}));

/**
 * A qué documento se aplica un pago. Muchos a muchos de verdad: un pago de
 * $100.000 puede cubrir dos facturas chicas, y una factura puede quedar
 * cubierta por dos pagos de dos cajeras distintas.
 *
 * El documento es un gasto O un comprobante de compra — las dos puntas del
 * mismo padrón de proveedores. Dos columnas nulables con un CHECK de "una y
 * solo una" en vez de un `tipo`+`id` genérico: así la base sigue garantizando
 * la integridad referencial en los dos casos (ver migración 0033).
 */
export const proveedorImputaciones = pgTable('proveedor_imputaciones', {
  id: serial('id').primaryKey(),
  pagoId: integer('pago_id').notNull().references(() => proveedorPagos.id, { onDelete: 'cascade' }),
  gastoId: integer('gasto_id').references(() => gastos.id, { onDelete: 'cascade' }),
  comprobanteId: integer('comprobante_id').references(() => comprobantes.id, { onDelete: 'cascade' }),
  importe: doublePrecision('importe').notNull().default(0),
  fecha: timestamp('fecha', { withTimezone: true }).notNull().defaultNow(),
  usuarioId: integer('usuario_id').references(() => usuarios.id, { onDelete: 'set null' }),
}, (t) => ({
  ixPago: index('ix_prov_imput_pago').on(t.pagoId),
  ixGasto: index('ix_prov_imput_gasto').on(t.gastoId),
  ixComprobante: index('ix_prov_imput_comprobante').on(t.comprobanteId),
}));

/**
 * Gasto FIJO: la plantilla de lo que se repite todos los meses (alquiler,
 * internet, seguro). No es un gasto todavía — es el recordatorio de que va a
 * llegar. El módulo genera el gasto real del período con un clic, y la
 * generación es idempotente: se comprueba contra los gastos ya emitidos por
 * esta plantilla, no contra un flag que se puede desincronizar.
 */
export const gastosRecurrentes = pgTable('gastos_recurrentes', {
  id: serial('id').primaryKey(),
  nombre: text('nombre').notNull(),
  categoriaId: integer('categoria_id').notNull().references(() => gastoCategorias.id, { onDelete: 'restrict' }),
  proveedorId: integer('proveedor_id').references(() => proveedores.id, { onDelete: 'set null' }),
  sucursalId: integer('sucursal_id').references(() => sucursales.id, { onDelete: 'set null' }),
  /** Referencia, no verdad: el importe real lo trae la factura del mes. */
  importeEstimado: doublePrecision('importe_estimado').notNull().default(0),
  frecuencia: frecuenciaGastoEnum('frecuencia').notNull().default('mensual'),
  /** Día del mes en que vence (1–31, se recorta al último día si no existe). */
  diaVencimiento: integer('dia_vencimiento').notNull().default(10),
  activo: boolean('activo').notNull().default(true),
  observaciones: text('observaciones').notNull().default(''),
}, (t) => ({
  ixActivo: index('ix_gastos_recurrentes_activo').on(t.activo),
}));

/**
 * Foto del comprobante. Vive en su propia tabla para que el listado de gastos
 * —que se pide entero y seguido— no arrastre nunca los bytes: se piden aparte,
 * solo cuando alguien abre el detalle.
 */
export const gastoAdjuntos = pgTable('gasto_adjuntos', {
  id: serial('id').primaryKey(),
  gastoId: integer('gasto_id').notNull().references(() => gastos.id, { onDelete: 'cascade' }),
  nombre: text('nombre').notNull().default(''),
  mime: text('mime').notNull().default('image/webp'),
  /** Base64 SIN el prefijo data-URL, igual que `web_imagenes`. */
  data: text('data').notNull(),
  subidoEn: timestamp('subido_en', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  ixGasto: index('ix_gasto_adjuntos_gasto').on(t.gastoId),
}));

/* ============================================================================
 * VENCIMIENTOS — la lista de control de fechas, SIN lote
 * ============================================================================
 * El registro NO es stock: es un vigía. "De este producto hay 6 unidades que
 * vencen el 15/9 en Express 2" — el sistema avisa a tiempo (7/15/30 días) para
 * promocionar o reubicar antes de tirar. La realidad del stock entra recién
 * cuando algo VENCIÓ y se procesa: ahí se genera la baja real (movimiento tipo
 * 'vencido') por las unidades que no se salvaron. Es la versión sin lote de los
 * vencimientos que se quitaron del modelo original (aquéllos eran por lote).
 *
 * El costo viaja CONGELADO al registrar (lección de cafetería): la pérdida de
 * marzo no puede cambiar en julio porque subió el catálogo.
 */

/** El control como acto: quién caminó qué sucursal y cuánto anotó. */
export const vencimientoSesiones = pgTable('vencimiento_sesiones', {
  id: serial('id').primaryKey(),
  fecha: timestamp('fecha', { withTimezone: true }).notNull().defaultNow(),
  sucursalId: integer('sucursal_id').notNull().references(() => sucursales.id, { onDelete: 'restrict' }),
  usuarioId: integer('usuario_id').references(() => usuarios.id, { onDelete: 'set null' }),
  totalItems: integer('total_items').notNull().default(0),
  totalUnidades: doublePrecision('total_unidades').notNull().default(0),
}, (t) => ({
  ixFecha: index('ix_venc_sesiones_fecha').on(t.fecha),
}));

export const vencimientos = pgTable('vencimientos', {
  id: serial('id').primaryKey(),
  productoId: integer('producto_id').notNull().references(() => productos.id, { onDelete: 'restrict' }),
  presentacionId: integer('presentacion_id').references(() => presentaciones.id, { onDelete: 'restrict' }),
  sucursalId: integer('sucursal_id').notNull().references(() => sucursales.id, { onDelete: 'restrict' }),
  sesionId: integer('sesion_id').references(() => vencimientoSesiones.id, { onDelete: 'set null' }),
  /**
   * DATE pelado, sin zona horaria: es la fecha impresa en el paquete, no un
   * instante. Los "días para vencer" se calculan SIEMPRE contra el día de
   * Argentina (now() AT TIME ZONE), nunca contra CURRENT_DATE del server en
   * UTC — a la noche ya es "mañana" en UTC y adelantaría los vencidos.
   */
  fechaVencimiento: date('fecha_vencimiento').notNull(),
  cantidad: doublePrecision('cantidad').notNull().default(0),
  /** Congelado al registrar, con el costo real del formato activo de ese día. */
  costoUnitario: doublePrecision('costo_unitario').notNull().default(0),
  /* Snapshot para listar y exportar sin joins (patrón pedidos de cafetería). */
  nombre: text('nombre').notNull().default(''),
  unidad: text('unidad').notNull().default(''),
  codigoBarras: text('codigo_barras').notNull().default(''),
  observaciones: text('observaciones').notNull().default(''),
  /* El cierre del ciclo: venció → se procesa. Cuántas se salvaron vendiéndose
   * y cuántas se perdieron; la pérdida REAL es costo × (cantidad − vendidas). */
  unidadesVendidas: doublePrecision('unidades_vendidas').notNull().default(0),
  procesado: boolean('procesado').notNull().default(false),
  procesadoEn: timestamp('procesado_en', { withTimezone: true }),
  /** La baja real generada al procesar (movimiento 'vencido'), si se generó. */
  mermaMovimientoId: integer('merma_movimiento_id'),
  /** La oferta REAL armada desde este registro (Ventas › Ofertas, aplica en caja). */
  ofertaId: integer('oferta_id').references(() => ofertas.id, { onDelete: 'set null' }),
  usuarioId: integer('usuario_id').references(() => usuarios.id, { onDelete: 'set null' }),
  creadoEn: timestamp('creado_en', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  ixFechaVenc: index('ix_vencimientos_fecha').on(t.fechaVencimiento),
  ixSucursal: index('ix_vencimientos_sucursal').on(t.sucursalId),
  ixProducto: index('ix_vencimientos_producto').on(t.productoId),
  ixProcesado: index('ix_vencimientos_procesado').on(t.procesado),
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
  sucursales, proveedores, roles, usuarios, productos, presentaciones, productoProveedores,
  marcas, categorias, subcategorias, etiquetas, productoEtiquetas,
  modalidadesVenta, listasVenta, productoListas, clienteListas, reglasMarca,
  ofertas, ofertaAlcances, ofertaComponentes, precioHistorial,
  productoProveedorCostos, stock, movimientos, transferencias, transferenciaItems, transferenciaHist,
  incidencias, comprobantes, comprobanteItems, facturaLecturas, facturaArchivos,
  clientes, cajaSesiones, cajaMovimientos, cajaControles, ventas, ventaItems, ventaExtras, ventaPagos,
  cobranzas, cobranzaPagos, cobranzaImputaciones, presupuestos, presupuestoItems, configuracion,
  webImagenes, webEventos,
  gastoCategorias, gastos, gastosRecurrentes, gastoAdjuntos,
  proveedorPagos, proveedorImputaciones,
};
