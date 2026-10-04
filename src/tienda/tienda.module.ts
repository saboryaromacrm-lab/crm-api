/**
 * TIENDA — la cara pública del catálogo (sitio web)
 * ============================================================================
 * Todo lo que el sitio Next.js necesita, en un shape chico y sin datos
 * internos (nada de costos, nada de stock por sucursal, nada de otras
 * listas). El entero lleva un solo precio: el de la lista "tienda" (la que
 * apunta la modalidad configurada como mayorista). El granel se vende por
 * opciones, que pueden salir de cualquier lista de esa misma modalidad (la
 * caja de 5 de Mayorista 2, por ejemplo).
 *
 * MÍNIMO DE COMPRA — como en el sitio real: NO cambia el precio, HABILITA el
 * checkout. Se cumple con CUALQUIERA de los dos caminos:
 *   1. Monto total del carrito ≥ `montoMinimoMayorista`.
 *   2. Cada marca/producto con mínimo propio lo cumple en el carrito.
 *
 * El pedido nace como PRESUPUESTO en estado `enviado` (no hay nadie
 * cotizando en el medio): alguien del local lo confirma y lo arma, tal como
 * ya funciona para los pedidos que llegan por WhatsApp.
 */
import {
  BadRequestException, Body, Controller, Get, Inject, Injectable, Module,
  NotFoundException, Param, ParseIntPipe, Post, Res, UseGuards,
} from '@nestjs/common';
import { RateLimit, TiendaRateLimitGuard } from './rate-limit.guard';
import { Publico } from '../auth/auth.decoradores';
import { MIMES_IMAGEN } from '../common/archivos';
import { telefonoArgentino } from '../common/telefono';
import type { Response } from 'express';
import { and, eq, gte, isNull, ne } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import {
  categorias, subcategorias, clientes, etiquetas, marcas, movimientos, presentaciones, productoEtiquetas, productoListas,
  productoProveedores, productos, stock, sucursales, webEventos, webImagenes,
} from '../db/schema';
import { costoNetoPresentacion, costoPrecioEntry, formatoActivo, formatoDeCosto, precioVentaFila } from '../inventario/pricing';
import { ofertaAlcanza } from '../ventas/ventas.module';
import { ListasModule } from '../listas/listas.module';
import { ListasService } from '../listas/listas.module';
import { ConfiguracionModule, ConfiguracionService } from '../configuracion/configuracion.module';
import { PresupuestosModule } from '../presupuestos/presupuestos.module';
import { PresupuestosService } from '../presupuestos/presupuestos.module';
import { OfertasModule, OfertasService } from '../ofertas/ofertas.module';
import { stockSinControl } from '../inventario/inventario.service';

const money = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
/** Kilos y paquetes a 3 decimales: 0.1 + 0.2 no da 0.3. */
const r3 = (n: number) => Math.round((Number(n) || 0) * 1000) / 1000;
/** «500 g», «1 kg», «2,5 kg»: como se lee en la etiqueta. */
const textoKg = (kg: number) => (kg < 1 ? `${Math.round(kg * 1000)} g` : `${String(r3(kg)).replace('.', ',')} kg`);

/** Últimos N días para considerar un producto "recién reingresado" (stock de nuevo > 0). */
const DIAS_REINGRESO = 14;

/** Renglones máximos de un pedido del sitio. Es el único endpoint público que ESCRIBE. */
const MAX_RENGLONES_PEDIDO = 100;

/**
 * ¿La oferta está vigente ahora, en esta sucursal? Misma regla que el motor
 * del POS (`crm-dashboard/src/modules/ventas/domain/ofertas.js`, `ofertaVigente`):
 * duplicada acá porque son proyectos separados, no porque la regla cambie.
 */
function ofertaVigente(o: any, sucursalId: number | null) {
  if (!o.activa) return false;
  const t = new Date();
  if (o.desde && t < new Date(o.desde)) return false;
  if (o.hasta && t > new Date(o.hasta)) return false;
  if (o.dias && o.dias.length === 7 && o.dias[(t.getDay() + 6) % 7] !== '1') return false;
  if (o.sucursales && sucursalId != null) {
    const ids = String(o.sucursales).split(',').map((x: string) => x.trim()).filter(Boolean);
    if (ids.length && !ids.includes(String(sucursalId))) return false;
  }
  return true;
}

/** Cartel de la promo — mismo texto que `describirOferta` del panel de Ofertas. */
function describirOferta(o: any) {
  switch (o.tipo) {
    case 'porcentaje': return `${o.porcentaje}% OFF`;
    case 'precio_fijo': return 'Precio especial';
    case 'nxm': return `${o.lleva}×${o.paga}`;
    case 'segunda_unidad': return `2ª unidad ${o.porcentaje}% OFF`;
    case 'pack': return `${o.lleva} x $${o.precio}`;
    default: return o.nombre;
  }
}

/** Precio final con la promo aplicada, cuando la mecánica define un único precio por unidad. */
function precioConOferta(o: any, precioFinal: number): number | null {
  if (o.tipo === 'porcentaje') return money(precioFinal * (1 - o.porcentaje / 100));
  if (o.tipo === 'precio_fijo') return money(o.precio);
  return null; // nxm / segunda_unidad / pack: el cartel avisa, el precio unitario no cambia.
}

/** Formas de entrega que el sitio ofrece; cualquier otra cosa cae a retiro. */
const ENTREGAS_TIENDA = ['retiro', 'cadete', 'camioneta'] as const;
type EntregaTienda = (typeof ENTREGAS_TIENDA)[number];

/** Topes de largo de la dirección: el `maxLength` del checkout no protege al POST directo. */
const MAX_CALLE = 120;
const MAX_LOCALIDAD = 80;
const MAX_REFERENCIA = 200;

/**
 * La DIRECCIÓN DE ENTREGA del pedido, saneada, o `null` si es retiro.
 *
 * Es obligatoria con envío (`cadete` / `camioneta`): antes el pedido llegaba
 * sin domicilio y dependía de que el cliente lo escribiera en las notas o de
 * pedírselo después por WhatsApp — el cadete salía sin saber a dónde.
 */
export function direccionDeEntrega(entrega: EntregaTienda, cruda: any): {
  direccion: string; localidad: string; referencia: string;
} | null {
  if (entrega === 'retiro') return null;
  const d = cruda ?? {};
  const direccion = String(d.calle ?? '').trim().slice(0, MAX_CALLE);
  const localidad = String(d.localidad ?? '').trim().slice(0, MAX_LOCALIDAD);
  const referencia = String(d.referencia ?? '').trim().slice(0, MAX_REFERENCIA);
  if (!direccion || !localidad) {
    throw new BadRequestException('Para el envío necesitamos la dirección: calle y número, y el barrio o localidad.');
  }
  return { direccion, localidad, referencia };
}

