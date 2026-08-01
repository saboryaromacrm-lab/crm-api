import 'dotenv/config';
import { Pool } from 'pg';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { schema, sucursales, proveedores, usuarios, productos, presentaciones, productoProveedores, listasPrecio } from './schema';
import { truncateAll } from './truncate';
import { InventarioService } from '../inventario/inventario.service';
import { ComprobantesService } from '../comprobantes/comprobantes.module';
import { ClientesService } from '../clientes/clientes.module';
import { ConfiguracionService } from '../configuracion/configuracion.module';
import { VentasService } from '../ventas/ventas.module';
import { CobranzasService } from '../cobranzas/cobranzas.module';
import { CajaService } from '../caja/caja.module';
import { PreciosService } from '../precios/precios.module';

/**
 * Datos de ejemplo. Réplica del seed del frontend, ahora persistido. Inserta el
 * catálogo y luego ejecuta operaciones reales (compras, fraccionamiento,
 * transferencias, ventas, incidencia) con el motor de inventario.
 */
async function main() {
  const url = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/crm';
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema, casing: 'snake_case' });
  const cfgSvc = new ConfiguracionService(db as any);
  const inv = new InventarioService(db as any, cfgSvc);
  const precios = new PreciosService(db as any);
  const comp = new ComprobantesService(db as any, inv, precios);
  const cfg = cfgSvc;
  const cli = new ClientesService(db as any);
  const caja = new CajaService(db as any);
  const vtas = new VentasService(db as any, inv, cfg, cli, caja);
  const cobr = new CobranzasService(db as any, cli, cfg, vtas);

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

  /* ---- Usuarios ---- */
  const [ana] = await db.insert(usuarios).values({ nombre: 'Ana (Admin)', rol: 'admin' }).returning();
  const [bruno] = await db.insert(usuarios).values({ nombre: 'Bruno (Fraccionador)', rol: 'fraccionador' }).returning();
  const [carla] = await db.insert(usuarios).values({ nombre: 'Carla (Vendedora)', rol: 'vendedor' }).returning();

  /* ---- Productos ---- */
  const [harina] = await db.insert(productos).values({ nombre: 'Harina Integral', codigoBarras: '7791234000015', marca: 'Molienda del Sur', categoria: 'Alimentos', iva: 10.5, tipo: 'granel' }).returning();
  const [lentejas] = await db.insert(productos).values({ nombre: 'Lentejas', codigoBarras: '7791234000022', marca: 'Del Norte', categoria: 'Alimentos', iva: 10.5, tipo: 'granel' }).returning();
  const [avena] = await db.insert(productos).values({ nombre: 'Avena', codigoBarras: '7791234000039', marca: 'Pampa', categoria: 'Alimentos', iva: 10.5, tipo: 'granel' }).returning();
  const [galletitas] = await db.insert(productos).values({ nombre: 'Galletitas Integrales', codigoBarras: '7791234000046', marca: 'Rosario', categoria: 'Alimentos', iva: 21, tipo: 'entero' }).returning();
  const [gaseosa] = await db.insert(productos).values({ nombre: 'Gaseosa Cola 2,25L', codigoBarras: '7791234000053', marca: 'ColaCo', categoria: 'Bebidas', iva: 21, tipo: 'entero' }).returning();
  const [yerba] = await db.insert(productos).values({ nombre: 'Yerba Orgánica 1kg', codigoBarras: '7791234000060', marca: 'Selva', categoria: 'Alimentos', iva: 21, tipo: 'entero' }).returning();

  /* ---- Presentaciones (granel): tamaño + % ganancia ---- */
  const presHarina = await db.insert(presentaciones).values([
    { productoId: harina.id, tamKg: 1, recargo: 8, codigoBarras: '7791234100012' },
    { productoId: harina.id, tamKg: 0.5, recargo: 15, codigoBarras: '7791234100029' },
    { productoId: harina.id, tamKg: 0.25, recargo: 25, codigoBarras: '7791234100036' },
  ]).returning();
  await db.insert(presentaciones).values([
    { productoId: lentejas.id, tamKg: 1, recargo: 8, codigoBarras: '7791234100043' },
    { productoId: lentejas.id, tamKg: 0.5, recargo: 15 },
  ]);
  await db.insert(presentaciones).values([
    { productoId: avena.id, tamKg: 1, recargo: 8, codigoBarras: '7791234100050' },
    { productoId: avena.id, tamKg: 0.5, recargo: 15 },
  ]);
  const harina1kg = presHarina.find((p) => Math.abs(p.tamKg - 1) < 1e-6)!;
  const harina05 = presHarina.find((p) => Math.abs(p.tamKg - 0.5) < 1e-6)!;

  /* ---- Costos por proveedor + proveedor activo ---- */
  await db.insert(productoProveedores).values([
    { productoId: harina.id, proveedorId: molino.id, costo: 700, descuento: 5, flete: 3 },
    { productoId: harina.id, proveedorId: legum.id, costo: 760, descuento: 0, flete: 2 },
  ]);
  await db.update(productos).set({ proveedorActivoId: molino.id }).where(eq(productos.id, harina.id));
  await db.insert(productoProveedores).values({ productoId: lentejas.id, proveedorId: legum.id, costo: 1300, descuento: 8, flete: 4 });
  await db.update(productos).set({ proveedorActivoId: legum.id }).where(eq(productos.id, lentejas.id));
  await db.insert(productoProveedores).values({ productoId: galletitas.id, proveedorId: galletera.id, costo: 1200, descuento: 0, flete: 5 });
  await db.update(productos).set({ proveedorActivoId: galletera.id }).where(eq(productos.id, galletitas.id));

  /* ---- Listas de precio ---- */
  await db.insert(listasPrecio).values([
    { productoId: harina.id, nombre: 'Minorista', ganancia: 65 },
    { productoId: harina.id, nombre: 'Mayorista', ganancia: 30 },
    { productoId: harina.id, nombre: 'Oferta', ganancia: 12 },
    { productoId: lentejas.id, nombre: 'Minorista', ganancia: 55 },
    { productoId: lentejas.id, nombre: 'Mayorista', ganancia: 25 },
    { productoId: galletitas.id, nombre: 'Minorista', ganancia: 50 },
    { productoId: galletitas.id, nombre: 'Oferta', ganancia: 20 },
  ]);

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

  const t1 = await inv.crearTransferencia({ origenId: dist.id, destinoId: ex1.id, usuarioId: ana.id, items: [
    { productoId: harina.id, presId: harina1kg.id, cantidad: 3 },
    { productoId: galletitas.id, cantidad: 12 },
  ] });
  await inv.avanzarTransferencia(t1.id);
  await inv.avanzarTransferencia(t1.id);
  await inv.avanzarTransferencia(t1.id);

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
  });

  /* ======================== VENTAS ======================== */

  // El Consumidor Final es del sistema: se autocrea y no se borra.
  await cli.consumidorFinal();

  const kiosco = await cli.create({
    nombre: 'Kiosco La Esquina', nombreFantasia: 'La Esquina', tipoDoc: 'cuit', numeroDoc: '30712345678',
    condicionIva: 'responsable_inscripto', direccion: 'San Martín 450', localidad: 'Pilar',
    telefono: '11-4300-1122', email: 'compras@laesquina.com', listaPrecio: 'Mayorista', descuento: 5,
    ctaCteHabilitada: true, limiteCredito: 150000, diasPlazo: 30, sucursalId: dist.id, vendedorId: carla.id,
  });
  const dietetica = await cli.create({
    nombre: 'Dietética Vida Sana', tipoDoc: 'cuit', numeroDoc: '30709988771',
    condicionIva: 'monotributo', direccion: 'Rivadavia 1200', localidad: 'Escobar',
    telefono: '348-442-7788', listaPrecio: 'Mayorista',
    ctaCteHabilitada: true, limiteCredito: 80000, diasPlazo: 15, sucursalId: dist.id, vendedorId: carla.id,
  });
  await cli.create({
    nombre: 'Pérez, Marcela', tipoDoc: 'dni', numeroDoc: '28444555',
    condicionIva: 'consumidor_final', telefono: '11-6000-4455', localidad: 'Pilar', sucursalId: ex1.id,
  });

  // Dos ventas en cuenta corriente: le dan saldo real a la cobranza de abajo.
  const v1 = await vtas.create({
    clienteId: kiosco.id, sucursalId: dist.id, usuarioId: carla.id, condicionPago: 'cuenta_corriente',
    observaciones: 'Pedido semanal',
    items: [
      { productoId: galletitas.id, cantidad: 12, precioLista: 900, descuento: 5, iva: 21 },
      { productoId: yerba.id, cantidad: 6, precioLista: 2400, iva: 21 },
    ],
  });
  await vtas.create({
    clienteId: dietetica.id, sucursalId: dist.id, usuarioId: carla.id, condicionPago: 'cuenta_corriente',
    items: [{ productoId: avena.id, cantidad: 4, precioLista: 1800, iva: 21 }],
  });

  // Cobranza parcial del kiosco: paga una parte de la primera venta.
  await cobr.create({
    clienteId: kiosco.id, sucursalId: dist.id, usuarioId: ana.id,
    observaciones: 'Pago parcial a cuenta del pedido semanal',
    pagos: [{ medio: 'transferencia', importe: 10000, referencia: 'CBU 0070…' }],
    imputaciones: [{ ventaId: v1.id, importe: 10000 }],
  });

  await pool.end();
  // eslint-disable-next-line no-console
  console.log('✓ Datos de ejemplo cargados.');
}
main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('Error en el seed:', e);
  process.exit(1);
});
