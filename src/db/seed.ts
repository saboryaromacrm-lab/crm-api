import 'dotenv/config';
import { resolverDatabaseUrl } from './url';
import { Pool } from 'pg';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  schema, sucursales, proveedores, usuarios, productos, presentaciones, productoProveedores,
  modalidadesVenta, listasVenta, productoListas, reglasMarca,
  marcas, categorias, subcategorias, etiquetas, productoEtiquetas,
} from './schema';
import { truncateAll } from './truncate';
import { InventarioService } from '../inventario/inventario.service';
import { ComprobantesService } from '../comprobantes/comprobantes.module';
import { PagosProveedorService } from '../pagos/pagos.module';
import { ClientesService } from '../clientes/clientes.module';
import { ConfiguracionService } from '../configuracion/configuracion.module';
import { VentasService } from '../ventas/ventas.module';
import { OfertasService } from '../ofertas/ofertas.module';
import { ArcaService } from '../arca/arca.module';
import { CobranzasService } from '../cobranzas/cobranzas.module';
import { CajaService } from '../caja/caja.module';
import { HistorialPreciosService, PreciosService } from '../precios/precios.module';
import { ListasService } from '../listas/listas.module';
import { hashPassword } from '../usuarios/usuarios.module';

/**
 * Datos de ejemplo. Réplica del seed del frontend, ahora persistido. Inserta el
 * catálogo y luego ejecuta operaciones reales (compras, fraccionamiento,
 * transferencias, ventas, incidencia) con el motor de inventario.
 */