@Injectable()
export class TiendaService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly listas: ListasService,
    private readonly cfg: ConfiguracionService,
    private readonly presupuestos: PresupuestosService,
    private readonly ofertasSvc: OfertasService,
  ) {}

  /** La sucursal que surte al sitio. Hoy es la Distribuidora (depósito central). */
  private async sucursalTienda() {
    const [dist] = await this.db.select().from(sucursales).where(eq(sucursales.tipo, 'distribuidora')).limit(1);
    if (dist) return dist;
    const [cualquiera] = await this.db.select().from(sucursales).limit(1);
    return cualquiera;
  }

  /** El catálogo PÚBLICO del sitio: sin los datos internos de stock. */
  async catalogo() {
    return (await this.armarCatalogo()).catalogo;
  }

  /**
   * El catálogo y, aparte, el POZO de cada granel (granel suelto utilizable y
   * paquetes armados), que solo usa el pedido para validar el stock entre
   * opciones del mismo producto. El pozo no se publica.
   */
  private async armarCatalogo(): Promise<{
    catalogo: any;
    pozos: Map<number, { sinTope: boolean; granelKg: number; armados: Map<number, number>; unidades?: number }>;
    listaDeOpcion: Map<string, { id: number; nombre: string }>;
  }> {
    const suc = await this.sucursalTienda();
    const desdeReingreso = new Date(Date.now() - DIAS_REINGRESO * 86400000);
    const [prods, provs, filas, petiq, ms, cs, ets, existencias, cat, cfg, ofertasActivas, ingresosRecientes, imgs, web, subs, press] = await Promise.all([
      /* El sitio no publica ARCHIVADOS, tengan precio mayorista o no: el estado
       * corta antes que el criterio de publicación. El discontinuado se sigue
       * ofreciendo mientras tenga stock — el `webStockMin` ya lo saca de la web
       * cuando conviene guardar lo último para el mostrador. */
      this.db.select().from(productos)
        .where(ne(productos.estado, 'archivado')).orderBy(productos.nombre),
      this.db.select().from(productoProveedores),
      this.db.select().from(productoListas),
      this.db.select().from(productoEtiquetas),
      this.db.select({ id: marcas.id, nombre: marcas.nombre }).from(marcas),
      this.db.select({ id: categorias.id, nombre: categorias.nombre }).from(categorias),
      this.db.select({ id: etiquetas.id, nombre: etiquetas.nombre }).from(etiquetas),
      /* TODO el disponible de la sucursal: el del producto (granel en kg,
       * entero en unidades) y el de cada paquete fraccionado (3/10/2026: el
       * sitio vende los paquetes del granel). */
      suc
        ? this.db.select().from(stock).where(and(eq(stock.sucursalId, suc.id), eq(stock.estado, 'disponible')))
        : Promise.resolve([] as any[]),
      this.listas.catalogo(),
      this.cfg.get('ventas'),
      this.ofertasSvc.activas(),
      suc
        ? this.db.select({ productoId: movimientos.productoId }).from(movimientos)
          .where(and(
            eq(movimientos.sucursalId, suc.id), eq(movimientos.tipo, 'compra'),
            gte(movimientos.fecha, desdeReingreso),
          ))
        : Promise.resolve([] as any[]),
      // Solo los METADATOS de las imágenes: el binario se sirve por su endpoint.
      this.db.select({ tipo: webImagenes.tipo, refId: webImagenes.refId, actualizadoEn: webImagenes.actualizadoEn })
        .from(webImagenes),
      this.cfg.get('web'),
      // Las subcategorías (2/10/2026): el menú de Categorías del sitio las muestra debajo de cada una.
      this.db.select({ id: subcategorias.id, nombre: subcategorias.nombre, categoriaId: subcategorias.categoriaId }).from(subcategorias),
      // Los paquetes fraccionados: el granel se vende por ellos (3/10/2026).
      this.db.select({ id: presentaciones.id, productoId: presentaciones.productoId, tamKg: presentaciones.tamKg }).from(presentaciones),
    ]);

    /** URL de una imagen subida en el módulo Web ('' si no hay). `?v=` rompe el caché al re-subir. */
    const imgMap = new Map(imgs.map((i) => [`${i.tipo}:${i.refId}`, new Date(i.actualizadoEn).getTime()]));
    const urlImagen = (tipo: string, refId: number) => {
      const v = imgMap.get(`${tipo}:${refId}`);
      return v ? `tienda/imagenes/${tipo}/${refId}?v=${v}` : '';
    };

    // Ofertas de vidriera vigentes: solo mecánicas de UN producto (combo/ticket no aplican al catálogo).
    /*
     * `sin listas` es la traducción EXACTA del viejo `!soloPrecioBase` (0065):
     * el sitio publica las que corren en TODAS las listas, que son exactamente
     * las mismas que publicaba antes del cambio. Se dejó igual a propósito
     * (decisión del dueño, 15/8/2026), pero merece una segunda mirada: el
     * precio que muestra el sitio ES el de mostrador, así que una promo acotada
     * a esa lista debería verse acá y hoy no se ve. Está en Pendientes.
     */
    const ofertasWeb = ofertasActivas.filter((o: any) =>
      !String(o.listas ?? '').trim() && o.tipo !== 'combo' && o.tipo !== 'ticket'
      && ofertaVigente(o, suc?.id ?? null));
    const reingresados = new Set(ingresosRecientes.map((m: any) => m.productoId));

    const nombreMarca = new Map(ms.map((m) => [m.id, m.nombre]));
    const nombreCategoria = new Map(cs.map((c) => [c.id, c.nombre]));
    const subcategoriaDe = new Map(subs.map((s) => [s.id, s]));
    const nombreEtiqueta = new Map(ets.map((e) => [e.id, e.nombre]));
    const etiquetasDe = new Map<number, number[]>();
    for (const e of petiq) {
      const arr = etiquetasDe.get(e.productoId);
      if (arr) arr.push(e.etiquetaId); else etiquetasDe.set(e.productoId, [e.etiquetaId]);
    }
    /** Disponible por (producto, paquete); paquete null = el producto (granel en kg, entero en unidades). */
    const stockPorClave = new Map<string, number>();
    for (const s of existencias) {
      const k = `${s.productoId}:${s.presentacionId ?? ''}`;
      stockPorClave.set(k, (stockPorClave.get(k) ?? 0) + s.cantidad);
    }
    const stockDe = (productoId: number, presentacionId: number | null) => stockPorClave.get(`${productoId}:${presentacionId ?? ''}`) ?? 0;
    const presPorProducto = new Map<number, any[]>();
    for (const pr of press) {
      const arr = presPorProducto.get(pr.productoId);
      if (arr) arr.push(pr); else presPorProducto.set(pr.productoId, [pr]);
    }

    const activas = (cat.listas ?? []).filter((l: any) => l.activa);
    /*
     * LA TIENDA ES LA MODALIDAD MAYORISTA, CON TODAS SUS LISTAS (3/10/2026,
     * pedido del dueño: «tiene que mostrar sí o sí la llamada Mayorista, y
     * dentro de esa las que tienen creadas»). La modalidad es la configurada
     * para el mínimo por monto o, si no hay, la que se llama «Mayorista». La
     * «lista de la tienda» es la primera de esa modalidad por orden; ya no
     * decide qué se publica (eso lo deciden todas las listas de la modalidad),
     * solo cuál gana cuando dos venden igual.
     */
    const modalidades = (cat.modalidades ?? []).filter((m: any) => m.activa !== false);
    const conListas = (m: any) => !!m && activas.some((l: any) => l.modalidadId === m.id);
    const modalidadTienda = [modalidades.find((m: any) => m.id === cfg.modalidadMontoId), modalidades.find((m: any) => /mayorista/i.test(String(m.nombre)))]
      .find(conListas) ?? null;
    const listaTienda = (modalidadTienda ? activas.find((l: any) => l.modalidadId === modalidadTienda.id) : null)
      ?? activas.find((l: any) => l.id === cfg.listaBaseId)
      ?? activas[0] ?? null;

    /**
     * Contenido editable del sitio (módulo Web): slides de la portada, logo,
     * favicon y los datos de contacto/redes del footer.
     */
    const sitio = {
      slides: (web.slides ?? []).map((sl: any) => ({ ...sl, bannerUrl: urlImagen('banner', sl.id) })),
      logoUrl: urlImagen('logo', 1),
      faviconUrl: urlImagen('favicon', 1),
      contacto: {
        whatsapp: String(web.whatsapp ?? ''),
        telefono: String(web.contactoTelefono ?? ''),
        email: String(web.contactoEmail ?? ''),
        ubicacion: String(web.contactoUbicacion ?? ''),
        instagram: String(web.redInstagram ?? ''),
        facebook: String(web.redFacebook ?? ''),
      },
      /** El cartel de bienvenida (3/10/2026): editable en Web › Configuración del sitio. */
      popup: {
        activo: web.popupActivo !== false,
        etiqueta: String(web.popupEtiqueta ?? ''),
        titulo: String(web.popupTitulo ?? ''),
        texto: String(web.popupTexto ?? ''),
      },
    };

    const vacio = {
      sucursalId: suc?.id ?? null, listaId: null, listaNombre: '', montoMinimo: 0,
      montoMinimoCamioneta: Number(cfg.montoMinimoCamioneta) > 0 ? Number(cfg.montoMinimoCamioneta) : 0,
      envioCamionetaActivo: cfg.envioCamionetaActivo !== false,
      presupuestoValidezDias: Number(cfg.presupuestoValidezDias) || 7,
      categorias: [], marcas: [], etiquetas: [], reglasMarca: [], items: [],
      sitio,
    };
    if (!listaTienda) return { catalogo: vacio, pozos: new Map(), listaDeOpcion: new Map() };

    /*
     * PRE-ÍNDICE de las tablas hijas, un solo pase cada una. Sin esto, adentro
     * del loop de productos había un `filas.find` sobre `productoListas` entera
     * y un `provs.filter` sobre `productoProveedores` entera POR CADA producto:
     * O(productos × filas). En un endpoint público que además corre en cada
     * pedido, con el catálogo grande son millones de comparaciones. El `.has`
     * conserva el "primer match" que hacía `.find` (hay una sola fila por
     * producto en la lista de la tienda, pero por las dudas).
     */
    /*
     * EL GRANEL (y desde el 3/10 también el entero) MIRA TODAS LAS LISTAS DE LA MODALIDAD DE LA TIENDA (3/10/2026,
     * pedido del dueño): un paquete puede venderse «por 1» en Mayorista 1 y
     * «caja de 5» en Mayorista 2, y el sitio ofrece las dos formas. Primero la
     * lista de la tienda y después las otras por su orden: ante dos filas que
     * venden IGUAL (mismas unidades) gana la primera, así una lista «por 1»
     * más barata —la de un cliente con contrato— no se publica para todos.
     */
    const listasGranel = activas
      .filter((l: any) => l.modalidadId === listaTienda.modalidadId)
      .sort((a: any, b: any) => (a.id === listaTienda.id ? -1 : b.id === listaTienda.id ? 1 : 0)
        || (a.orden ?? 0) - (b.orden ?? 0) || (a.numero ?? 0) - (b.numero ?? 0) || a.id - b.id);
    const rangoLista = new Map<number, number>(listasGranel.map((l: any, i: number): [number, number] => [l.id, i]));
    /*
     * EL PRECIO MINORISTA, PARA DECIR CUÁNTO SE AHORRA (3/10/2026, pedido del
     * dueño): la lista base de la caja —el precio de mostrador—, la misma regla
     * que el catálogo del POS. Solo si es de otra modalidad que la tienda (si la
     * base fuera la mayorista, no hay contra qué comparar).
     */
    const listaMinorista = activas.find((l: any) => l.id === cfg.listaBaseId) ?? activas[0] ?? null;
    const comparaMinorista = !!listaMinorista && listaMinorista.modalidadId !== listaTienda.modalidadId;
    const filaMinoristaProducto = new Map<number, any>();
    const filaMinoristaPres = new Map<number, any>();
    if (comparaMinorista) {
      for (const f of filas) {
        if (f.listaId !== listaMinorista.id) continue;
        if (f.presentacionId == null) filaMinoristaProducto.set(f.productoId, f);
        else filaMinoristaPres.set(f.presentacionId, f);
      }
    }
    type FilaLista = { fila: any; lista: { id: number; nombre: string } };
    const filasGranelProducto = new Map<number, FilaLista[]>();
    /** Las filas de cada PAQUETE (3/10/2026): el granel se vende por ellos. */
    const filasGranelPres = new Map<number, FilaLista[]>();
    for (const f of filas) {
      if (!rangoLista.has(f.listaId)) continue;
      const l = listasGranel[rangoLista.get(f.listaId)!];
      const x = { fila: f, lista: { id: l.id, nombre: l.nombre } };
      const mapa = f.presentacionId == null ? filasGranelProducto : filasGranelPres;
      const k = f.presentacionId == null ? f.productoId : f.presentacionId;
      const arr = mapa.get(k);
      if (arr) arr.push(x); else mapa.set(k, [x]);
    }
    for (const arr of [...filasGranelProducto.values(), ...filasGranelPres.values()]) {
      arr.sort((a, b) => rangoLista.get(a.lista.id)! - rangoLista.get(b.lista.id)!);
    }
    const provsPorProducto = new Map<number, any[]>();
    for (const x of provs) {
      const arr = provsPorProducto.get(x.productoId);
      if (arr) arr.push(x); else provsPorProducto.set(x.productoId, [x]);
    }

    const items: any[] = [];
    /**
     * EL POZO DE CADA GRANEL (uso interno del pedido, no viaja al sitio): el
     * granel suelto que el sitio puede usar y los paquetes ya armados de cada
     * tamaño. El pedido lo usa para que dos opciones del mismo producto (la
     * bolsa y los paquetes) no se vendan dos veces los mismos kilos.
     */
    const pozos = new Map<number, { sinTope: boolean; granelKg: number; armados: Map<number, number>; unidades?: number }>();
    /** De qué lista sale cada opción de granel (`productoId:clave`): el pedido la anota en el renglón. No se publica. */
    const listaDeOpcion = new Map<string, { id: number; nombre: string }>();
    for (const p of prods) {
      // La BASE del precio (0072): el sitio publica el mismo precio que el POS.
      const costoNeto = costoPrecioEntry(formatoDeCosto(p, provsPorProducto.get(p.id) ?? []) as any, p.iva);
      const opts = { iva: p.iva, redondeo: p.redondeo ?? cfg.redondeoPrecio };
      /*
       * Sin control de stock (el propio del producto, 0129, o la llave de su
       * tipo): se ofrece siempre y sin tope (`disponible: null`), como en la caja.
       */
      const sinTope = stockSinControl(cfg, p);
      const etiquetasIds = etiquetasDe.get(p.id) ?? [];
      /**
       * Una promo por opción: la de mayor beneficio entre las que alcanzan, con
       * la MISMA regla de alcance que la caja (`ofertaAlcanza`): a un paquete
       * lo alcanza una oferta de ESE paquete, y las de su producto, marca,
       * categoría o etiqueta solo si la oferta incluye los fraccionados.
       * `precioUnidad` es el precio de UNA unidad del producto (el kilo de la
       * bolsa, un paquete) y `por` cuántas lleva la opción: el precio con la
       * promo es el de la unidad × `por`, igual que lo cobraría la caja.
       */
      const ofertaDe = (presentacionId: number | null, precioUnidad: number, por: number) => {
        const r = { productoId: p.id, presentacionId, marcaId: p.marcaId, categoriaId: p.categoriaId, etiquetas: etiquetasIds };
        let mejor: any = null;
        let mejorPrecio: number | null = null;
        for (const o of ofertasWeb) {
          if (!ofertaAlcanza(o, r)) continue;
          const pOferta = precioConOferta(o, precioUnidad);
          if (pOferta != null && (mejorPrecio == null || pOferta < mejorPrecio)) {
            mejor = o; mejorPrecio = pOferta;
          } else if (pOferta == null && !mejor) {
            mejor = o; // nxm / segunda_unidad / pack: sin precio unitario, pero se avisa igual.
          }
        }
        return mejor
          ? { id: mejor.id, nombre: mejor.nombre, tipo: mejor.tipo, badge: describirOferta(mejor), precioOferta: mejorPrecio != null ? money(mejorPrecio * por) : null }
          : null;
      };
      const base = {
        id: p.id,
        nombre: p.nombre,
        marcaId: p.marcaId,
        marca: p.marcaId ? (nombreMarca.get(p.marcaId) ?? '') : '',
        categoriaId: p.categoriaId,
        categoria: p.categoriaId ? (nombreCategoria.get(p.categoriaId) ?? '') : '',
        /* La subcategoría SOLO si cuelga de la categoría del producto: una que
         * quedó de otra categoría (se cambió la categoría y no la sub) armaría
         * en el menú una rama que no lleva a ningún lado. */
        ...((): { subcategoriaId: number | null; subcategoria: string } => {
          const sc = p.subcategoriaId ? subcategoriaDe.get(p.subcategoriaId) : undefined;
          return sc && sc.categoriaId === p.categoriaId ? { subcategoriaId: sc.id, subcategoria: sc.nombre } : { subcategoriaId: null, subcategoria: '' };
        })(),
        etiquetas: etiquetasIds
          .map((id) => ({ id, nombre: nombreEtiqueta.get(id) ?? '' }))
          .filter((e) => e.nombre),
        tipo: p.tipo,
        iva: p.iva,
        // La imagen subida en el módulo Web manda; la URL externa es el plan B.
        imagenUrl: urlImagen('producto', p.id) || p.imagenUrl || '',
        destacado: !!p.destacado,
      };

      if (p.tipo !== 'granel') {
        /*
         * REGLA DE PUBLICACIÓN DEL ENTERO (módulo Web): está en el sitio si
         * tiene precio cargado en ALGUNA lista de la modalidad Mayorista (3/10:
         * antes solo la primera; si cambiaba el orden, desaparecían todos).
         * Cada forma distinta (unidad, caja x12) es una opción; ante dos listas
         * que venden igual gana la primera por orden. Ni flag manual ni
         * fallback a otra modalidad: publicar = cargarle el precio mayorista.
         */
        const formasE: { fila: any; lista: { id: number; nombre: string }; n: number; pv: any }[] = [];
        {
          const vistos = new Set<number>();
          for (const { fila, lista } of filasGranelProducto.get(p.id) ?? []) {
            const n = Math.max(1, Math.round(Number(fila.unidades) || 1));
            if (vistos.has(n)) continue;
            const pvF = precioVentaFila(costoNeto, fila, opts);
            if (!(pvF.finalUnitario > 0)) continue;
            vistos.add(n);
            formasE.push({ fila, lista, n, pv: pvF });
          }
        }
        // Sin precio real no hay publicación: el pedido se recotizaría a $0.
        if (!formasE.length) continue;
        formasE.sort((x, y) => x.n - y.n);
        const filaTienda = formasE[0].fila;
        const pv = formasE[0].pv;
        if (formasE.length > 1 || formasE[0].n > 1) {
          /* Con más de una forma, o una sola de a N: se elige en la tarjeta, como el granel. */
          const dispE = sinTope ? null : Math.max(0, r3(stockDe(p.id, null) - (p.webStockMin || 0)));
          const masCaroE = Math.max(...formasE.map((f) => f.pv.finalFormato / f.n));
          const variantesE = formasE.map((f) => {
            const clave = `e${f.n}`;
            listaDeOpcion.set(`${p.id}:${clave}`, f.lista);
            const disponible = dispE == null ? null : Math.floor(dispE / f.n + 1e-9);
            const cu = money(f.pv.finalFormato / f.n);
            const pct = masCaroE > 0 ? Math.round(100 * (1 - cu / masCaroE)) : 0;
            const forma = f.n > 1 ? `Caja x${f.n}` : 'Por unidad';
            return {
              clave, presentacionId: null, etiqueta: f.n > 1 ? `Caja x${f.n}` : 'Unidad',
              kgPorUnidad: f.n, paquetesPorUnidad: f.n, unidadesStock: f.n,
              grupo: 'e', grupoEtiqueta: formasE.length === 1 ? forma : '', forma,
              precio: f.pv.finalFormato, precioKg: cu, precioPaquete: cu, ahorroPct: pct >= 1 ? pct : 0,
              unidadesMinimas: (Number(f.fila.unidadesMinimas) || 0) > 0 ? Math.ceil(Number(f.fila.unidadesMinimas) / f.n - 1e-9) : 0,
              enStock: sinTope || (disponible ?? 0) >= 1,
              disponible,
              oferta: ofertaDe(null, f.pv.finalUnitario, f.n),
              ahorroMinorista: null,
            };
          });
          pozos.set(p.id, { sinTope, granelKg: 0, armados: new Map(), unidades: dispE ?? 0 });
          const v0e = variantesE.find((v) => v.enStock) ?? variantesE[0];
          const enStockE = variantesE.some((v) => v.enStock);
          items.push({
            ...base,
            unidad: 'u',
            precio: v0e.precio,
            unidadesMinimas: v0e.unidadesMinimas,
            enStock: enStockE,
            disponible: v0e.disponible,
            oferta: v0e.oferta,
            reingreso: enStockE && reingresados.has(p.id),
            variantes: variantesE,
          });
          continue;
        }
        listaDeOpcion.set(`${p.id}:`, formasE[0].lista);
        /* Lo que el sitio PUEDE vender: el disponible menos el piso reservado
         * para el mostrador (`webStockMin`). Es el tope del carrito. */
        const disponibleParaWeb = sinTope ? null : Math.max(0, r3(stockDe(p.id, null) - (p.webStockMin || 0)));
        const disponibleWeb = sinTope || (disponibleParaWeb ?? 0) > 1e-9;
        items.push({
          ...base,
          unidad: 'u',
          precio: pv.finalUnitario,
          /** Mínimo de compra PROPIO del producto (0 = sin mínimo). */
          unidadesMinimas: filaTienda.unidadesMinimas || 0,
          enStock: disponibleWeb,
          disponible: disponibleParaWeb,
          oferta: ofertaDe(null, pv.finalUnitario, 1),
          reingreso: disponibleWeb && reingresados.has(p.id),
        });
        continue;
      }

      /*
       * EL GRANEL SE VENDE POR OPCIONES (3/10/2026, pedido del dueño). Ningún
       * granel se vende suelto: el sitio ofrece, en un selector,
       *   · cada PAQUETE fraccionado que tenga su fila en la lista Mayorista;
       *   · la BOLSA CERRADA del producto madre, si el madre tiene su fila en
       *     la lista Mayorista: «Bolsa de N kg», con N = las unidades de ese
       *     formato, y se compra de a bolsas enteras. No la del que es «solo
       *     para fraccionar» (la caja no lo vende y el pedido no se podría cerrar).
       * Sin ninguna opción con precio, el producto no se publica.
       *
       * STOCK: un paquete está disponible si hay paquetes armados O granel para
       * armarlo (al confirmar el pedido el ERP fracciona lo que falte). La
       * bolsa sale del granel. El piso del mostrador (`webStockMin`) se
       * descuenta del granel.
       */
      const granelKg = Math.max(0, r3(stockDe(p.id, null) - (p.webStockMin || 0)));
      const armados = new Map<number, number>();
      const variantes: any[] = [];
      /*
       * LAS OPCIONES SE AGRUPAN POR TAMAÑO (3/10/2026): el cliente elige
       * primero QUÉ lleva (1 kg, Bolsa de 10 kg) y, si ese tamaño se vende de
       * más de una forma, CÓMO (por unidad o en caja de 5), viendo cuánto le
       * sale cada paquete y cuánto ahorra. `grupo` es el tamaño; `forma`, el
       * texto de la forma de compra; `precioPaquete`, lo que sale cada paquete.
       * Cada bolsa del madre es un tamaño propio.
       */
      if (!p.soloFraccionar) {
        const vistos = new Set<number>();
        for (const { fila, lista } of filasGranelProducto.get(p.id) ?? []) {
          const kgBolsa = r3(Number(fila.unidades) || 1);
          if (!(kgBolsa > 0) || vistos.has(kgBolsa)) continue;
          const pv = precioVentaFila(costoNeto, fila, opts);
          if (!(pv.finalUnitario > 0)) continue;
          vistos.add(kgBolsa);
          const disponible = sinTope ? null : Math.floor(granelKg / kgBolsa + 1e-9);
          const etiqueta = `Bolsa de ${textoKg(kgBolsa)}`;
          const clave = `p${kgBolsa}`;
          listaDeOpcion.set(`${p.id}:${clave}`, lista);
          variantes.push({
            clave, presentacionId: null, etiqueta, kgPorUnidad: kgBolsa,
            grupo: clave, grupoEtiqueta: etiqueta, forma: 'Bolsa cerrada',
            /** Lo que se cobra por bolsa, y el kilo de referencia. */
            precio: pv.finalFormato, precioKg: pv.finalUnitario, precioPaquete: pv.finalFormato, ahorroPct: 0,
            /** El mínimo del formato viene en kilos: en bolsas, redondeado para arriba. */
            unidadesMinimas: (Number(fila.unidadesMinimas) || 0) > 0 ? Math.ceil(Number(fila.unidadesMinimas) / kgBolsa - 1e-9) : 0,
            enStock: sinTope || (disponible ?? 0) >= 1,
            disponible,
            oferta: ofertaDe(null, pv.finalUnitario, kgBolsa),
          });
        }
      }
      for (const pres of presPorProducto.get(p.id) ?? []) {
        if (!(pres.tamKg > 0)) continue;
        const hay = Math.max(0, stockDe(p.id, pres.id));
        const paquetes = hay + Math.floor(granelKg / pres.tamKg + 1e-9);
        const tam = textoKg(pres.tamKg);
        const delTamano: any[] = [];
        const vistos = new Set<number>();
        for (const { fila, lista } of filasGranelPres.get(pres.id) ?? []) {
          const porCaja = Math.max(1, Math.round(Number(fila.unidades) || 1));
          if (vistos.has(porCaja)) continue;
          const pv = precioVentaFila(costoNetoPresentacion(costoNeto, pres.tamKg, p.merma), fila, opts);
          if (!(pv.finalUnitario > 0)) continue;
          vistos.add(porCaja);
          const disponible = sinTope ? null : Math.floor(paquetes / porCaja + 1e-9);
          const clave = porCaja > 1 ? `s${pres.id}x${porCaja}` : `s${pres.id}`;
          /* «Por N» se ofrece como BOLSA con el total de kilos (pedido del dueño, 3/10/2026):
           * «Bolsa x5 kg»; el renglón del pedido aclara qué paquetes lleva adentro. */
          const bolsaN = `Bolsa x${textoKg(r3(pres.tamKg * porCaja))}`;
          listaDeOpcion.set(`${p.id}:${clave}`, lista);
          delTamano.push({
            clave, presentacionId: pres.id, etiqueta: porCaja > 1 ? `${bolsaN} (${porCaja} × ${tam})` : tam,
            kgPorUnidad: r3(pres.tamKg * porCaja), paquetesPorUnidad: porCaja,
            grupo: `s${pres.id}`, grupoEtiqueta: tam, forma: porCaja > 1 ? bolsaN : 'Por unidad',
            precio: pv.finalFormato, precioKg: money(pv.finalFormato / (pres.tamKg * porCaja)),
            precioPaquete: money(pv.finalFormato / porCaja),
            unidadesMinimas: (Number(fila.unidadesMinimas) || 0) > 0 ? Math.ceil(Number(fila.unidadesMinimas) / porCaja - 1e-9) : 0,
            enStock: sinTope || (disponible ?? 0) >= 1,
            disponible,
            oferta: ofertaDe(pres.id, pv.finalUnitario, porCaja),
          });
        }
        if (!delTamano.length) continue;
        /* Un tamaño que se vende de UNA sola forma y de a N (la Avena 1 kg «vende
         * por 5»): el botón dice lo que se compra —«Bolsa x5 kg»—, no el tamaño
         * del paquete, que haría creer que se lleva 1 kg (3/10/2026, pedido del dueño). */
        if (delTamano.length === 1 && (delTamano[0].paquetesPorUnidad || 1) > 1) delTamano[0].grupoEtiqueta = delTamano[0].forma;
        armados.set(pres.id, hay);
        /* El ahorro de cada forma contra la más cara del mismo tamaño, por paquete y sin promos. */
        const masCaro = Math.max(...delTamano.map((v) => v.precioPaquete));
        for (const v of delTamano) {
          const pct = masCaro > 0 ? Math.round(100 * (1 - v.precioPaquete / masCaro)) : 0;
          v.ahorroPct = pct >= 1 ? pct : 0;
        }
        variantes.push(...delTamano);
      }
      if (!variantes.length) continue;
      /*
       * CUÁNTO SE AHORRA FRENTE AL MINORISTA: el kilo MÁS BARATO al que se
       * puede comprar al por menor este producto (el madre o cualquiera de sus
       * paquetes en la lista minorista) contra el kilo de cada opción, con la
       * promo si tiene. El más barato a propósito: el ahorro que se anuncia
       * nunca está inflado.
       */
      let kgMinorista = Infinity;
      if (comparaMinorista) {
        const fm = filaMinoristaProducto.get(p.id);
        if (fm) {
          const pv = precioVentaFila(costoNeto, fm, opts);
          if (pv.finalUnitario > 0) kgMinorista = Math.min(kgMinorista, pv.finalUnitario);
        }
        for (const pres of presPorProducto.get(p.id) ?? []) {
          const fp = filaMinoristaPres.get(pres.id);
          if (!fp || !(pres.tamKg > 0)) continue;
          const pv = precioVentaFila(costoNetoPresentacion(costoNeto, pres.tamKg, p.merma), fp, opts);
          if (pv.finalUnitario > 0) kgMinorista = Math.min(kgMinorista, pv.finalUnitario / pres.tamKg);
        }
      }
      for (const v of variantes) {
        const kg = (v.oferta?.precioOferta ?? v.precio) / v.kgPorUnidad;
        v.ahorroMinorista = Number.isFinite(kgMinorista) && kgMinorista > kg * 1.005
          ? { pct: Math.round(100 * (1 - kg / kgMinorista)), precioKg: money(kgMinorista), pesos: money((kgMinorista - kg) * v.kgPorUnidad) }
          : null;
      }
      /* Por tamaño (el kilo de su forma más chica) y, adentro, de la forma más chica a la caja más grande. */
      const kgGrupo = new Map<string, number>();
      for (const v of variantes) {
        const kg = v.kgPorUnidad / (v.paquetesPorUnidad || 1);
        kgGrupo.set(v.grupo, Math.min(kgGrupo.get(v.grupo) ?? Infinity, kg));
      }
      variantes.sort((a, b) => kgGrupo.get(a.grupo)! - kgGrupo.get(b.grupo)! || a.grupo.localeCompare(b.grupo)
        || (a.paquetesPorUnidad || 1) - (b.paquetesPorUnidad || 1));
      pozos.set(p.id, { sinTope, granelKg, armados });
      // Lo de la tarjeta, por defecto: la primera opción CON stock (o la primera).
      const v0 = variantes.find((v) => v.enStock) ?? variantes[0];
      const enStock = variantes.some((v) => v.enStock);
      items.push({
        ...base,
        unidad: 'u',
        precio: v0.precio,
        unidadesMinimas: v0.unidadesMinimas,
        enStock,
        disponible: v0.disponible,
        oferta: v0.oferta,
        reingreso: enStock && reingresados.has(p.id),
        /** Las opciones del selector (3/10/2026): bolsa del madre y paquetes con lista mayorista. */
        variantes,
      });
    }

    const contar = (mapa: Map<number, { id: number; nombre: string; count: number }>, id: number | null, nombre: string) => {
      if (!id || !nombre) return;
      const e = mapa.get(id) ?? { id, nombre, count: 0 };
      e.count += 1;
      mapa.set(id, e);
    };
    const catMap = new Map<number, any>(); const marcaMap = new Map<number, any>(); const etiqMap = new Map<number, any>();
    const subMap = new Map<number, any>();
    for (const it of items) {
      contar(catMap, it.categoriaId, it.categoria);
      contar(subMap, it.subcategoriaId, it.subcategoria);
      contar(marcaMap, it.marcaId, it.marca);
      for (const e of it.etiquetas) contar(etiqMap, e.id, e.nombre);
    }
    const porNombre = (a: any, b: any) => a.nombre.localeCompare(b.nombre, 'es');

    const publico = {
      sucursalId: suc?.id ?? null,
      listaId: listaTienda.id,
      listaNombre: listaTienda.nombre,
      /** 0 = sin mínimo por monto configurado (solo rigen los de marca/producto, si hay). */
      montoMinimo: Number(cfg.montoMinimoMayorista) > 0 ? Number(cfg.montoMinimoMayorista) : 0,
      /** Piso EXTRA si la entrega es el envío sin costo (la camioneta; 0 = sin piso). */
      montoMinimoCamioneta: Number(cfg.montoMinimoCamioneta) > 0 ? Number(cfg.montoMinimoCamioneta) : 0,
      /** El envío sin costo se ofrece (Ventas › Configuración › Tienda online). */
      envioCamionetaActivo: cfg.envioCamionetaActivo !== false,
      presupuestoValidezDias: Number(cfg.presupuestoValidezDias) || 7,
      categorias: [...catMap.values()].sort(porNombre)
        .map((c) => ({ ...c, imagenUrl: urlImagen('categoria', c.id) })),
      /** Las subcategorías con productos publicados, con su categoría: el menú las cuelga debajo de cada una. */
      subcategorias: [...subMap.values()].sort(porNombre)
        .map((s) => ({ ...s, categoriaId: subcategoriaDe.get(s.id)?.categoriaId ?? null })),
      marcas: [...marcaMap.values()].sort(porNombre)
        .map((m) => ({ ...m, imagenUrl: urlImagen('marca', m.id) })),
      etiquetas: [...etiqMap.values()].sort(porNombre),
      reglasMarca: (cat.reglasMarca ?? [])
        .filter((r: any) => r.activa && r.unidadesMinimas > 0)
        .map((r: any) => ({ marcaId: r.marcaId, marca: r.marca, unidadesMinimas: r.unidadesMinimas })),
      items,
      sitio,
    };
    return { catalogo: publico, pozos, listaDeOpcion };
  }

  /**
   * Telemetría del sitio, en LOTE (el navegador junta y manda con sendBeacon).
   * Anónima y a prueba de abuso básico: tipos cerrados, strings recortados,
   * tope de eventos por request. Nunca rompe la navegación del cliente: si
   * algo viene mal, se descarta en silencio.
   */
  async eventos(dto: any) {
    // 'busqueda': el término va en `ruta` — qué busca la gente (y no encuentra)
    // es la lista de compras del catálogo.
    const TIPOS = new Set(['vista_pagina', 'vista_producto', 'agregar_carrito', 'busqueda']);
    const sesion = String(dto?.sesion ?? '').slice(0, 64);
    const filas = (Array.isArray(dto?.eventos) ? dto.eventos : [])
      .slice(0, 200)
      .filter((e: any) => TIPOS.has(e?.tipo))
      .map((e: any) => ({
        sesion,
        tipo: String(e.tipo),
        ruta: String(e.ruta ?? '').slice(0, 200),
        productoId: Number(e.productoId) > 0 ? Number(e.productoId) : null,
        // Tope de 10 minutos por evento: una pestaña olvidada no es interés.
        segundos: Math.min(Math.max(Number(e.segundos) || 0, 0), 600),
      }));
    if (filas.length) await this.db.insert(webEventos).values(filas);
    return { ok: true, n: filas.length };
  }

  /** Imagen subida en el módulo Web ('producto' | 'categoria' | 'marca' | 'banner'). */
  async imagen(tipo: string, refId: number) {
    if (!['producto', 'categoria', 'marca', 'banner', 'logo', 'favicon'].includes(tipo)) return null;
    const [img] = await this.db.select().from(webImagenes)
      .where(and(eq(webImagenes.tipo, tipo as any), eq(webImagenes.refId, refId))).limit(1);
    return img ?? null;
  }

  /**
   * Alta de un pedido del sitio. Recotiza TODO server-side (nunca confía en lo
   * que mandó el navegador), valida el mínimo de compra y crea el presupuesto.
   */
  async pedido(dto: any) {
    const carritoIn: any[] = Array.isArray(dto?.items) ? dto.items : [];
    if (!carritoIn.length) throw new BadRequestException('El carrito está vacío.');

    const c = dto?.cliente ?? {};
    const nombreCompleto = `${c.nombre ?? ''} ${c.apellido ?? ''}`.trim();
    if (!nombreCompleto) throw new BadRequestException('Ingresá tu nombre y apellido.');
    const telefono = String(c.telefono ?? '').trim();
    if (!telefono) throw new BadRequestException('Ingresá tu WhatsApp.');
    // El WhatsApp es el único canal de vuelta: sin un número completo el
    // pedido queda huérfano. Área + abonado = 10 dígitos (sin 0 ni 15).
    if (!telefonoArgentino(telefono)) {
      throw new BadRequestException('El WhatsApp está incompleto: escribilo con el código de área, sin 0 ni 15 — 10 dígitos en total (ej: 370 4123456).');
    }
    const dni = String(c.dni ?? '').replace(/\D/g, '');
    if (dni.length < 7 || dni.length > 8) throw new BadRequestException('El DNI debe tener entre 7 y 8 dígitos (es solo para identificarte, no es de facturación).');

    const entrega: EntregaTienda = ENTREGAS_TIENDA.includes(dto?.entrega) ? dto.entrega : 'retiro';
    // Se valida ANTES de cotizar: si falta la dirección no hay para qué tocar el catálogo.
    const domicilio = direccionDeEntrega(entrega, dto?.direccion);

    /*
     * El techo va ANTES de tocar la base: el body admite 4 MB, y con
     * `{"productoId":1,"cantidad":1}` repetido eso son ~110.000 renglones
     * válidos en un solo INSERT. Un carrito de verdad no tiene 100 productos
     * distintos.
     */
    if (carritoIn.length > MAX_RENGLONES_PEDIDO) {
      throw new BadRequestException(`Un pedido no puede tener más de ${MAX_RENGLONES_PEDIDO} renglones.`);
    }

    const { catalogo: cat, pozos, listaDeOpcion } = await this.armarCatalogo();
    const porId = new Map<number, any>(cat.items.map((i: any): [number, any] => [i.id, i]));

    /*
     * Se AGRUPA por producto Y OPCIÓN: el mismo artículo repetido en dos
     * renglones es un solo renglón con la suma. Sin esto, el tope de stock de
     * más abajo se esquiva partiendo el pedido en pedacitos que por separado
     * entran.
     *
     * UN GRANEL SE PIDE POR OPCIÓN (3/10/2026): `variante` dice cuál —la bolsa
     * del madre o un paquete—. Un renglón de granel sin opción válida es un
     * carrito viejo (de cuando el granel se pedía en kilos): se rechaza con el
     * nombre, para no interpretar kilos como bolsas.
     *
     * `Number.isFinite` y no `|| 0`: `Number('1e999')` es Infinity, es truthy,
     * pasa `cantidad > 0` y Postgres lo GUARDA en `double precision`.
     */
    type Renglon = { prod: any; v: any | null; cantidad: number };
    const porClave = new Map<string, Renglon>();
    const viejos: string[] = [];
    for (const linea of carritoIn) {
      const prod = porId.get(Number(linea?.productoId));
      const cantidad = Number(linea?.cantidad);
      if (!prod || !Number.isFinite(cantidad) || cantidad <= 0) continue;
      let v: any = null;
      if (prod.variantes) {
        v = prod.variantes.find((x: any) => x.clave === String(linea?.variante ?? ''));
        if (!v) { viejos.push(prod.nombre); continue; }
      }
      const k = `${prod.id}:${v?.clave ?? ''}`;
      const acc = porClave.get(k);
      if (acc) acc.cantidad += cantidad;
      else porClave.set(k, { prod, v, cantidad });
    }
    if (viejos.length) {
      throw new BadRequestException(
        `Cambió la forma de vender ${[...new Set(viejos)].join(', ')}: ahora se elige cómo llevarlo (unidad, caja, paquete o bolsa). `
        + 'Sacalo del carrito y volvé a agregarlo.',
      );
    }
    const resueltos = [...porClave.values()];
    if (!resueltos.length) throw new BadRequestException('Ningún producto del pedido está disponible.');
    const nombreDe = (r: Renglon) => (r.v ? `${r.prod.nombre} (${r.v.etiqueta})` : r.prod.nombre);
    /** Lo que vale una unidad de compra (la bolsa, el paquete o la caja, o la unidad del entero). */
    const de = (r: Renglon) => r.v ?? r.prod;

    // Bolsas, paquetes y unidades se piden ENTEROS: media bolsa cerrada no existe.
    const fraccionados = resueltos.filter((r) => Math.abs(r.cantidad - Math.round(r.cantidad)) > 1e-9);
    if (fraccionados.length) {
      throw new BadRequestException(`Se piden unidades enteras: ${fraccionados.map(nombreDe).join(', ')}.`);
    }

    /*
     * EL STOCK LO DECIDE EL SERVIDOR. El carrito ya topea la cantidad, pero
     * eso es una comodidad del navegador: acá se vuelve a mirar contra el mismo
     * `disponible` que publica el catálogo. También cubre el caso honesto: el
     * pedido que quedó abierto media hora mientras otro se llevaba lo último.
     */
    const agotados = resueltos.filter((r) => !de(r).enStock);
    if (agotados.length) {
      throw new BadRequestException(`Se quedó sin stock: ${agotados.map(nombreDe).join(', ')}. Sacalo del carrito y volvé a intentar.`);
    }
    const excedidos = resueltos.filter((r) => de(r).disponible != null && r.cantidad > de(r).disponible + 1e-9);
    if (excedidos.length) {
      throw new BadRequestException(
        'No tenemos esa cantidad: '
        + excedidos.map((r) => `${nombreDe(r)} (quedan ${de(r).disponible})`).join(', ')
        + '. Ajustá el carrito y volvé a intentar.',
      );
    }
    /*
     * LAS OPCIONES DE UN GRANEL COMPARTEN EL GRANEL: la bolsa sale del granel y
     * los paquetes que no están armados también. Cada opción por separado ya
     * se topeó; acá se suma lo que el pedido entero le saca al granel.
     */
    const porProducto = new Map<number, Renglon[]>();
    for (const r of resueltos) {
      if (!r.v) continue;
      const arr = porProducto.get(r.prod.id);
      if (arr) arr.push(r); else porProducto.set(r.prod.id, [r]);
    }
    for (const [productoId, rs] of porProducto) {
      const pozo = pozos.get(productoId);
      if (!pozo || pozo.sinTope) continue;
      /* Un ENTERO con opciones (unidad, caja x12): las opciones comparten las unidades. */
      if (rs[0].prod.tipo !== 'granel') {
        const u = rs.reduce((acc, r) => acc + r.cantidad * (r.v.unidadesStock || 1), 0);
        if (u > (pozo.unidades ?? 0) + 1e-9) {
          throw new BadRequestException(
            `No tenemos tanto de ${rs[0].prod.nombre} entre todas las formas que elegiste. Bajá alguna cantidad y volvé a intentar.`,
          );
        }
        continue;
      }
      let kg = 0;
      for (const r of rs) {
        if (r.v.presentacionId == null) { kg += r.cantidad * r.v.kgPorUnidad; continue; }
        const paquetes = r.cantidad * (r.v.paquetesPorUnidad || 1);
        const faltan = Math.max(0, paquetes - (pozo.armados.get(r.v.presentacionId) ?? 0));
        kg += faltan * (r.v.kgPorUnidad / (r.v.paquetesPorUnidad || 1));
      }
      if (r3(kg) > pozo.granelKg + 1e-9) {
        throw new BadRequestException(
          `No tenemos tanto de ${rs[0].prod.nombre} entre todos los tamaños que elegiste. Bajá alguna cantidad y volvé a intentar.`,
        );
      }
    }

    // Precio EFECTIVO: si hay una promo con precio propio (porcentaje / precio_fijo),
    // el pedido se cotiza con ese precio — el cliente vio ese número, se le cobra ese número.
    const precioEfectivo = (r: Renglon) => de(r).oferta?.precioOferta ?? de(r).precio;
    const total = resueltos.reduce((a, r) => a + r.cantidad * precioEfectivo(r), 0);

    // Gate de compra mínima: por MONTO o por CANTIDAD (marca / producto) — no
    // cambia el precio, solo habilita finalizar el pedido (igual que el sitio real).
    // Las cantidades se cuentan en unidades de compra: bolsas, paquetes, cajas o unidades.
    const montoOk = cat.montoMinimo > 0 ? total >= cat.montoMinimo : true;
    const porMarca = new Map<number, number>();
    for (const r of resueltos) {
      if (!r.prod.marcaId) continue;
      /* Un entero en caja cuenta sus UNIDADES (una caja x12 son 12 para la regla de marca). */
      const u = r.v && r.prod.tipo !== 'granel' ? r.cantidad * (r.v.unidadesStock || 1) : r.cantidad;
      porMarca.set(r.prod.marcaId, (porMarca.get(r.prod.marcaId) ?? 0) + u);
    }
    const marcasIncumplidas = cat.reglasMarca.filter((rm: any) => {
      const enCarrito = porMarca.get(rm.marcaId);
      return enCarrito != null && enCarrito < rm.unidadesMinimas;
    });
    const productosIncumplidos = resueltos.filter((r) => de(r).unidadesMinimas > 0 && r.cantidad < de(r).unidadesMinimas);
    const cantidadOk = marcasIncumplidas.length === 0 && productosIncumplidos.length === 0;

    if (!montoOk && !cantidadOk) {
      const partes: string[] = [];
      if (cat.montoMinimo > 0) partes.push(`llegar a $${cat.montoMinimo} en total`);
      for (const rm of marcasIncumplidas) partes.push(`${rm.unidadesMinimas} unidades surtidas de ${rm.marca}`);
      for (const r of productosIncumplidos) partes.push(`${de(r).unidadesMinimas} de ${nombreDe(r)}`);
      throw new BadRequestException(`Para completar el pedido, alcanzá alguna de estas condiciones: ${partes.join(' — o — ')}.`);
    }

    /*
     * El ENVÍO SIN COSTO (la camioneta de la empresa) se puede apagar, y tiene
     * su PROPIO piso, duro (sin el camino alternativo por cantidades): mover el
     * vehículo cuesta lo mismo lleve lo que lleve, así que el pedido tiene que
     * valer el viaje. El cliente nunca lee «camioneta»: lee «envío sin costo».
     */
    if (entrega === 'camioneta' && !cat.envioCamionetaActivo) {
      throw new BadRequestException('El envío sin costo no está disponible por ahora. Elegí retiro en el local o envío por cadete.');
    }
    if (entrega === 'camioneta' && cat.montoMinimoCamioneta > 0 && total < cat.montoMinimoCamioneta) {
      const pesos = cat.montoMinimoCamioneta.toLocaleString('es-AR', { maximumFractionDigits: 2 });
      throw new BadRequestException(
        `El envío sin costo necesita un pedido de al menos $${pesos}. `
        + 'Sumá productos, o elegí retiro en el local o envío por cadete.',
      );
    }

    /*
     * Cliente: se busca por DNI. Si ya existe, el pedido queda adjudicado a ESE
     * cliente. Si no, NO se da de alta acá: los datos del formulario viajan en
     * `webCliente` y el alta se decide al ACEPTAR la orden en el ERP — así una
     * prueba o un spam no ensucian la base de clientes.
     */
    const [existente] = await this.db.select().from(clientes)
      .where(and(eq(clientes.tipoDoc, 'dni'), eq(clientes.numeroDoc, dni))).limit(1);

    /*
     * EL RENGLÓN DEL PEDIDO, EN LA UNIDAD DEL STOCK: la bolsa viaja en KILOS
     * (2 bolsas de 10 kg = 20 kg del producto, a precio por kilo) y el paquete
     * en PAQUETES (una caja de 6 = 6 paquetes, a precio por paquete). Así la
     * reserva, el fraccionado al confirmar y el cierre en la caja trabajan con
     * lo que ya conocen. El presupuesto guarda el NETO por unidad y el
     * descuento como PORCENTAJE (una oferta 'porcentaje' queda auditada como tal).
     */
    const items = resueltos.map((r) => {
      const iva = r.prod.iva ?? 21;
      const x = de(r);
      const unidadesStock = r.v ? (r.v.unidadesStock ?? (r.v.presentacionId == null ? r.v.kgPorUnidad : (r.v.paquetesPorUnidad || 1))) : 1;
      const esPorcentaje = x.oferta?.tipo === 'porcentaje' && x.oferta.precioOferta != null;
      const precioCompra = esPorcentaje ? x.precio : precioEfectivo(r);
      const descuento = esPorcentaje ? money(100 * (1 - x.oferta.precioOferta / x.precio)) : 0;
      /* La lista de la opción (la caja de 5 puede ser Mayorista 2): con esa se cotizó y con esa cierra la caja. */
      const lista = listaDeOpcion.get(`${r.prod.id}:${r.v ? r.v.clave : ''}`) ?? null;
      return {
        productoId: r.prod.id, presentacionId: r.v?.presentacionId ?? null,
        nombre: r.prod.nombre,
        detalle: r.v ? r.v.etiqueta : 'Unidad',
        cantidad: r3(r.cantidad * unidadesStock),
        /* Sin cortar a 2 decimales: el total del presupuesto se suma con este número y
         * tiene que dar EXACTO lo que el cliente vio (la caja de 6 daba 2 centavos menos). */
        precioLista: Math.round((precioCompra / unidadesStock / (1 + iva / 100)) * 1e6) / 1e6,
        descuento, iva, lista: lista?.nombre ?? cat.listaNombre, listaId: lista?.id ?? cat.listaId ?? null, ofertaNombre: x.oferta?.nombre ?? '',
      };
    });

    return this.presupuestos.crearDesdeWeb({
      clienteId: existente?.id ?? null, sucursalId: cat.sucursalId,
      // Topes de largo del lado del servidor: el `maxLength` del checkout vive
      // en el navegador y no protege al `POST` directo. Un pedido con 3 MB de
      // texto en observaciones vuelve inusable la bandeja de Órdenes al pintarla.
      entrega, observaciones: String(dto.observaciones ?? '').slice(0, 500),
      webCliente: {
        nombre: String(c.nombre ?? '').trim().slice(0, 60),
        apellido: String(c.apellido ?? '').trim().slice(0, 60),
        telefono, dni,
        // La dirección viaja con los datos del cliente (jsonb, sin migración):
        // el ERP la muestra en la orden y la usa al darlo de alta.
        ...(domicilio ?? {}),
      },
      items,
    });
  }
}

