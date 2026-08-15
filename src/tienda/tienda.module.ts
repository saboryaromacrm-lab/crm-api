/**
 * TIENDA — la cara pública del catálogo (sitio web)
 * ============================================================================
 * Todo lo que el sitio Next.js necesita, en un shape chico y sin datos
 * internos (nada de costos, nada de stock por sucursal, nada de otras
 * listas). Un solo precio por producto: el de la lista "tienda" (la que
 * apunta la modalidad configurada como mayorista; si un producto no la
 * tiene cargada, cae a la lista base).
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
import type { Response } from 'express';
import { and, eq, gte, isNull, ne } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import {
  categorias, clientes, etiquetas, marcas, movimientos, productoEtiquetas, productoListas,
  productoProveedores, productos, stock, sucursales, webEventos, webImagenes,
} from '../db/schema';
import { costoNetoEntry, formatoActivo, precioVentaFila } from '../inventario/pricing';
import { ListasModule } from '../listas/listas.module';
import { ListasService } from '../listas/listas.module';
import { ConfiguracionModule, ConfiguracionService } from '../configuracion/configuracion.module';
import { PresupuestosModule } from '../presupuestos/presupuestos.module';
import { PresupuestosService } from '../presupuestos/presupuestos.module';
import { OfertasModule, OfertasService } from '../ofertas/ofertas.module';

const money = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

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

/**
 * Teléfono argentino normalizado a área + abonado (10 dígitos), o '' si no
 * llega. Misma regla que el checkout del sitio y que el link de WhatsApp del
 * CRM: tolera `+54`, el `9` de celular, el `0` y el viejo `15`.
 */