async function main() {
  const url = resolverDatabaseUrl();
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema, casing: 'snake_case' });
  const cfgSvc = new ConfiguracionService(db as any);
  const listasSvc = new ListasService(db as any);
  const inv = new InventarioService(db as any, cfgSvc, listasSvc);
  const evolucion = new HistorialPreciosService(db as any, cfgSvc);
  const precios = new PreciosService(db as any, evolucion);
  const pagosSvc = new PagosProveedorService(db as any);
  const comp = new ComprobantesService(db as any, inv, precios, pagosSvc);
  const cfg = cfgSvc;
  const cli = new ClientesService(db as any);
  const caja = new CajaService(db as any);
  const ofertasSvc = new OfertasService(db as any);
  /* El seed nunca factura contra ARCA: sin certificado el servicio se declara
   * no disponible y las ventas salen con la numeración local, como siempre. */
  const arcaSvc = new ArcaService(db as any);
  const vtas = new VentasService(db as any, inv, cfg, cli, caja, listasSvc, ofertasSvc, arcaSvc);
  const cobr = new CobranzasService(db as any, cli, cfg, vtas, caja);

  await truncateAll(pool);

  /* ---- Sucursales ---- */
  const [dist] = await db.insert(sucursales).values({ nombre: 'Distribuidora', tipo: 'distribuidora' }).returning();
  const [ex1] = await db.insert(sucursales).values({ nombre: 'Express 1', tipo: 'express' }).returning();
  const [ex2] = await db.insert(sucursales).values({ nombre: 'Express 2', tipo: 'express' }).returning();
  await db.insert(sucursales).values({ nombre: 'Express 3', tipo: 'express' });

  /* ---- Proveedores ---- */
  const [molino] = await db.insert(proveedores).values({ nombre: 'Molino Sur', cuit: '30-71234567-9', telefono: '11-4000-0001', direccion: 'Ruta 8 km 45, Pilar', email: 'ventas@molinosur.com' }).returning();
  const [legum] = await db.insert(proveedores).values({ nombre: 'Legumbres del Norte', cuit: '30-70011223-4', telefono: '387-500-1122', direccion: 'Av. Belgrano 250, Salta' }).returning();
  const [avpampa] = await db.insert(proveedores).values({ nombre: 'Avena Pampa', cuit: '30-69988776-1', telefono: '2954-40-3300', direccion: 'Parque Ind. Santa Rosa' }).returning();
  const [galletera] = await db.insert(proveedores).values({ nombre: 'Galletera Rosario', cuit: '30-71120034-7', telefono: '341-455-8899', direccion: 'Bv. Oroño 1200, Rosario' }).returning();
  const [bebidas] = await db.insert(proveedores).values({ nombre: 'Bebidas SA', cuit: '30-70567890-2', telefono: '11-4700-2200', direccion: 'Panamericana km 32' }).returning();
  const [yerbatera] = await db.insert(proveedores).values({ nombre: 'Yerbatera Misiones', cuit: '30-71005566-8', telefono: '3764-42-7788', direccion: 'RN 12, Apóstoles' }).returning();

  /* ---- Roles y usuarios ---- */
  const [rSuper] = await db.insert(schema.roles).values({
    clave: 'superadmin', nombre: 'Superadmin', esSistema: true, permisos: ['*'],
    descripcion: 'Maneja todo el sistema: crea roles, permisos y usuarios.',
  }).returning();
  const [rAdmin] = await db.insert(schema.roles).values({
    clave: 'admin', nombre: 'Administrador', esSistema: true,
    // `precio_manual` es la llave para pisar el precio de un renglón y pasar el
    // tope de descuento: la tiene el admin porque es quien regatea en el
    // mostrador. El cajero NO — para él el precio es el de la lista.
    permisos: ['ventas', 'presupuestos', 'devoluciones', 'diferencias', 'precios', 'precio_manual', 'ofertas', 'facturas', 'inventario', 'merma', 'defectuoso', 'incidencia_crear', 'etiquetas', 'pedidos', 'preparar', 'fraccionar', 'config', 'ver'],
    descripcion: 'Cargas de facturas, controles de inventario y almacenes.',
  }).returning();
  const [rFrac] = await db.insert(schema.roles).values({
    clave: 'fraccionador', nombre: 'Fraccionador', esSistema: true,
    permisos: ['fraccionar', 'etiquetas', 'merma', 'defectuoso', 'incidencia_crear', 'ver'],
    descripcion: 'Fracciona lo a granel y arma su lista en los envíos.',
  }).returning();
  const [rCajero] = await db.insert(schema.roles).values({
    clave: 'cajero', nombre: 'Cajero', esSistema: true,
    permisos: ['ventas', 'devoluciones', 'diferencias', 'incidencia_crear', 'pedidos', 'ver'],
    descripcion: 'Cobra en caja y hace pedidos de mercadería entre sucursales.',
  }).returning();

  // Contraseña inicial de todos en el demo: 1234 (se cambia desde Gerencia).
  const pw1234 = hashPassword('1234');
  const [lucas] = await db.insert(usuarios).values({ nombre: 'Lucas', rolId: rSuper.id, passwordHash: pw1234, activo: true }).returning();
  const [ana] = await db.insert(usuarios).values({ nombre: 'Ana (Admin)', rolId: rAdmin.id, passwordHash: pw1234 }).returning();
  const [bruno] = await db.insert(usuarios).values({ nombre: 'Bruno (Fraccionador)', rolId: rFrac.id, passwordHash: pw1234 }).returning();
  const [carla] = await db.insert(usuarios).values({ nombre: 'Carla (Cajera)', rolId: rCajero.id, passwordHash: pw1234 }).returning();
  void lucas;

  /* ---- Catálogos del producto (marca, categoría › subcategoría, etiquetas) ---- */
  const marca = async (nombre: string) => (await db.insert(marcas).values({ nombre }).returning())[0];
  const [mMolienda, mNorte, mPampa, mRosario, mColaCo, mSelva] = await Promise.all(
    ['Molienda del Sur', 'Del Norte', 'Pampa', 'Rosario', 'ColaCo', 'Selva'].map(marca),
  );
  const [alimentos] = await db.insert(categorias).values({ nombre: 'Alimentos' }).returning();
  const [bebidasCat] = await db.insert(categorias).values({ nombre: 'Bebidas' }).returning();
  const [subHarinas] = await db.insert(subcategorias).values({ categoriaId: alimentos.id, nombre: 'Harinas' }).returning();
  const [subLegumbres] = await db.insert(subcategorias).values({ categoriaId: alimentos.id, nombre: 'Legumbres' }).returning();
  const [subGalletitas] = await db.insert(subcategorias).values({ categoriaId: alimentos.id, nombre: 'Galletitas' }).returning();
  const [subGaseosas] = await db.insert(subcategorias).values({ categoriaId: bebidasCat.id, nombre: 'Gaseosas' }).returning();
  const [etSinTacc] = await db.insert(etiquetas).values({ nombre: 'SIN TACC', color: '#2e7d32' }).returning();
  const [etSinAzucar] = await db.insert(etiquetas).values({ nombre: 'SIN AZÚCAR', color: '#1565c0' }).returning();
  const [etOrganico] = await db.insert(etiquetas).values({ nombre: 'ORGÁNICO', color: '#6a1b9a' }).returning();

  /* ---- Productos ---- */
  const [harina] = await db.insert(productos).values({ nombre: 'Harina Integral', codigoPropio: '1001', codigoBarras: '7791234000015', marcaId: mMolienda.id, categoriaId: alimentos.id, subcategoriaId: subHarinas.id, unidadesPorBulto: 10, iva: 10.5, tipo: 'granel' }).returning();
  const [lentejas] = await db.insert(productos).values({ nombre: 'Lentejas', codigoPropio: '1002', codigoBarras: '7791234000022', marcaId: mNorte.id, categoriaId: alimentos.id, subcategoriaId: subLegumbres.id, unidadesPorBulto: 10, iva: 10.5, tipo: 'granel' }).returning();
  const [avena] = await db.insert(productos).values({ nombre: 'Avena', codigoPropio: '1003', codigoBarras: '7791234000039', marcaId: mPampa.id, categoriaId: alimentos.id, iva: 10.5, tipo: 'granel' }).returning();
  const [galletitas] = await db.insert(productos).values({ nombre: 'Galletitas Integrales', codigoPropio: '1004', codigoBarras: '7791234000046', dun: '17791234000043', unidadesPorBulto: 12, marcaId: mRosario.id, categoriaId: alimentos.id, subcategoriaId: subGalletitas.id, iva: 21, tipo: 'entero' }).returning();
  const [gaseosa] = await db.insert(productos).values({ nombre: 'Gaseosa Cola 2,25L', codigoPropio: '1005', codigoBarras: '7791234000053', dun: '17791234000050', unidadesPorBulto: 6, marcaId: mColaCo.id, categoriaId: bebidasCat.id, subcategoriaId: subGaseosas.id, iva: 21, tipo: 'entero' }).returning();
  const [yerba] = await db.insert(productos).values({ nombre: 'Yerba Orgánica 1kg', codigoPropio: '1006', codigoBarras: '7791234000060', marcaId: mSelva.id, categoriaId: alimentos.id, iva: 21, tipo: 'entero' }).returning();

  /* Etiquetas: transversales a la categoría, es lo que las hace útiles. */
  await db.insert(productoEtiquetas).values([
    { productoId: harina.id, etiquetaId: etOrganico.id },
    { productoId: lentejas.id, etiquetaId: etSinTacc.id },
    { productoId: avena.id, etiquetaId: etSinTacc.id },
    { productoId: galletitas.id, etiquetaId: etSinAzucar.id },
    { productoId: yerba.id, etiquetaId: etOrganico.id },
  ]);

  /* ---- Presentaciones (granel): SOLO el tamaño ----
   * La presentación define cuánto granel consume el paquete y nada más. El
   * precio es del paquete y vive en su formato de venta, abajo. */
  const presHarina = await db.insert(presentaciones).values([
    { productoId: harina.id, tamKg: 1, codigoBarras: '7791234100012' },
    { productoId: harina.id, tamKg: 0.5, codigoBarras: '7791234100029' },
    { productoId: harina.id, tamKg: 0.25, codigoBarras: '7791234100036' },
  ]).returning();
  const presLentejas = await db.insert(presentaciones).values([
    { productoId: lentejas.id, tamKg: 1, codigoBarras: '7791234100043' },
    { productoId: lentejas.id, tamKg: 0.5 },
  ]).returning();
  await db.insert(presentaciones).values([
    { productoId: avena.id, tamKg: 1, codigoBarras: '7791234100050' },
    { productoId: avena.id, tamKg: 0.5 },
  ]);
  const harina1kg = presHarina.find((p) => Math.abs(p.tamKg - 1) < 1e-6)!;
  const harina05 = presHarina.find((p) => Math.abs(p.tamKg - 0.5) < 1e-6)!;
  const harina025 = presHarina.find((p) => Math.abs(p.tamKg - 0.25) < 1e-6)!;
  const lentejas1kg = presLentejas.find((p) => Math.abs(p.tamKg - 1) < 1e-6)!;

  /* ---- FORMATOS DE COMPRA ----
   * Todos los importes son del BULTO. `usarParaPrecio` marca el único que
   * define el costo con el que se calcula el precio de venta.
   *
   * La harina muestra el caso completo: dos proveedores, y el segundo vende por
   * bolsón de 25 kg — el costo unitario es lo que los hace comparables.
   * Las galletitas muestran la escala de descuentos en cascada (20 y 10 = 28%).
   */
  await db.insert(productoProveedores).values([
    { productoId: harina.id, proveedorId: molino.id, cantidad: 1, costo: 700, descuento: 5, flete: 3, usarParaPrecio: true, codigoProveedor: 'MOL-HI-1' },
    { productoId: harina.id, proveedorId: legum.id, cantidad: 25, costo: 19000, descuento: 0, flete: 2, codigoProveedor: 'LN-4410' },
  ]);
  await db.insert(productoProveedores).values({ productoId: lentejas.id, proveedorId: legum.id, cantidad: 1, costo: 1300, descuento: 8, flete: 4, usarParaPrecio: true, codigoProveedor: 'LN-2201' });
  await db.insert(productoProveedores).values({ productoId: galletitas.id, proveedorId: galletera.id, cantidad: 12, costo: 14400, descuento: 20, descuento2: 10, flete: 5, usarParaPrecio: true, codigoProveedor: 'GR-INT-12' });
  await db.insert(productoProveedores).values({ productoId: gaseosa.id, proveedorId: bebidas.id, cantidad: 6, costo: 6600, flete: 4, usarParaPrecio: true, codigoProveedor: 'BEB-C6' });

  /* ---- Modalidades y listas ----
   * La lista es SOLO identidad. El `orden` es la preferencia: entre las que el
   * renglón habilite gana la de orden menor, por eso las mayoristas van
   * primero y el mostrador queda último (es el piso).
   */
  const [modMin] = await db.insert(modalidadesVenta).values({ nombre: 'Minorista', orden: 1 }).returning();
  const [modMay] = await db.insert(modalidadesVenta).values({ nombre: 'Mayorista', orden: 2 }).returning();

  const [mayA] = await db.insert(listasVenta).values({
    modalidadId: modMay.id, numero: 1, nombre: 'Mayorista', orden: 10,
  }).returning();
  const [minOferta] = await db.insert(listasVenta).values({
    modalidadId: modMin.id, numero: 2, nombre: 'Oferta', orden: 30,
  }).returning();
  const [minGeneral] = await db.insert(listasVenta).values({
    modalidadId: modMin.id, numero: 1, nombre: 'Mostrador', orden: 90,
  }).returning();

  await cfg.set('ventas', {
    listaBaseId: minGeneral.id,
    // Acceso mayorista por monto: se sugiere al pasar los $40.000 y solo vale
    // en efectivo. Alcanza únicamente a los productos con lista mayorista.
    montoMinimoMayorista: 40000,
    modalidadMontoId: modMay.id,
    mediosPagoMonto: ['efectivo'],
  });

  /* ---- FORMATO DE VENTA: el markup es de cada producto, no de la lista ----
   * La misma "Mayorista 1" va al 30% en la harina y al 22% en la gaseosa. Sin
   * fila, el producto no se vende en esa lista (galletitas no tiene mayorista).
   */
  await db.insert(productoListas).values([
    // Harina: las tres listas, con markups propios. Mayorista desde 10 unidades.
    { productoId: harina.id, listaId: minGeneral.id, markup: 65 },
    { productoId: harina.id, listaId: minOferta.id, markup: 12 },
    { productoId: harina.id, listaId: mayA.id, markup: 30, unidadesMinimas: 10 },
    // Lentejas: mayorista propio desde 6, sin oferta.
    { productoId: lentejas.id, listaId: minGeneral.id, markup: 55 },
    { productoId: lentejas.id, listaId: mayA.id, markup: 25, unidadesMinimas: 6 },
    // Galletitas: sin mayorista. La Oferta va con PRECIO DEFINIDO: $1.500
    // finales por unidad, fijados a mano — no se mueven aunque cambie el costo.
    { productoId: galletitas.id, listaId: minGeneral.id, markup: 50 },
    { productoId: galletitas.id, listaId: minOferta.id, modoPrecio: 'precio', precioFijo: 1500 },
    // Gaseosa: minorista por unidad; mayorista POR CAJA DE 6, con el código de
    // barras de la caja — escanearlo en el POS carga las 6 de una.
    { productoId: gaseosa.id, listaId: minGeneral.id, markup: 70 },
    { productoId: gaseosa.id, listaId: mayA.id, markup: 22, unidades: 6, codigoBarras: '27791234000057' },
    // Avena: solo mostrador.
    { productoId: avena.id, listaId: minGeneral.id, markup: 60 },

    /* ---- Y EL FORMATO DE VENTA DE LOS PAQUETES ----
     * El paquete se cotiza solo: su markup es propio y más alto que el del kilo
     * suelto (envase y mano de obra), que es lo que antes intentaba decir el
     * `recargo`. Ahora puede decir más: el de 250 g de harina va con PRECIO
     * DEFINIDO ($900 el paquete) y el de 1 kg de lentejas se vende también por
     * CAJA DE 12 con su propio código — dos cosas que un recargo no expresaba.
     */
    { productoId: harina.id, presentacionId: harina1kg.id, listaId: minGeneral.id, markup: 78 },
    { productoId: harina.id, presentacionId: harina1kg.id, listaId: mayA.id, markup: 42, unidadesMinimas: 6 },
    { productoId: harina.id, presentacionId: harina05.id, listaId: minGeneral.id, markup: 95 },
    { productoId: harina.id, presentacionId: harina025.id, listaId: minGeneral.id, modoPrecio: 'precio', precioFijo: 900 },
    { productoId: lentejas.id, presentacionId: lentejas1kg.id, listaId: minGeneral.id, markup: 70 },
    { productoId: lentejas.id, presentacionId: lentejas1kg.id, listaId: mayA.id, markup: 38, unidades: 12, codigoBarras: '27791234100040' },
  ]);
  /* El de 500 g de lentejas y los dos de avena quedan SIN formato de venta a
   * propósito: es el caso "paquete sin precio" que el POS tiene que bloquear con
   * el motivo y que el contador de Fraccionamiento tiene que contar. */

  /* La única regla GLOBAL: "12 unidades de ColaCo habilitan Mayorista". */
  await db.insert(reglasMarca).values({
    marcaId: mColaCo.id, unidadesMinimas: 12, modalidadId: modMay.id,
  });

  /* ---- Ofertas (por el servicio real: valida igual que la pantalla) ---- */
  await ofertasSvc.crear({
    nombre: '2ª unidad al 50% en Galletitas', tipo: 'segunda_unidad', porcentaje: 50,
    alcances: [{ tipo: 'producto', refId: galletitas.id }],
  } as any);
  await ofertasSvc.crear({
    nombre: '3×2 en Yerbas', tipo: 'nxm', lleva: 3, paga: 2,
    alcances: [{ tipo: 'producto', refId: yerba.id }],
  } as any);
  await ofertasSvc.crear({
    nombre: '10% en efectivo desde $30.000', tipo: 'ticket',
    porcentaje: 10, montoMinimo: 30000, mediosPago: 'efectivo',
  } as any);

  /* ---- Evolución de precios ----
   * Snapshot inicial (el "alta" de cada precio) y un aumento de ejemplo por el
   * SERVICIO REAL: genera historial de costos + evolución, igual que en vivo.
   */
  await evolucion.snapshot(
    [harina.id, lentejas.id, avena.id, galletitas.id, gaseosa.id, yerba.id],
    'inicial',
  );
  const [ppHarina] = await db.select().from(productoProveedores).where(eq(productoProveedores.productoId, harina.id));
  await precios.actualizarCostos({
    cambios: [{ id: ppHarina.id, costo: 770 }],
    origen: 'manual',
    motivo: 'Aumento Molino Sur agosto (+10%)',
    usuarioId: ana.id,
  } as any);

  /* ---- Operaciones (motor real) ---- */
  await inv.opCompra({ productoId: harina.id, sucursalId: dist.id, cantidad: 55, proveedorId: molino.id, usuarioId: ana.id });
  await inv.opCompra({ productoId: lentejas.id, sucursalId: dist.id, cantidad: 20, proveedorId: legum.id, usuarioId: ana.id });
  await inv.opCompra({ productoId: avena.id, sucursalId: dist.id, cantidad: 15, proveedorId: avpampa.id, usuarioId: ana.id });
  await inv.opCompra({ productoId: galletitas.id, sucursalId: dist.id, cantidad: 60, proveedorId: galletera.id, usuarioId: ana.id });
  await inv.opCompra({ productoId: gaseosa.id, sucursalId: dist.id, cantidad: 48, proveedorId: bebidas.id, usuarioId: ana.id });
  await inv.opCompra({ productoId: yerba.id, sucursalId: dist.id, cantidad: 40, proveedorId: yerbatera.id, usuarioId: ana.id });

  await inv.opFraccionar({ productoId: harina.id, sucursalId: dist.id, usuarioId: bruno.id, asignaciones: [
    { presId: harina1kg.id, cant: 5 }, { presId: harina05.id, cant: 10 },
  ] });

  // Circuito completo con la preparación en dos listas: tomar el pedido,
  // confirmar Enteros y Fraccionados (ahí se reserva), despachar y recibir.
  const t1 = await inv.crearTransferencia({ origenId: dist.id, destinoId: ex1.id, usuarioId: ana.id, items: [
    { productoId: harina.id, presId: harina1kg.id, cantidad: 3 },
    { productoId: galletitas.id, cantidad: 12 },
  ] });
  await inv.avanzarTransferencia(t1.id, ana.id, 'pendiente');
  await inv.confirmarListaTransferencia(t1.id, { tipo: 'enteros', listo: true, usuarioId: ana.id });
  await inv.confirmarListaTransferencia(t1.id, { tipo: 'granel', listo: true, usuarioId: bruno.id });
  await inv.avanzarTransferencia(t1.id, ana.id, 'preparada');
  await inv.recibirTransferencia(t1.id, { usuarioId: ana.id });

  await inv.crearTransferencia({ origenId: dist.id, destinoId: ex2.id, usuarioId: ana.id, items: [{ productoId: avena.id, cantidad: 5 }] });

  await inv.opVenta({ productoId: harina.id, sucursalId: dist.id, cantidad: 2.5, usuarioId: carla.id });
  await inv.opVenta({ productoId: harina.id, sucursalId: ex1.id, presId: harina1kg.id, cantidad: 1, usuarioId: carla.id });
  await inv.opVenta({ productoId: galletitas.id, sucursalId: ex1.id, cantidad: 5, usuarioId: carla.id });

  await inv.crearIncidencia({ tipo: 'Bolsa rota', productoId: avena.id, sucursalId: dist.id, cantidad: 2, responsableId: bruno.id, motivo: 'Bolsa dañada en depósito' });

  // Comprobante de ejemplo: factura en cuenta corriente de Molino Sur (sin recepción,
  // para no duplicar el stock ya ingresado). Da saldo a la cuenta del proveedor.
  await comp.create({
    tipo: 'factura', letra: 'A', puntoVenta: '0001', numero: 1024, proveedorId: molino.id, sucursalId: dist.id,
    condicionPago: 'cuenta_corriente', recepcion: false, usuarioId: ana.id,
    observaciones: 'Factura de la compra inicial de harina',
    items: [{ productoId: harina.id, cantidad: 55, costoUnitario: 700, descuento: 5, iva: 10.5 }],
  }, {
    // El seed es un script de confianza que corre sin sesión: pasa los dos
    // permisos en vez de tener que inventar una. `sucursalSesion` no se usa acá
    // (esta factura no tiene pago contado), pero es obligatorio a propósito —
    // que el compilador obligue a pensarlo en cada llamador es justamente el
    // punto.
    puedeTocarPrecios: true, sucursalSesion: dist.id,
  });

  /* ======================== VENTAS ======================== */

  // El Consumidor Final es del sistema: se autocrea y no se borra.
  await cli.consumidorFinal();

  const kiosco = await cli.create({
    nombre: 'Kiosco La Esquina', nombreFantasia: 'La Esquina', tipoDoc: 'cuit', numeroDoc: '30712345678',
    condicionIva: 'responsable_inscripto', direccion: 'San Martín 450', localidad: 'Pilar',
    telefono: '11-4300-1122', email: 'compras@laesquina.com', descuento: 5,
    ctaCteHabilitada: true, limiteCredito: 150000, diasPlazo: 30, sucursalId: dist.id, vendedorId: carla.id,
  });
  const dietetica = await cli.create({
    nombre: 'Dietética Vida Sana', tipoDoc: 'cuit', numeroDoc: '30709988771',
    condicionIva: 'monotributo', direccion: 'Rivadavia 1200', localidad: 'Escobar',
    telefono: '348-442-7788',
    ctaCteHabilitada: true, limiteCredito: 80000, diasPlazo: 15, sucursalId: dist.id, vendedorId: carla.id,
  });
  // Al kiosco la mayorista le corresponde por contrato: no necesita llegar a
  // ningún mínimo. La dietética compra en oferta; el resto cae al piso.
  await listasSvc.setListasDeCliente(kiosco.id, [mayA.id, minGeneral.id]);
  await listasSvc.setListasDeCliente(dietetica.id, [minOferta.id, minGeneral.id]);

  await cli.create({
    nombre: 'Pérez, Marcela', tipoDoc: 'dni', numeroDoc: '28444555',
    condicionIva: 'consumidor_final', telefono: '11-6000-4455', localidad: 'Pilar', sucursalId: ex1.id,
  });

  /*
   * Dos ventas en cuenta corriente: le dan saldo real a la cobranza de abajo.
   *
   * `puedePisarPrecio` porque el seed escribe precios a mano en vez de tomarlos
   * de las listas, y `sucursalSesion` porque la sucursal ya no sale del dto — las
   * dos son lo que el controller resolvería de una sesión de admin. El `iva` no
   * viaja: lo pone el servidor con la alícuota del producto.
   */
  const comoAdmin = { puedePisarPrecio: true, sucursalSesion: dist.id, esJefe: true };
  const v1 = await vtas.create({
    clienteId: kiosco.id, usuarioId: carla.id, condicionPago: 'cuenta_corriente',
    observaciones: 'Pedido semanal',
    items: [
      { productoId: galletitas.id, cantidad: 12, precioLista: 900, precioUnitario: 900, descuento: 5 },
      { productoId: yerba.id, cantidad: 6, precioLista: 2400, precioUnitario: 2400 },
    ],
  }, comoAdmin);
  await vtas.create({
    clienteId: dietetica.id, usuarioId: carla.id, condicionPago: 'cuenta_corriente',
    items: [{ productoId: avena.id, cantidad: 4, precioLista: 1800, precioUnitario: 1800 }],
  }, comoAdmin);

  // Cobranza parcial del kiosco: paga una parte de la primera venta.
  await cobr.create({
    clienteId: kiosco.id, usuarioId: ana.id,
    observaciones: 'Pago parcial a cuenta del pedido semanal',
    pagos: [{ medio: 'transferencia', importe: 10000, referencia: 'CBU 0070…' }],
    imputaciones: [{ ventaId: v1.id, importe: 10000 }],
  }, dist.id);

  await pool.end();
  // eslint-disable-next-line no-console
  console.log('✓ Datos de ejemplo cargados.');
}
main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('Error en el seed:', e);
  process.exit(1);
});