/**
 * Los CUATRO endpoints públicos del sistema — los únicos pensados para recibir
 * internet directo. Cada uno con su cupo por IP (ver rate-limit.guard.ts);
 * el resto de la API no se limita: el ERP le pega todo el día desde la red local.
 */
@Controller('tienda')
@Publico()
@UseGuards(TiendaRateLimitGuard)
export class TiendaController {
  constructor(private readonly svc: TiendaService) {}

  @Get('catalogo')
  @RateLimit('catalogo')
  catalogo() { return this.svc.catalogo(); }

  @Post('pedidos')
  @RateLimit('pedidos')
  pedido(@Body() body: any) { return this.svc.pedido(body ?? {}); }

  @Post('eventos')
  @RateLimit('eventos')
  eventos(@Body() body: any) { return this.svc.eventos(body ?? {}); }

  /**
   * Sirve el binario de una imagen del sitio. El `?v=` del catálogo versiona el caché.
   *
   * ESTE ENDPOINT ES EL QUE VUELVE PELIGROSA UNA SUBIDA. Es público, y nginx lo
   * publica en el MISMO ORIGEN que el dashboard (`location /api/`), donde vive
   * el token de sesión del ERP. Un archivo que el navegador trate como
   * documento —un SVG, por ejemplo— correría ahí adentro con la sesión de quien
   * abra el link. Tres candados, y ninguno reemplaza a los otros:
   *
   *   1. el mime sale de una lista blanca, no de la base: aunque una fila vieja
   *      o una migración metan otra cosa, de acá no sale;
   *   2. `Content-Disposition: attachment` — el navegador la baja en vez de
   *      renderizarla si alguien la abre como página;
   *   3. `Content-Security-Policy: sandbox` — y si igual la renderiza, ahí
   *      adentro no corre script ni hay acceso al origen.
   *
   * El `<img src="...">` del sitio sigue andando igual: una etiqueta `img` no
   * mira el `Content-Disposition`.
   *
   * Y el CUARTO encabezado va al revés que los otros tres: helmet marca toda la
   * API como `Cross-Origin-Resource-Policy: same-origin`, que es lo correcto
   * para el resto —el dashboard comparte origen con la API— pero deja al sitio
   * público sin poder mostrar una sola imagen cuando vive en otro dominio (o en
   * otro puerto, como en desarrollo: el navegador corta con
   * ERR_BLOCKED_BY_RESPONSE.NotSameOrigin y no se ve ni el logo). Estas
   * imágenes son públicas por definición, así que ACÁ Y SOLO ACÁ se abre.
   */
  @Get('imagenes/:tipo/:refId')
  @RateLimit('imagenes')
  async imagen(
    @Param('tipo') tipo: string,
    @Param('refId', ParseIntPipe) refId: number,
    @Res() res: Response,
  ) {
    const img = await this.svc.imagen(tipo, refId);
    if (!img) throw new NotFoundException('Imagen inexistente.');
    if (!MIMES_IMAGEN.has(img.mime)) throw new NotFoundException('Imagen inexistente.');
    res.setHeader('Content-Type', img.mime);
    res.setHeader('Content-Disposition', `attachment; filename="${tipo}-${refId}"`);
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(img.data, 'base64'));
  }
}

@Module({
  imports: [ListasModule, ConfiguracionModule, PresupuestosModule, OfertasModule],
  controllers: [TiendaController],
  providers: [TiendaService, TiendaRateLimitGuard],
})
export class TiendaModule {}
