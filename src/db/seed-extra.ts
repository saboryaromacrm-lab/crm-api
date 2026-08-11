/**
 * SEED EXTRA — productos variados para pruebas, SIN borrar nada.
 * ============================================================================
 * Agrega ~20 productos (enteros y a granel con sus presentaciones) sobre la
 * base ACTUAL: busca por nombre lo que ya existe (sucursales, proveedores,
 * listas, etiquetas) y crea solo lo que falta. Se puede correr una única vez:
 * si encuentra el código propio 2001 ya cargado, no hace nada.
 *
 *   npx ts-node -r tsconfig-paths/register src/db/seed-extra.ts
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  categorias, etiquetas, listasVenta, marcas, presentaciones, productoEtiquetas,
  productoListas, productoProveedores, productos, proveedores, schema, subcategorias, sucursales, usuarios,
} from './schema';
import { InventarioService } from '../inventario/inventario.service';
import { ConfiguracionService } from '../configuracion/configuracion.module';
import { ListasService } from '../listas/listas.module';
import { HistorialPreciosService } from '../precios/precios.module';

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool, { schema, casing: 'snake_case' });
  const cfgSvc = new ConfiguracionService(db as any);
  const listasSvc = new ListasService(db as any);
  const inv = new InventarioService(db as any, cfgSvc, listasSvc);
  const evolucion = new HistorialPreciosService(db as any, cfgSvc);

  const [ya] = await db.select().from(productos).where(eq(productos.codigoPropio, '2001')).limit(1);
  if (ya) { console.log('El seed extra ya corrió (código 2001 existe). Nada que hacer.'); await pool.end(); return; }

  /* ---- Lo existente, por nombre ---- */
  const sucs = await db.select().from(sucursales);
  const dist = sucs.find((s) => s.tipo === 'distribuidora')!;
  const ex1 = sucs.find((s) => s.nombre === 'Express 1') ?? sucs.find((s) => s.tipo === 'express')!;

  const provs = await db.select().from(proveedores);
  const provDe = (nombre: string) => provs.find((p) => p.nombre === nombre)!;
  const legum = provDe('Legumbres del Norte');
  const avpampa = provDe('Avena Pampa');
  const galletera = provDe('Galletera Rosario');
  const bebidasSA = provDe('Bebidas SA');
  const yerbatera = provDe('Yerbatera Misiones');
  const [frutosPais] = await db.insert(proveedores).values({ nombre: 'Frutos del País SRL', cuit: '30-71440022-5', telefono: '261-420-7788', direccion: 'Carril Rodríguez Peña 2100, Mendoza' }).returning();
  const [dietCentral] = await db.insert(proveedores).values({ nombre: 'Dietética Central', cuit: '30-70998877-3', telefono: '11-4600-3344', direccion: 'Av. Corrientes 3200, CABA' }).returning();

  const us = await db.select().from(usuarios);
  const ana = us.find((u) => u.nombre.startsWith('Ana')) ?? us[0];
  const bruno = us.find((u) => u.nombre.startsWith('Bruno')) ?? ana;

  const listas = await db.select().from(listasVenta);
  const mostrador = listas.find((l) => l.nombre === 'Mostrador')!;
  const mayorista = listas.find((l) => l.nombre === 'Mayorista')!;
  const oferta = listas.find((l) => l.nombre === 'Oferta')!;

  const ets = await db.select().from(etiquetas);
  const etSinTacc = ets.find((e) => e.nombre === 'SIN TACC')!;
  const etSinAzucar = ets.find((e) => e.nombre === 'SIN AZÚCAR')!;
  const etOrganico = ets.find((e) => e.nombre === 'ORGÁNICO')!;

  /* ---- Marcas y rubros nuevos ---- */
  const cats = await db.select().from(categorias);
  const alimentos = cats.find((c) => c.nombre === 'Alimentos')!;
  const bebidasCat = cats.find((c) => c.nombre === 'Bebidas')!;
  const marcaNueva = async (nombre: string) => (await db.insert(marcas).values({ nombre }).returning())[0];
  const subNueva = async (categoriaId: number, nombre: string) =>
    (await db.insert(subcategorias).values({ categoriaId, nombre }).returning())[0];

  const marcasVieja = await db.select().from(marcas);
  const mNorte = marcasVieja.find((m) => m.nombre === 'Del Norte')!;
  const mPampa = marcasVieja.find((m) => m.nombre === 'Pampa')!;
  const mRosario = marcasVieja.find((m) => m.nombre === 'Rosario')!;
  const mSelva = marcasVieja.find((m) => m.nombre === 'Selva')!;
  const [mCampoVivo, mFrutosPais, mNutriSol, mPuraMiel] = await Promise.all(
    ['Campo Vivo', 'Frutos del País', 'NutriSol', 'Pura Miel'].map(marcaNueva),
  );

  const subs = await db.select().from(subcategorias);
  const subLegumbres = subs.find((s) => s.nombre === 'Legumbres')!;
  const subGalletitas = subs.find((s) => s.nombre === 'Galletitas')!;
  const subCereales = await subNueva(alimentos.id, 'Cereales');
  const subFrutosSecos = await subNueva(alimentos.id, 'Frutos secos');
  const subSemillas = await subNueva(alimentos.id, 'Semillas');
  const subEndulzantes = await subNueva(alimentos.id, 'Endulzantes');
  const subAceites = await subNueva(alimentos.id, 'Aceites');
  const subSnacks = await subNueva(alimentos.id, 'Snacks');
  const subInfusiones = await subNueva(alimentos.id, 'Infusiones');
  const subVegetales = await subNueva(bebidasCat.id, 'Bebidas vegetales');

  /* ---- Los 20 productos ----
   * codigoPropio 2001–2020, códigos de barras 77920000001xx (no chocan con el
   * seed original). Costos por BULTO; `usarParaPrecio` en el único proveedor.
   */
  let nCB = 0;
  const cb = () => `77920000001${String(++nCB).padStart(2, '0')}`;
  const cbPres = () => `77921000001${String(++nCB).padStart(2, '0')}`;

  type Def = {
    nombre: string; tipo: 'granel' | 'entero'; marcaId: number; catId?: number; subId: number;
    iva?: number; etiquetas?: number[];
    compra: { proveedorId: number; cantidad: number; costo: number; descuento?: number; descuento2?: number; flete?: number; codigo: string };
    venta: { mostrador: number; mayorista?: { markup: number; minimas?: number; unidades?: number; codigoBarras?: string }; ofertaMarkup?: number; ofertaFijo?: number };
    presentaciones?: { tamKg: number; markup: number }[];
    stockDist: number; stockEx1?: number;
    fraccionar?: { tamKg: number; cant: number }[];
    bulto?: number;
  };

  const defs: Def[] = [
    /* ---------- A granel ---------- */
    { nombre: 'Arroz Integral', tipo: 'granel', marcaId: mNorte.id, subId: subCereales.id, iva: 10.5, etiquetas: [etSinTacc.id],
      compra: { proveedorId: legum.id, cantidad: 1, costo: 1100, descuento: 5, flete: 3, codigo: 'LN-3301' },
      venta: { mostrador: 60, mayorista: { markup: 28, minimas: 10 } },
      presentaciones: [{ tamKg: 1, markup: 73 }, { tamKg: 0.5, markup: 84 }],
      stockDist: 60, fraccionar: [{ tamKg: 1, cant: 10 }, { tamKg: 0.5, cant: 10 }] },
    { nombre: 'Garbanzos', tipo: 'granel', marcaId: mNorte.id, subId: subLegumbres.id, iva: 10.5, etiquetas: [etSinTacc.id],
      compra: { proveedorId: legum.id, cantidad: 1, costo: 1600, descuento: 8, flete: 4, codigo: 'LN-2205' },
      venta: { mostrador: 55, mayorista: { markup: 25, minimas: 6 } },
      presentaciones: [{ tamKg: 0.5, markup: 74 }, { tamKg: 0.25, markup: 86 }],
      stockDist: 40, fraccionar: [{ tamKg: 0.5, cant: 10 }] },
    { nombre: 'Porotos Negros', tipo: 'granel', marcaId: mNorte.id, subId: subLegumbres.id, iva: 10.5, etiquetas: [etSinTacc.id],
      compra: { proveedorId: legum.id, cantidad: 1, costo: 1500, descuento: 5, flete: 4, codigo: 'LN-2210' },
      venta: { mostrador: 55 },
      presentaciones: [{ tamKg: 0.5, markup: 74 }],
      stockDist: 30 },
    { nombre: 'Quinoa', tipo: 'granel', marcaId: mCampoVivo.id, subId: subCereales.id, iva: 10.5, etiquetas: [etSinTacc.id, etOrganico.id],
      compra: { proveedorId: legum.id, cantidad: 1, costo: 5200, flete: 3, codigo: 'LN-3320' },
      venta: { mostrador: 70 },
      presentaciones: [{ tamKg: 0.5, markup: 87 }, { tamKg: 0.25, markup: 101 }],
      stockDist: 25 },
    { nombre: 'Mix Frutos Secos', tipo: 'granel', marcaId: mFrutosPais.id, subId: subFrutosSecos.id, iva: 21,
      compra: { proveedorId: frutosPais.id, cantidad: 1, costo: 7800, descuento: 5, flete: 2, codigo: 'FP-100' },
      venta: { mostrador: 65, mayorista: { markup: 30, minimas: 5 } },
      presentaciones: [{ tamKg: 0.5, markup: 82 }, { tamKg: 0.25, markup: 91 }],
      stockDist: 20, fraccionar: [{ tamKg: 0.25, cant: 12 }] },
    { nombre: 'Almendras', tipo: 'granel', marcaId: mFrutosPais.id, subId: subFrutosSecos.id, iva: 21,
      compra: { proveedorId: frutosPais.id, cantidad: 1, costo: 12500, descuento: 5, flete: 2, codigo: 'FP-110' },
      venta: { mostrador: 60 },
      presentaciones: [{ tamKg: 0.25, markup: 79 }, { tamKg: 0.1, markup: 95 }],
      stockDist: 15 },
    { nombre: 'Nueces Peladas', tipo: 'granel', marcaId: mFrutosPais.id, subId: subFrutosSecos.id, iva: 21,
      compra: { proveedorId: frutosPais.id, cantidad: 1, costo: 11000, flete: 2, codigo: 'FP-120' },
      venta: { mostrador: 60 },
      presentaciones: [{ tamKg: 0.25, markup: 79 }],
      stockDist: 12 },
    { nombre: 'Semillas de Chía', tipo: 'granel', marcaId: mNutriSol.id, subId: subSemillas.id, iva: 21, etiquetas: [etSinTacc.id, etOrganico.id],
      compra: { proveedorId: frutosPais.id, cantidad: 1, costo: 6000, flete: 3, codigo: 'FP-210' },
      venta: { mostrador: 65 },
      presentaciones: [{ tamKg: 0.25, markup: 82 }, { tamKg: 0.1, markup: 98 }],
      stockDist: 18 },
    { nombre: 'Azúcar Mascabo', tipo: 'granel', marcaId: mCampoVivo.id, subId: subEndulzantes.id, iva: 10.5,
      compra: { proveedorId: dietCentral.id, cantidad: 1, costo: 1900, descuento: 5, flete: 3, codigo: 'DC-501' },
      venta: { mostrador: 55, ofertaMarkup: 15 },
      presentaciones: [{ tamKg: 1, markup: 67 }, { tamKg: 0.5, markup: 77 }],
      stockDist: 50 },
    { nombre: 'Girasol Pelado', tipo: 'granel', marcaId: mNutriSol.id, subId: subSemillas.id, iva: 21, etiquetas: [etSinTacc.id],
      compra: { proveedorId: frutosPais.id, cantidad: 1, costo: 3800, descuento: 5, flete: 3, codigo: 'FP-220' },
      venta: { mostrador: 60 },
      presentaciones: [{ tamKg: 0.25, markup: 76 }],
      stockDist: 22 },

    /* ---------- Enteros ---------- */
    { nombre: 'Miel Pura 500g', tipo: 'entero', marcaId: mPuraMiel.id, subId: subEndulzantes.id, iva: 21, etiquetas: [etOrganico.id],
      compra: { proveedorId: dietCentral.id, cantidad: 1, costo: 3200, descuento: 5, flete: 2, codigo: 'DC-601' },
      venta: { mostrador: 55, ofertaFijo: 4500 },
      stockDist: 30, stockEx1: 8 },
    { nombre: 'Aceite de Oliva 500ml', tipo: 'entero', marcaId: mCampoVivo.id, subId: subAceites.id, iva: 21, bulto: 12,
      compra: { proveedorId: dietCentral.id, cantidad: 12, costo: 54000, descuento: 10, flete: 3, codigo: 'DC-701' },
      venta: { mostrador: 50, mayorista: { markup: 25, minimas: 6 } },
      stockDist: 24 },
    { nombre: 'Tostadas de Arroz', tipo: 'entero', marcaId: mNutriSol.id, subId: subSnacks.id, iva: 21, etiquetas: [etSinTacc.id], bulto: 20,
      compra: { proveedorId: galletera.id, cantidad: 20, costo: 16000, descuento: 10, descuento2: 5, flete: 4, codigo: 'GR-TOS-20' },
      venta: { mostrador: 55 },
      stockDist: 40, stockEx1: 12 },
    { nombre: 'Granola Crocante 400g', tipo: 'entero', marcaId: mPampa.id, subId: subCereales.id, iva: 21, bulto: 10,
      compra: { proveedorId: avpampa.id, cantidad: 10, costo: 21000, descuento: 10, flete: 3, codigo: 'AP-GRA-10' },
      venta: { mostrador: 60 },
      stockDist: 30 },
    { nombre: 'Barrita de Cereal Frutal', tipo: 'entero', marcaId: mPampa.id, subId: subSnacks.id, iva: 21, bulto: 24,
      compra: { proveedorId: avpampa.id, cantidad: 24, costo: 12000, descuento: 15, flete: 3, codigo: 'AP-BAR-24' },
      venta: { mostrador: 70, mayorista: { markup: 25, unidades: 24, codigoBarras: '27792000000158' } },
      stockDist: 72, stockEx1: 24 },
    { nombre: 'Té Verde x20 saquitos', tipo: 'entero', marcaId: mSelva.id, subId: subInfusiones.id, iva: 21, bulto: 12,
      compra: { proveedorId: yerbatera.id, cantidad: 12, costo: 21600, descuento: 10, flete: 2, codigo: 'YM-TV-12' },
      venta: { mostrador: 60 },
      stockDist: 36 },
    { nombre: 'Cacao Amargo 200g', tipo: 'entero', marcaId: mNutriSol.id, subId: subEndulzantes.id, iva: 21, etiquetas: [etSinAzucar.id], bulto: 6,
      compra: { proveedorId: dietCentral.id, cantidad: 6, costo: 15000, descuento: 5, flete: 2, codigo: 'DC-801' },
      venta: { mostrador: 65 },
      stockDist: 18 },
    { nombre: 'Leche de Almendras 1L', tipo: 'entero', marcaId: mNutriSol.id, catId: bebidasCat.id, subId: subVegetales.id, iva: 21, etiquetas: [etSinTacc.id, etSinAzucar.id], bulto: 8,
      compra: { proveedorId: bebidasSA.id, cantidad: 8, costo: 17600, descuento: 10, flete: 4, codigo: 'BEB-LA-8' },
      venta: { mostrador: 55, mayorista: { markup: 28, minimas: 6 } },
      stockDist: 32, stockEx1: 12 },
    { nombre: 'Yerba Compuesta Hierbas 500g', tipo: 'entero', marcaId: mSelva.id, subId: subInfusiones.id, iva: 21, bulto: 10,
      compra: { proveedorId: yerbatera.id, cantidad: 10, costo: 19000, descuento: 10, flete: 2, codigo: 'YM-YC-10' },
      venta: { mostrador: 58 },
      stockDist: 40 },
    { nombre: 'Galletas de Avena 300g', tipo: 'entero', marcaId: mRosario.id, subId: subGalletitas.id, iva: 21, etiquetas: [etSinAzucar.id], bulto: 12,
      compra: { proveedorId: galletera.id, cantidad: 12, costo: 15600, descuento: 20, flete: 5, codigo: 'GR-AVE-12' },
      venta: { mostrador: 55, ofertaFijo: 1800 },
      stockDist: 48, stockEx1: 12 },
  ];

  /* ---- Alta de todo, en el orden real: producto → costos → precios → stock ---- */
  const idsNuevos: number[] = [];
  let nPropio = 2000;

  for (const d of defs) {
    nPropio += 1;
    const [p] = await db.insert(productos).values({
      nombre: d.nombre, tipo: d.tipo, codigoPropio: String(nPropio), codigoBarras: cb(),
      marcaId: d.marcaId, categoriaId: d.catId ?? alimentos.id, subcategoriaId: d.subId,
      iva: d.iva ?? 21, unidadesPorBulto: d.bulto ?? 10,
    }).returning();
    idsNuevos.push(p.id);

    if (d.etiquetas?.length) {
      await db.insert(productoEtiquetas).values(d.etiquetas.map((e) => ({ productoId: p.id, etiquetaId: e })));
    }

    let presRows: any[] = [];
    if (d.presentaciones?.length) {
      presRows = await db.insert(presentaciones).values(
        d.presentaciones.map((pr) => ({ productoId: p.id, tamKg: pr.tamKg, codigoBarras: cbPres() })),
      ).returning();
    }

    await db.insert(productoProveedores).values({
      productoId: p.id, proveedorId: d.compra.proveedorId, cantidad: d.compra.cantidad,
      costo: d.compra.costo, descuento: d.compra.descuento ?? 0, descuento2: d.compra.descuento2 ?? 0,
      flete: d.compra.flete ?? 0, usarParaPrecio: true, codigoProveedor: d.compra.codigo,
    });

    const filasVenta: any[] = [{ productoId: p.id, listaId: mostrador.id, markup: d.venta.mostrador }];
    if (d.venta.mayorista) {
      filasVenta.push({
        productoId: p.id, listaId: mayorista.id, markup: d.venta.mayorista.markup,
        unidadesMinimas: d.venta.mayorista.minimas ?? 0, unidades: d.venta.mayorista.unidades ?? 1,
        codigoBarras: d.venta.mayorista.codigoBarras ?? '',
      });
    }
    if (d.venta.ofertaMarkup != null) filasVenta.push({ productoId: p.id, listaId: oferta.id, markup: d.venta.ofertaMarkup });
    if (d.venta.ofertaFijo != null) filasVenta.push({ productoId: p.id, listaId: oferta.id, modoPrecio: 'precio', precioFijo: d.venta.ofertaFijo });
    /* Cada paquete con SU markup en el mostrador: el paquete se cotiza solo y su
     * margen es más alto que el del kilo suelto (envase y mano de obra). */
    for (const row of presRows) {
      const def = d.presentaciones!.find((pr) => Math.abs(pr.tamKg - row.tamKg) < 1e-6)!;
      filasVenta.push({
        productoId: p.id, presentacionId: row.id, listaId: mostrador.id, markup: def.markup,
      });
    }
    await db.insert(productoListas).values(filasVenta);

    /* Stock por el motor real: valuado, con movimiento y trazable. */
    await inv.opCompra({ productoId: p.id, sucursalId: dist.id, cantidad: d.stockDist, proveedorId: d.compra.proveedorId, usuarioId: ana.id });
    if (d.stockEx1) {
      await inv.opCompra({ productoId: p.id, sucursalId: ex1.id, cantidad: d.stockEx1, proveedorId: d.compra.proveedorId, usuarioId: ana.id });
    }
    if (d.fraccionar?.length && presRows.length) {
      await inv.opFraccionar({
        productoId: p.id, sucursalId: dist.id, usuarioId: bruno.id,
        asignaciones: d.fraccionar.map((f) => ({
          presId: presRows.find((pr) => Math.abs(pr.tamKg - f.tamKg) < 1e-6)!.id, cant: f.cant,
        })),
      });
    }
  }

  /* Snapshot inicial: la evolución de precios arranca con el alta. */
  await evolucion.snapshot(idsNuevos, 'inicial');

  await pool.end();
  console.log(`✓ ${idsNuevos.length} productos nuevos con costos, precios, presentaciones y stock.`);
}

main().catch((e) => {
  console.error('Error en el seed extra:', e);
  process.exit(1);
});
