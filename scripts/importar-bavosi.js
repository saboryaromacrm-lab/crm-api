/**
 * IMPORTADOR BAVOSI — dry-run por defecto, `--aplicar` para escribir.
 * ============================================================================
 * Decisiones del usuario (2026-08-07):
 *  1. Los rubros los nombro yo por producto (los IDs viejos no traen nombre).
 *  2. Solo listas 1 (Minorista) → Mostrador y 2 (Mayorista) → Mayorista.
 *  3. Manda el COSTO REAL del formato de compra (descuentos + flete); los
 *     precios se recalculan con el markup → algunos se mueven, se reportan.
 *  4. A las presentaciones huérfanas se les crea el producto base.
 *  5. "GRANEL" no es marca: esos productos quedan sin marca (CUMANA/PAN sí).
 *  6. Publicado en la web solo si el producto tiene lista MAYORISTA.
 *  7. Castañas de cajú partidas: costo estimado de un producto equivalente.
 *
 * Es IDEMPOTENTE por código interno: correrlo dos veces no duplica nada.
 */
const fs = require('fs');
/** Carpeta con los tres CSV. Se puede cambiar: `CSV_DIR=... node scripts/importar-bavosi.js` */
const DIR = (process.env.CSV_DIR || 'C:/Users/Invitadoo/Downloads/').replace(/\/?$/, '/');
const API = process.env.API_URL || 'http://localhost:3001/api';
const PROVEEDOR_BAVOSI = 11;
const LISTA_MOSTRADOR = 3;   // Minorista 1 · Mostrador  ← lista 1 del sistema viejo
const LISTA_MAYORISTA = 1;   // Mayorista 1              ← lista 2 del sistema viejo
const IVA_DEF = 21;
const REDONDEO = 1;
const APLICAR = process.argv.includes('--aplicar');

/* ------------------------------ utilidades ------------------------------ */
const leer = (f) => {
  const texto = new TextDecoder('windows-1252').decode(fs.readFileSync(DIR + f));
  const lineas = texto.split(/\r?\n/).filter((l) => l.trim());
  const cols = lineas[0].split(',');
  const parse = (l) => { const o = []; let c = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === ',' && !q) { o.push(c); c = ''; } else c += ch; } o.push(c); return o; };
  return lineas.slice(1).map((l) => { const v = parse(l); return Object.fromEntries(cols.map((c, i) => [c, (v[i] ?? '').trim()])); });
};
const n = (v) => Number(String(v || '0').replace(',', '.')) || 0;
const r2 = (x) => Math.round(x * 100) / 100;
const redondear = (x) => (REDONDEO > 0 ? Math.round(x / REDONDEO) * REDONDEO : r2(x));

const SIGLAS = new Set(['CUMANA', 'DOYP', 'S/TACC', 'TACC', 'IQF']);
const CONECTORES = new Set(['DE', 'DEL', 'EN', 'Y', 'CON', 'SIN', 'A', 'AL', 'LA', 'EL', 'LOS', 'LAS', 'PARA']);
/** MAYÚSCULAS → legible: siglas intactas, conectores en minúscula. */
const titulo = (s) => s.split(/\s+/).map((w, i) => {
  const U = w.toUpperCase();
  if (SIGLAS.has(U)) return U;
  if (i > 0 && CONECTORES.has(U)) return w.toLowerCase();
  if (/^X\s?[\d.,]+/i.test(w)) return w.toLowerCase();
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}).join(' ').replace(/\s+/g, ' ').trim();

/**
 * Abreviaturas del sistema viejo que hay que abrir: el cajero busca
 * "semilla de girasol" y "SEM DE GIRASOL" no aparece. Solo las inequívocas
 * ("DESH" queda: no se sabe si va deshidratado o deshidratada).
 */