function telefonoArgentino(tel: string): string {
  let d = String(tel ?? '').replace(/\D/g, '');
  if (d.startsWith('54')) d = d.slice(2);
  if (d.startsWith('0')) d = d.slice(1);
  if (d.startsWith('9')) d = d.slice(1);
  d = d.replace(/^(\d{2,4})15(\d{6,8})$/, '$1$2');
  return d.length === 10 ? d : '';
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

  async catalogo() {
    const suc = await this.sucursalTienda();
    const desdeReingreso = new Date(Date.now() - DIAS_REINGRESO * 86400000);
    const [prods, provs, filas, petiq, ms, cs, ets, existencias, cat, cfg, ofertasActivas, ingresosRecientes, imgs, web] = await Promise.all([
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
      suc
        ? this.db.select().from(stock).where(and(eq(stock.sucursalId, suc.id), eq(stock.estado, 'disponible'), isNull(stock.presentacionId)))
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
    const nombreEtiqueta = new Map(ets.map((e) => [e.id, e.nombre]));
    const etiquetasDe = new Map<number, number[]>();
    for (const e of petiq) {
      const arr = etiquetasDe.get(e.productoId);
      if (arr) arr.push(e.etiquetaId); else etiquetasDe.set(e.productoId, [e.etiquetaId]);
    }
    const stockPorProd = new Map<number, number>();
    for (const s of existencias) stockPorProd.set(s.productoId, (stockPorProd.get(s.productoId) ?? 0) + s.cantidad);

    const activas = (cat.listas ?? []).filter((l: any) => l.activa);
    const listaTienda = activas.find((l: any) => l.modalidadId === cfg.modalidadMontoId)
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
    };

    const vacio = {
      sucursalId: suc?.id ?? null, listaId: null, listaNombre: '', montoMinimo: 0,
      montoMinimoCamioneta: Number(cfg.montoMinimoCamioneta) > 0 ? Number(cfg.montoMinimoCamioneta) : 0,
      presupuestoValidezDias: Number(cfg.presupuestoValidezDias) || 7,
      categorias: [], marcas: [], etiquetas: [], reglasMarca: [], items: [],
      sitio,
    };
    if (!listaTienda) return vacio;

    /*
     * PRE-ÍNDICE de las tablas hijas, un solo pase cada una. Sin esto, adentro
     * del loop de productos había un `filas.find` sobre `productoListas` entera
     * y un `provs.filter` sobre `productoProveedores` entera POR CADA producto:
     * O(productos × filas). En un endpoint público que además corre en cada
     * pedido, con el catálogo grande son millones de comparaciones. El `.has`
     * conserva el "primer match" que hacía `.find` (hay una sola fila por
     * producto en la lista de la tienda, pero por las dudas).
     */
    const filaTiendaPorProducto = new Map<number, any>();
    for (const f of filas) {
      if (f.presentacionId == null && f.listaId === listaTienda.id && !filaTiendaPorProducto.has(f.productoId)) {
        filaTiendaPorProducto.set(f.productoId, f);
      }
    }
    const provsPorProducto = new Map<number, any[]>();
    for (const x of provs) {
      const arr = provsPorProducto.get(x.productoId);
      if (arr) arr.push(x); else provsPorProducto.set(x.productoId, [x]);
    }

    const items: any[] = [];
    for (const p of prods) {
      /*
       * REGLA DE PUBLICACIÓN (módulo Web): está en el sitio el producto que
       * tiene precio cargado en la lista Mayorista — ni flag manual ni
       * fallback a otra lista. Publicar = cargarle el precio mayorista;
       * sacarlo del sitio = quitárselo.
       */
      /* La fila del producto SUELTO: el sitio todavía publica la madre, no sus
       * paquetes (el stock que mira ya es el del granel). Sin el filtro de
       * presentación podría tomar la fila de un paquete de 250 g y publicar ESE
       * precio como si fuera el del kilo. */
      const filaTienda = filaTiendaPorProducto.get(p.id);
      if (!filaTienda) continue;

      const costoNeto = costoNetoEntry(formatoActivo(provsPorProducto.get(p.id) ?? []), p.iva);
      const pv = precioVentaFila(costoNeto, filaTienda, { iva: p.iva, redondeo: cfg.redondeoPrecio });
      /*
       * Sin precio real no hay publicación: una fila mayorista con el costo a
       * medio cargar daría $0 — y el pedido se recotizaría a $0. Mejor que el
       * producto no aparezca hasta que el precio esté bien.
       */
      if (!(pv.finalUnitario > 0)) continue;

      const stockDisp = stockPorProd.get(p.id) ?? 0;
      /*
       * Piso de stock online (`webStockMin`): al llegar a ese número, lo que
       * queda se prioriza para fraccionar / venta minorista y el sitio pasa a
       * "Sin stock". 0 = se vende online hasta la última unidad.
       */
      /*
       * Lo que el sitio PUEDE vender de este producto: el disponible menos el
       * piso reservado para el mostrador. Viaja como número (no solo el sí/no)
       * para que el carrito pueda topear la cantidad y avisar "es todo lo que
       * hay" en vez de dejar pedir 50 kg de algo que tiene 3.
       *
       * Es el único dato de stock que el sitio conoce, y solo se muestra al
       * llegar al tope: no es un cartel de "quedan pocos".
       */
      const disponibleParaWeb = Math.max(0, Math.round((stockDisp - (p.webStockMin || 0)) * 1000) / 1000);
      const disponibleWeb = disponibleParaWeb > 1e-9;
      const etiquetasIds = etiquetasDe.get(p.id) ?? [];

      /* Una promo por producto: la de mayor beneficio entre las que alcanzan
       * (misma regla que el POS). El alcance `presentacion` no entra: el sitio
       * publica el producto SUELTO, no sus paquetes — una oferta apuntada a un
       * paquete de 250 g no puede bajarle el precio al kilo. */
      const matches = ofertasWeb.filter((o: any) => (o.alcances ?? []).some((a: any) => {
        if (a.tipo === 'producto') return a.refId === p.id;
        if (a.tipo === 'marca') return a.refId === p.marcaId;
        if (a.tipo === 'categoria') return a.refId === p.categoriaId;
        if (a.tipo === 'etiqueta') return etiquetasIds.includes(a.refId);
        return false;
      }));
      let mejorOferta: any = null;
      let mejorPrecio: number | null = null;
      for (const o of matches) {
        const pOferta = precioConOferta(o, pv.finalUnitario);
        if (pOferta != null && (mejorPrecio == null || pOferta < mejorPrecio)) {
          mejorOferta = o; mejorPrecio = pOferta;
        } else if (pOferta == null && !mejorOferta) {
          mejorOferta = o; // nxm / segunda_unidad / pack: sin precio unitario, pero se avisa igual.
        }
      }

      items.push({
        id: p.id,
        nombre: p.nombre,
        marcaId: p.marcaId,
        marca: p.marcaId ? (nombreMarca.get(p.marcaId) ?? '') : '',
        categoriaId: p.categoriaId,
        categoria: p.categoriaId ? (nombreCategoria.get(p.categoriaId) ?? '') : '',
        etiquetas: etiquetasIds
          .map((id) => ({ id, nombre: nombreEtiqueta.get(id) ?? '' }))
          .filter((e) => e.nombre),
        tipo: p.tipo,
        unidad: p.tipo === 'granel' ? 'kg' : 'u',
        iva: p.iva,
        precio: pv.finalUnitario,
        /** Mínimo de compra PROPIO del producto (0 = sin mínimo). */
        unidadesMinimas: filaTienda.unidadesMinimas || 0,
        enStock: disponibleWeb,
        /** Cuánto puede vender el sitio (ya descontado el piso del mostrador). */
        disponible: disponibleParaWeb,
        // La imagen subida en el módulo Web manda; la URL externa es el plan B.
        imagenUrl: urlImagen('producto', p.id) || p.imagenUrl || '',
        destacado: !!p.destacado,
        oferta: mejorOferta
          ? { id: mejorOferta.id, nombre: mejorOferta.nombre, tipo: mejorOferta.tipo, badge: describirOferta(mejorOferta), precioOferta: mejorPrecio }
          : null,
        reingreso: disponibleWeb && reingresados.has(p.id),
      });
    }

    const contar = (mapa: Map<number, { id: number; nombre: string; count: number }>, id: number | null, nombre: string) => {
      if (!id || !nombre) return;
      const e = mapa.get(id) ?? { id, nombre, count: 0 };
      e.count += 1;
      mapa.set(id, e);
    };
    const catMap = new Map<number, any>(); const marcaMap = new Map<number, any>(); const etiqMap = new Map<number, any>();
    for (const it of items) {
      contar(catMap, it.categoriaId, it.categoria);
      contar(marcaMap, it.marcaId, it.marca);
      for (const e of it.etiquetas) contar(etiqMap, e.id, e.nombre);
    }
    const porNombre = (a: any, b: any) => a.nombre.localeCompare(b.nombre, 'es');

    return {
      sucursalId: suc?.id ?? null,
      listaId: listaTienda.id,
      listaNombre: listaTienda.nombre,
      /** 0 = sin mínimo por monto configurado (solo rigen los de marca/producto, si hay). */
      montoMinimo: Number(cfg.montoMinimoMayorista) > 0 ? Number(cfg.montoMinimoMayorista) : 0,
      /** Piso EXTRA si la entrega es con la camioneta de la empresa (0 = sin piso). */
      montoMinimoCamioneta: Number(cfg.montoMinimoCamioneta) > 0 ? Number(cfg.montoMinimoCamioneta) : 0,
      presupuestoValidezDias: Number(cfg.presupuestoValidezDias) || 7,
      categorias: [...catMap.values()].sort(porNombre)
        .map((c) => ({ ...c, imagenUrl: urlImagen('categoria', c.id) })),
      marcas: [...marcaMap.values()].sort(porNombre)
        .map((m) => ({ ...m, imagenUrl: urlImagen('marca', m.id) })),
      etiquetas: [...etiqMap.values()].sort(porNombre),
      reglasMarca: (cat.reglasMarca ?? [])
        .filter((r: any) => r.activa && r.unidadesMinimas > 0)
        .map((r: any) => ({ marcaId: r.marcaId, marca: r.marca, unidadesMinimas: r.unidadesMinimas })),
      items,
      sitio,
    };
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

    /*
     * El techo va ANTES de tocar la base: el body admite 4 MB, y con
     * `{"productoId":1,"cantidad":1}` repetido eso son ~110.000 renglones
     * válidos en un solo INSERT. Un carrito de verdad no tiene 100 productos
     * distintos.
     */
    if (carritoIn.length > MAX_RENGLONES_PEDIDO) {
      throw new BadRequestException(`Un pedido no puede tener más de ${MAX_RENGLONES_PEDIDO} renglones.`);
    }

    const cat = await this.catalogo();
    const porId = new Map<number, any>(cat.items.map((i: any): [number, any] => [i.id, i]));

    /*
     * Se AGRUPA por producto: el mismo producto repetido en dos renglones es un
     * solo renglón con la suma. Sin esto, el tope de stock de más abajo se
     * esquiva partiendo el pedido en pedacitos que por separado entran.
     *
     * `Number.isFinite` y no `|| 0`: `Number('1e999')` es Infinity, es truthy,
     * pasa `cantidad > 0` y Postgres lo GUARDA en `double precision` — desde
     * ahí contamina el total del pedido y el ranking de las estadísticas.
     */
    const porProducto = new Map<number, { prod: any; cantidad: number }>();
    for (const linea of carritoIn) {
      const prod = porId.get(Number(linea?.productoId));
      const cantidad = Number(linea?.cantidad);
      if (!prod || !Number.isFinite(cantidad) || cantidad <= 0) continue;
      const acc = porProducto.get(prod.id);
      if (acc) acc.cantidad += cantidad;
      else porProducto.set(prod.id, { prod, cantidad });
    }
    const resueltos = [...porProducto.values()];
    if (!resueltos.length) throw new BadRequestException('Ningún producto del pedido está disponible.');

    /*
     * EL STOCK LO DECIDE EL SERVIDOR. El carrito del sitio ya topea la cantidad
     * (`cart.tsx`), pero eso es una comodidad del navegador: acá se vuelve a
     * mirar contra el mismo `disponible` que publica el catálogo (el stock de
     * la Distribuidora menos el piso reservado para el mostrador). También
     * cubre el caso honesto: el pedido que quedó abierto media hora mientras
     * otro se llevaba lo último.
     */
    const agotados = resueltos.filter((r) => !r.prod.enStock);
    if (agotados.length) {
      throw new BadRequestException(
        `Se quedó sin stock: ${agotados.map((r) => r.prod.nombre).join(', ')}. `
        + 'Sacalo del carrito y volvé a intentar.',
      );
    }
    const excedidos = resueltos.filter((r) => r.cantidad > r.prod.disponible);
    if (excedidos.length) {
      throw new BadRequestException(
        'No tenemos esa cantidad: '
        + excedidos.map((r) => `${r.prod.nombre} (quedan ${r.prod.disponible} ${r.prod.unidad})`).join(', ')
        + '. Ajustá el carrito y volvé a intentar.',
      );
    }

    // Precio EFECTIVO: si hay una promo con precio unitario propio (porcentaje / precio_fijo),
    // el pedido se cotiza con ese precio — el cliente vio ese número, se le cobra ese número.
    const precioEfectivo = (prod: any) => prod.oferta?.precioOferta ?? prod.precio;
    const total = resueltos.reduce((a, r) => a + r.cantidad * precioEfectivo(r.prod), 0);

    // Gate de compra mínima: por MONTO o por CANTIDAD (marca / producto) — no
    // cambia el precio, solo habilita finalizar el pedido (igual que el sitio real).
    const montoOk = cat.montoMinimo > 0 ? total >= cat.montoMinimo : true;
    const porMarca = new Map<number, number>();
    for (const r of resueltos) {
      if (!r.prod.marcaId) continue;
      porMarca.set(r.prod.marcaId, (porMarca.get(r.prod.marcaId) ?? 0) + r.cantidad);
    }
    const marcasIncumplidas = cat.reglasMarca.filter((rm: any) => {
      const enCarrito = porMarca.get(rm.marcaId);
      return enCarrito != null && enCarrito < rm.unidadesMinimas;
    });
    const productosIncumplidos = resueltos.filter((r) => r.prod.unidadesMinimas > 0 && r.cantidad < r.prod.unidadesMinimas);
    const cantidadOk = marcasIncumplidas.length === 0 && productosIncumplidos.length === 0;

    if (!montoOk && !cantidadOk) {
      const partes: string[] = [];
      if (cat.montoMinimo > 0) partes.push(`llegar a $${cat.montoMinimo} en total`);
      for (const rm of marcasIncumplidas) partes.push(`${rm.unidadesMinimas} unidades surtidas de ${rm.marca}`);
      for (const r of productosIncumplidos) partes.push(`${r.prod.unidadesMinimas} unidades de ${r.prod.nombre}`);
      throw new BadRequestException(`Para completar el pedido, alcanzá alguna de estas condiciones: ${partes.join(' — o — ')}.`);
    }

    /*
     * La camioneta tiene su PROPIO piso, y es duro (sin el camino alternativo
     * por cantidades): mover el vehículo cuesta lo mismo lleve lo que lleve,
     * así que el pedido tiene que valer el viaje.
     */
    if (dto.entrega === 'camioneta' && cat.montoMinimoCamioneta > 0 && total < cat.montoMinimoCamioneta) {
      throw new BadRequestException(
        `El envío con la camioneta necesita un pedido de al menos $${cat.montoMinimoCamioneta}. `
        + 'Sumá productos, o elegí retiro en el local o envío por cadete.',
      );
    }

    /*
     * Cliente: se busca por DNI. Si ya existe, el pedido queda adjudicado a ESE
     * cliente. Si no, NO se da de alta acá: los datos del formulario viajan en
     * `webCliente` y el alta se decide al ACEPTAR la orden en el CRM — así una
     * prueba o un spam no ensucian la base de clientes.
     */
    const [existente] = await this.db.select().from(clientes)
      .where(and(eq(clientes.tipoDoc, 'dni'), eq(clientes.numeroDoc, dni))).limit(1);

    const items = resueltos.map((r) => {
      const iva = r.prod.iva ?? 21;
      // El presupuesto guarda el NETO unitario (misma convención que el resto del sistema)
      // y el descuento como PORCENTAJE — así una oferta 'porcentaje' queda auditada como
      // tal en vez de disfrazada de precio de lista distinto.
      const esPorcentaje = r.prod.oferta?.tipo === 'porcentaje' && r.prod.oferta.precioOferta != null;
      const precioBase = esPorcentaje ? r.prod.precio : precioEfectivo(r.prod);
      const descuento = esPorcentaje ? money(100 * (1 - r.prod.oferta.precioOferta / r.prod.precio)) : 0;
      return {
        productoId: r.prod.id, presentacionId: null,
        nombre: r.prod.nombre, detalle: r.prod.unidad === 'kg' ? 'Suelto (por kg)' : 'Unidad',
        cantidad: r.cantidad,
        precioLista: money(precioBase / (1 + iva / 100)),
        descuento, iva, lista: cat.listaNombre, ofertaNombre: r.prod.oferta?.nombre ?? '',
      };
    });

    return this.presupuestos.crearDesdeWeb({
      clienteId: existente?.id ?? null, sucursalId: cat.sucursalId,
      // Topes de largo del lado del servidor: el `maxLength` del checkout vive
      // en el navegador y no protege al `POST` directo. Un pedido con 3 MB de
      // texto en observaciones vuelve inusable la bandeja de Órdenes al pintarla.
      entrega: dto.entrega, observaciones: String(dto.observaciones ?? '').slice(0, 500),
      webCliente: {
        nombre: String(c.nombre ?? '').trim().slice(0, 60),
        apellido: String(c.apellido ?? '').trim().slice(0, 60),
        telefono, dni,
      },
      items,
    });
  }
}

/**
 * Los CUATRO endpoints públicos del sistema — los únicos pensados para recibir
 * internet directo. Cada uno con su cupo por IP (ver rate-limit.guard.ts);
 * el resto de la API no se limita: el CRM le pega todo el día desde la red local.
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
   * el token de sesión del CRM. Un archivo que el navegador trate como
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