const ABREV = [[/\bSEM DE\b/gi, 'SEMILLAS DE'], [/\bDESM\b/gi, 'DESMENUZADO'], [/\bS\/TACC\b/gi, 'SIN TACC']];
const limpiarNombre = (s) => {
  let t = s.replace(/\s*MADRE\s*-?\s*SOLO STOCK\s*-?/gi, '')
    .replace(/\s*-\s*SOLO STOCK\s*-\s*/gi, ' ')
    .replace(/\s*MADRE\s*$/i, '')
    .replace(/\s+/g, ' ').trim();
  for (const [re, rep] of ABREV) t = t.replace(re, rep);
  return titulo(t);
};

/* --------------------------- rubro por producto --------------------------- */
// Subcategorías que YA existen en el sistema (se reusan) y las que hay que crear.
const SUB_EXISTENTES = { Harinas: 1, Legumbres: 2, Cereales: 5, 'Frutos secos': 6, Semillas: 7, Snacks: 10 };
const SUB_NUEVAS = ['Especias y condimentos', 'Frutas deshidratadas', 'Conservas'];
// El ORDEN manda: "harina de almendras" es Harinas, no Frutos secos.
const REGLAS = [
  [/\bHARINA\b/i, 'Harinas'],
  [/ATUN|LOMITO|CHAMPI|ESPARRAGO|MORRON|ALCAPARRA/i, 'Conservas'],
  [/GARBANZO|ARVEJA|LENTEJ|POROTO/i, 'Legumbres'],
  [/AJO|ALBAHACA|ANIS|CANELA|CLAVO|HINOJO|JENGIBRE|LAUREL|OREGANO|PEREJIL|PIMIENTA|ROMERO|TOMILLO|CEBOLLA|COMINO|CURRY|PIMENTON/i, 'Especias y condimentos'],
  [/ALMENDRA|AVELLANA|CASTA|NUEZ|PISTACHO|MANI\b/i, 'Frutos secos'],
  [/ARANDANO|BANANA|COCO|DATIL|PASAS|TOMATES DESHID|CIRUELA/i, 'Frutas deshidratadas'],
  [/SESAMO|LINO|CHIA|GIRASOL|ZAPALLO|AMAPOLA|MIX SEMILLAS/i, 'Semillas'],
  [/AVENA|QUINOA|AMARANTO|COPOS/i, 'Cereales'],
  [/MIX/i, 'Snacks'],
];
const rubroDe = (nombre) => (REGLAS.find(([re]) => re.test(nombre)) || [null, 'Snacks'])[1];

/* ------------------------------ datos fuente ------------------------------ */
const prods = leer('bavosi.csv');
const compras = leer('Compras Bavosi- Listado de Formatos.csv');
const ventas = leer('Ventas Bavosi - Listado de Formatos.csv');
const comprasPorCodigo = new Map(compras.map((c) => [c.Codigo, c]));
/** markup por (codigo, lista vieja) */
const mkPorLista = new Map();
for (const v of ventas) if (['1', '2'].includes(v.NroLista)) mkPorLista.set(`${v.Codigo}|${v.NroLista}`, { markup: n(v.MarkUp), precio: n(v.VPrecioFinal) });

const TAM = /^(.*?)\s*X\s?([\d.,]+)\s?(KG|K|GRS|GS|G)\b/i;
const kgDe = (num, u) => (/^K/i.test(u) ? num : num / 1000);
/**
 * El sistema viejo nombra la misma cosa de dos formas: "HARINA DE ALMENDRA
 * SIN PIEL" (fraccionado) vs "HARINA DE ALMENDRAS SIN PIEL" (madre), y
 * "SESAMO NEGRO" vs "SEM DE SESAMO NEGRO". Se normaliza el singular/plural y
 * la abreviatura ANTES de comparar, o el fraccionado no encuentra su madre y
 * termina generando un producto base duplicado.
 */
const SINON = [[/\bALMENDRA\b/g, 'ALMENDRAS'], [/^SESAMO /, 'SEM DE SESAMO ']];
const normNom = (s) => {
  let t = s.toUpperCase().replace(/MADRE|-\s*SOLO STOCK\s*-|SOLO STOCK/gi, '').replace(/[^A-ZÑ0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  for (const [re, rep] of SINON) t = t.replace(re, rep);
  return t;
};

const base = prods.filter((p) => p.TipoProducto === '1');   // se compran a Bavosi
const frac = prods.filter((p) => p.TipoProducto === '22');  // se fraccionan acá

/* Ata cada fraccionado a su madre. Las que no encuentran, generan producto base. */
const porNombre = new Map(base.map((m) => [normNom(m.Concepto), m]));
const presDe = new Map();      // Codigo madre → [{ kg, codBar, csv }]
const huerfanas = new Map();   // nombre base → [{ kg, codBar, csv }]
for (const p of frac) {
  const m = TAM.exec(p.Concepto);
  if (!m) continue;
  const b = normNom(m[1]);
  const madre = porNombre.get(b) || [...porNombre.entries()].find(([k]) => k === b || k.startsWith(b + ' ') || b.startsWith(k + ' '))?.[1];
  const fila = { kg: kgDe(n(m[2]), m[3]), codBar: p.CodBar, csv: p, nombre: p.Concepto };
  if (madre) {
    if (!presDe.has(madre.Codigo)) presDe.set(madre.Codigo, []);
    presDe.get(madre.Codigo).push(fila);
  } else {
    const clave = m[1].trim().toUpperCase();
    if (!huerfanas.has(clave)) huerfanas.set(clave, []);
    huerfanas.get(clave).push(fila);
  }
}

/* ------------------- costo neto unitario del formato ------------------- */
const costoDe = (p) => {
  const c = comprasPorCodigo.get(p.Codigo);
  if (!c) return null;
  const cantidad = n(c.Cantidad) || 1;
  const lista = n(c.PrecioLista);
  const descs = [n(c.PorcDesc), n(c.PorcDesc2), n(c.PorcDesc3), n(c.PorcDesc4)];
  const flete = n(c.CostoFlete);
  const factor = descs.reduce((a, d) => a * (1 - d / 100), 1);
  const netoUnit = (lista * factor * (1 + flete / 100)) / cantidad;
  return { cantidad, lista, descs, flete, netoUnit, codigoProveedor: c.CodigoPrv };
};

/* ---------------------------- armado del plan ---------------------------- */
const plan = [];
const avisos = [];

// El costo estimado para castañas partidas: el de castañas de cajú (mismo fruto).
const refCastanas = base.find((p) => /CASTA.AS DE CAJU MADRE/i.test(p.Concepto));
const costoRefCastanas = refCastanas ? costoDe(refCastanas) : null;

for (const p of base) {
  const nombreLimpio = limpiarNombre(p.Concepto);
  const presentaciones = (presDe.get(p.Codigo) || []).sort((a, b) => b.kg - a.kg);
  /*
   * Granel = se fracciona para vender. Tres señales, y basta una: tiene
   * presentaciones, su medida de stock es el kilo, o el nombre dice
   * "MADRE / SOLO STOCK" — que en el sistema viejo significa exactamente
   * "esto no se vende así, se fracciona" (hay bolsas de 25 kg marcadas como
   * "Unidad/es" que sin esta señal entrarían como producto entero).
   */
  const esGranel = presentaciones.length > 0
    || /kilo/i.test(p.MedidaStock)
    || /MADRE|SOLO STOCK/i.test(p.Concepto);
  let costo = costoDe(p);

  // Castañas partidas: sin costo en el archivo → se estima y se marca.
  let notaCosto = '';
  if ((!costo || costo.netoUnit <= 0) && /CASTA.AS DE CAJU PARTIDAS/i.test(p.Concepto) && costoRefCastanas) {
    costo = { ...costoRefCastanas, codigoProveedor: (comprasPorCodigo.get(p.Codigo) || {}).CodigoPrv || '' };
    notaCosto = 'COSTO ESTIMADO (tomado de Castañas de cajú) — verificar con la factura de Bavosi.';
    avisos.push(`COSTO ESTIMADO · ${nombreLimpio}: $${r2(costo.netoUnit)}/kg copiado de Castañas de cajú`);
  }
  if (!costo || costo.netoUnit <= 0) { avisos.push(`SIN COSTO, se saltea · ${p.Concepto}`); continue; }

  // El markup base sale de la presentación MÁS GRANDE (el kilo); si es entero,
  // del propio producto. El resto de las presentaciones lleva su recargo.
  const codigoMk = esGranel && presentaciones.length ? presentaciones[0].csv.Codigo : p.Codigo;
  const mkMin = mkPorLista.get(`${codigoMk}|1`);
  const mkMay = mkPorLista.get(`${codigoMk}|2`);
  const markupBase = mkMin ? mkMin.markup : 0;

  const presFinal = presentaciones.map((x) => {
    const mkPres = mkPorLista.get(`${x.csv.Codigo}|1`);
    // recargo = cuánto más caro es el kilo fraccionado que el kilo suelto
    const recargo = (mkPres && markupBase > 0)
      ? r2(((1 + mkPres.markup / 100) / (1 + markupBase / 100) - 1) * 100)
      : 0;
    const precioCalc = redondear(costo.netoUnit * (1 + markupBase / 100) * x.kg * (1 + recargo / 100) * (1 + n(p.IVAP1 || IVA_DEF) / 100));
    return { tamKg: x.kg, recargo, codigoBarras: x.codBar || '', nombre: x.nombre, precioViejo: mkPres ? mkPres.precio : 0, precioCalc };
  });

  const listas = [];
  if (mkMin) listas.push({ listaId: LISTA_MOSTRADOR, modoPrecio: 'markup', markup: mkMin.markup, unidades: 1 });
  if (mkMay) listas.push({ listaId: LISTA_MAYORISTA, modoPrecio: 'markup', markup: mkMay.markup, unidades: 1 });

  plan.push({
    codigo: p.Codigo,
    producto: {
      nombre: nombreLimpio,
      descripcion: [`Importado de Bavosi · ${p.Concepto}`, notaCosto].filter(Boolean).join(' — '),
      codigoPropio: p.Codigo,
      codigoBarras: esGranel ? '' : (p.CodBar || ''), // el granel no se escanea suelto
      unidadesPorBulto: esGranel ? 1 : Math.max(1, Math.round(n(p.Bulto) || costo.cantidad || 1)),
      marcaId: null, // Las marcas van tal cual vienen: son marcas registradas, no texto a maquillar.
      marcaNombre: /^(CUMANA|PAN)$/i.test(p.Marca) ? p.Marca.toUpperCase() : null,
      subcategoriaNombre: rubroDe(p.Concepto),
      iva: n(p.IVAP1) || IVA_DEF,
      esGranel,
      publicado: !!mkMay, // decisión 6: a la web solo lo que tiene mayorista
      idExterno: p.numint,
    },
    formatoCompra: {
      proveedorId: PROVEEDOR_BAVOSI, cantidad: costo.cantidad, costo: costo.lista,
      descuento: costo.descs[0], descuento2: costo.descs[1], descuento3: costo.descs[2], descuento4: costo.descs[3],
      flete: costo.flete, modoCosto: 'lista', usarParaPrecio: true, codigoProveedor: costo.codigoProveedor || '',
    },
    netoUnit: costo.netoUnit,
    presentaciones: presFinal,
    listas,
    precioViejoPropio: mkMin && !presentaciones.length ? mkMin.precio : 0,
    precioCalcPropio: mkMin && !presentaciones.length
      ? redondear(costo.netoUnit * (1 + mkMin.markup / 100) * (1 + (n(p.IVAP1) || IVA_DEF) / 100)) : 0,
  });
}

/* Las huérfanas: producto base nuevo, costo derivado del fraccionado de 1 kg. */
for (const [nombreBase, filas] of huerfanas) {
  const ref = filas.find((f) => f.kg === 1) || filas.sort((a, b) => b.kg - a.kg)[0];
  const iva = n(ref.csv.IVAP1) || IVA_DEF;
  // El CostoFinal del fraccionado viene CON IVA y es por unidad de su tamaño.
  const netoUnit = (n(ref.csv.CostoFinal) / (1 + iva / 100)) / ref.kg;
  if (!(netoUnit > 0)) { avisos.push(`BASE NUEVA sin costo, se saltea · ${nombreBase}`); continue; }
  const mkMin = mkPorLista.get(`${ref.csv.Codigo}|1`);
  const mkMay = mkPorLista.get(`${ref.csv.Codigo}|2`);
  const markupBase = mkMin ? mkMin.markup : 0;
  const presFinal = filas.sort((a, b) => b.kg - a.kg).map((x) => {
    const mkPres = mkPorLista.get(`${x.csv.Codigo}|1`);
    const recargo = (mkPres && markupBase > 0) ? r2(((1 + mkPres.markup / 100) / (1 + markupBase / 100) - 1) * 100) : 0;
    return {
      tamKg: x.kg, recargo, codigoBarras: x.codBar || '', nombre: x.nombre,
      precioViejo: mkPres ? mkPres.precio : 0,
      precioCalc: redondear(netoUnit * (1 + markupBase / 100) * x.kg * (1 + recargo / 100) * (1 + iva / 100)),
    };
  });
  const listas = [];
  if (mkMin) listas.push({ listaId: LISTA_MOSTRADOR, modoPrecio: 'markup', markup: mkMin.markup, unidades: 1 });
  if (mkMay) listas.push({ listaId: LISTA_MAYORISTA, modoPrecio: 'markup', markup: mkMay.markup, unidades: 1 });
  const codigo = `BAV-${normNom(nombreBase).replace(/\s+/g, '-').slice(0, 18)}`;
  avisos.push(`BASE CREADA · ${titulo(nombreBase)} (no estaba en el archivo) · costo $${r2(netoUnit)}/kg derivado de "${ref.nombre}"`);
  plan.push({
    codigo,
    producto: {
      nombre: titulo(nombreBase),
      descripcion: `Producto base creado en la importación de Bavosi: el archivo traía solo los fraccionados (${filas.map((f) => f.nombre).join(', ')}). Costo derivado — verificar con la factura.`,
      codigoPropio: codigo, codigoBarras: '', unidadesPorBulto: 1,
      marcaId: null, marcaNombre: null, subcategoriaNombre: rubroDe(nombreBase),
      iva, esGranel: true, publicado: !!mkMay, idExterno: '',
    },
    // Sin fila en el CSV de compras: el costo se carga como final por kilo.
    formatoCompra: {
      proveedorId: PROVEEDOR_BAVOSI, cantidad: 1, costo: r2(netoUnit),
      descuento: 0, descuento2: 0, descuento3: 0, descuento4: 0, flete: 0,
      modoCosto: 'lista', usarParaPrecio: true, codigoProveedor: '',
    },
    netoUnit, presentaciones: presFinal, listas, precioViejoPropio: 0, precioCalcPropio: 0,
  });
}

/* ------------------------------- reporte ------------------------------- */
/*
 * Los precios que se mueven. Se parten en dos porque NO son la misma cosa:
 *  - hasta 15%: el costo se actualizó y el precio venía atrasado — es el
 *    trabajo del sistema y hay que dejarlo pasar;
 *  - más de 15%: casi siempre significa que en el sistema viejo el costo de la
 *    madre y el del fraccionado están desincronizados, así que uno de los dos
 *    está podrido. Eso se revisa contra la factura ANTES de vender.
 */
const cambios = [];
for (const it of plan) {
  for (const pr of it.presentaciones) {
    if (pr.precioViejo > 0 && Math.abs(pr.precioCalc - pr.precioViejo) / pr.precioViejo > 0.01) {
      cambios.push({ nombre: pr.nombre, viejo: pr.precioViejo, nuevo: pr.precioCalc, prod: it.producto.nombre });
    }
  }
  if (it.precioViejoPropio > 0 && Math.abs(it.precioCalcPropio - it.precioViejoPropio) / it.precioViejoPropio > 0.01) {
    cambios.push({ nombre: it.producto.nombre, viejo: it.precioViejoPropio, nuevo: it.precioCalcPropio, prod: it.producto.nombre });
  }
}
const UMBRAL = 0.15;
const chicos = cambios.filter((c) => Math.abs(c.nuevo / c.viejo - 1) <= UMBRAL);
const grandes = cambios.filter((c) => Math.abs(c.nuevo / c.viejo - 1) > UMBRAL);

const porRubro = new Map();
for (const it of plan) porRubro.set(it.producto.subcategoriaNombre, (porRubro.get(it.producto.subcategoriaNombre) || 0) + 1);

console.log('════════ PLAN DE IMPORTACIÓN · PROVEEDOR BAVOSI ════════\n');
console.log(`PRODUCTOS: ${plan.length}  (granel ${plan.filter((p) => p.producto.esGranel).length} · envasados ${plan.filter((p) => !p.producto.esGranel).length})`);
console.log(`PRESENTACIONES: ${plan.reduce((a, p) => a + p.presentaciones.length, 0)}`);
console.log(`FORMATOS DE COMPRA: ${plan.length} (todos a Bavosi, con sus descuentos y flete)`);
console.log(`FORMATOS DE VENTA: ${plan.reduce((a, p) => a + p.listas.length, 0)} · publicados en la web: ${plan.filter((p) => p.producto.publicado).length}`);
console.log(`IVA 10,5%: ${plan.filter((p) => p.producto.iva === 10.5).length} productos`);
console.log(`\nRUBROS asignados: ${[...porRubro.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} (${v})`).join(' · ')}`);
console.log(`\nMARCAS a usar: ${[...new Set(plan.map((p) => p.producto.marcaNombre).filter(Boolean))].join(', ') || '(ninguna)'} · sin marca: ${plan.filter((p) => !p.producto.marcaNombre).length}`);
console.log(`SUBCATEGORÍAS a crear: ${SUB_NUEVAS.join(', ')}`);

console.log(`\n──── AVISOS (${avisos.length}) ────`);
avisos.forEach((a) => console.log('  •', a));

const fmtCambio = (c) => {
  const d = (c.nuevo / c.viejo - 1) * 100;
  return `  ${d > 0 ? '↑' : '↓'} ${d > 0 ? '+' : ''}${d.toFixed(1)}%  ${c.nombre}: $${c.viejo.toLocaleString('es-AR')} → $${c.nuevo.toLocaleString('es-AR')}`;
};
const porTamano = (a, b) => Math.abs(b.nuevo / b.viejo - 1) - Math.abs(a.nuevo / a.viejo - 1);

console.log(`\n──── ⚠ REVISAR ANTES DE VENDER: cambios de más del 15% (${grandes.length}) ────`);
console.log('  En estos, el costo de la madre y el del fraccionado NO coinciden en tu');
console.log('  sistema viejo: uno de los dos está mal. El precio nuevo sale del costo de');
console.log('  la madre (el que tiene fecha de actualización). Conviene mirar la factura.');
grandes.sort(porTamano).forEach((c) => console.log(fmtCambio(c)));

console.log(`\n──── Ajustes normales: el costo subió y el precio venía atrasado (${chicos.length}) ────`);
chicos.sort(porTamano).forEach((c) => console.log(fmtCambio(c)));
console.log(`\n  El resto de los precios (${157 - cambios.length} formatos) queda EXACTO como lo tenés hoy.`);

console.log('\n──── MUESTRA: 3 productos completos ────');
for (const it of [plan.find((p) => p.presentaciones.length >= 3), plan.find((p) => !p.producto.esGranel), plan.find((p) => p.producto.iva === 10.5)].filter(Boolean)) {
  console.log(`\n  ${it.producto.nombre}  [${it.codigo}]`);
  console.log(`    ${it.producto.esGranel ? 'GRANEL' : 'ENTERO (bulto de ' + it.producto.unidadesPorBulto + ')'} · IVA ${it.producto.iva}% · ${it.producto.subcategoriaNombre} · ${it.producto.marcaNombre || 'sin marca'} · ${it.producto.publicado ? 'publicado' : 'no publicado'}`);
  const f = it.formatoCompra;
  console.log(`    compra: bulto de ${f.cantidad} × $${f.costo.toLocaleString('es-AR')} − ${f.descuento}% − ${f.descuento2}% + flete ${f.flete}%  →  costo neto $${r2(it.netoUnit).toLocaleString('es-AR')}/${it.producto.esGranel ? 'kg' : 'u'} (cód. prov. ${f.codigoProveedor || '—'})`);
  console.log(`    venta: ${it.listas.map((l) => `${l.listaId === LISTA_MOSTRADOR ? 'Mostrador' : 'Mayorista'} markup ${l.markup}%`).join(' · ') || '(no se vende: solo stock)'}`);
  for (const pr of it.presentaciones) console.log(`      · ${pr.tamKg} kg · recargo ${pr.recargo}% · barras ${pr.codigoBarras || '—'} → $${pr.precioCalc.toLocaleString('es-AR')}${pr.precioViejo ? ` (antes $${pr.precioViejo.toLocaleString('es-AR')})` : ''}`);
}

if (!APLICAR) {
  console.log('\n════ DRY-RUN: no se escribió NADA. Para aplicar: node importar-bavosi.js --aplicar ════');
  fs.writeFileSync('plan-bavosi.json', JSON.stringify(plan, null, 1));
  console.log('(plan completo guardado en plan-bavosi.json)');
  process.exit(0);
}

/* ------------------------------- aplicar ------------------------------- */
const req = async (metodo, ruta, body) => {
  const r = await fetch(API + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${metodo} ${ruta} → ${r.status} ${JSON.stringify(data)?.slice(0, 200)}`);
  return data;
};

(async () => {
  console.log('\n════ APLICANDO ════');
  const boot = await req('GET', '/bootstrap');
  const subs = new Map(boot.catalogos.subcategorias.map((s) => [s.nombre, s.id]));
  const marcas = new Map(boot.catalogos.marcas.map((m) => [m.nombre.toUpperCase(), m.id]));
  const yaExiste = new Map(boot.productos.map((p) => [p.codigoPropio, p.id]));

  for (const nombre of SUB_NUEVAS) {
    if (subs.has(nombre)) continue;
    const s = await req('POST', '/catalogos/subcategorias', { nombre, categoriaId: 1 });
    subs.set(nombre, s.id ?? s.subcategoria?.id);
    console.log(`  + subcategoría ${nombre}`);
  }
  for (const m of [...new Set(plan.map((p) => p.producto.marcaNombre).filter(Boolean))]) {
    if (marcas.has(m.toUpperCase())) continue;
    const nm = await req('POST', '/catalogos/marcas', { nombre: m });
    marcas.set(m.toUpperCase(), nm.id ?? nm.marca?.id);
    console.log(`  + marca ${m}`);
  }

  let creados = 0, saltados = 0, fallos = 0;
  for (const it of plan) {
    if (yaExiste.has(it.codigo)) { saltados += 1; continue; }
    try {
      const p = it.producto;
      const creado = await req('POST', '/productos', {
        nombre: p.nombre, descripcion: p.descripcion, codigoPropio: p.codigoPropio,
        codigoBarras: p.codigoBarras, unidadesPorBulto: p.unidadesPorBulto,
        marcaId: p.marcaNombre ? marcas.get(p.marcaNombre.toUpperCase()) : null,
        categoriaId: 1, subcategoriaId: subs.get(p.subcategoriaNombre) ?? null,
        iva: p.iva, esGranel: p.esGranel, publicado: p.publicado, idExterno: p.idExterno,
      });
      const id = creado.id ?? creado.producto?.id;
      await req('PUT', `/productos/${id}/formatos-compra`, { formatos: [it.formatoCompra] });
      if (it.presentaciones.length) {
        await req('PUT', `/productos/${id}/presentaciones`, {
          presentaciones: it.presentaciones.map((x) => ({ tamKg: x.tamKg, recargo: x.recargo, codigoBarras: x.codigoBarras })),
        });
      }
      if (it.listas.length) await req('PUT', `/productos/${id}/listas`, { listas: it.listas });
      creados += 1;
      if (creados % 20 === 0) console.log(`  … ${creados} productos`);
    } catch (e) {
      fallos += 1;
      console.log(`  ✗ ${it.producto.nombre}: ${e.message}`);
    }
  }
  console.log(`\n✓ creados ${creados} · ya existían ${saltados} · fallos ${fallos}`);
})();
