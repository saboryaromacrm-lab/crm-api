/**
 * CATÁLOGO PARA APPS EXTERNAS (12/10/2026, pedido del dueño)
 * ============================================================================
 * `GET /api/catalogo-externo` — todos los productos (sin los archivados) con
 * sus datos, el precio final de cada lista de venta y el stock disponible por
 * sucursal, para una app propia del dueño. Decisiones suyas:
 *
 *   · ABIERTO, sin clave ni sesión (`@Publico`): es todo suyo.
 *   · SIN costos, proveedores ni markups: solo lo que se vende.
 *   · Con las MARCAS y su logo (28/10/2026, para armar piezas gráficas): cada
 *     producto dice su `marcaId`.
 *
 * NO TOCA AL SISTEMA: solo lee, y reusa el mismo armado de precios que el ERP
 * (`bootstrapCatalogo`, con los costos ocultos), así un precio de acá es el
 * mismo que cobra la caja. El resultado se guarda 60 segundos en memoria y los
 * pedidos simultáneos esperan UNA sola cuenta: aunque la app lo pida mil veces
 * por minuto, la base lo calcula a lo sumo una vez por minuto. Se guarda ya
 * convertido a texto JSON, y con su ETag: si la app pregunta «¿cambió?»
 * (If-None-Match) y no cambió, la respuesta es un 304 vacío.
 */
import { Controller, Get, Inject, Injectable, Module, Req, Res } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { Publico } from '../auth/auth.decoradores';
import { DRIZZLE, Database } from '../db/drizzle';
import { marcas, stock, sucursales, webImagenes } from '../db/schema';
import { InventarioModule } from '../inventario/inventario.module';
import { InventarioService } from '../inventario/inventario.service';
import { ListasModule, ListasService } from '../listas/listas.module';
import { rutaImagen } from '../web/ruta-imagen';

const VIGENCIA_MS = 60_000;
const r3 = (n: unknown) => Math.round((Number(n) || 0) * 1000) / 1000;
const tamano = (kg: number) => (kg < 1 ? `${Math.round(kg * 1000)} g` : `${kg} kg`);

@Injectable()
export class CatalogoExternoService {
  private cache: { hasta: number; datos: any; texto: Map<string, string> } | null = null;
  private enCurso: Promise<any> | null = null;

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly inv: InventarioService,
    private readonly listas: ListasService,
  ) {}

  /**
   * El catálogo vigente, como texto JSON: el guardado si tiene menos de un
   * minuto; si no, uno nuevo (una sola cuenta a la vez). `base` es la dirección
   * de esta API, para devolver las fotos y los logos subidos con su URL completa.
   */
  async json(base: string): Promise<string> {
    if (!this.cache || this.cache.hasta <= Date.now()) {
      if (!this.enCurso) {
        this.enCurso = this.armar()
          .then((datos) => { this.cache = { hasta: Date.now() + VIGENCIA_MS, datos, texto: new Map() }; })
          .finally(() => { this.enCurso = null; });
      }
      await this.enCurso;
    }
    const c = this.cache!;
    let texto = c.texto.get(base);
    if (!texto) {
      const url = (x: string) => (x.startsWith('tienda/') ? base + x : x);
      texto = JSON.stringify({
        ...c.datos,
        marcas: c.datos.marcas.map((m: any) => ({ ...m, logo: url(m.logo) })),
        productos: c.datos.productos.map((p: any) => ({ ...p, imagen: url(p.imagen) })),
      });
      c.texto.set(base, texto);
    }
    return texto;
  }

  private async armar() {
    const [{ productos }, cat, sucs, filasStock, imgs, filasMarcas] = await Promise.all([
      this.inv.bootstrapCatalogo(false, true),
      this.listas.catalogo(),
      this.db.select({ id: sucursales.id, nombre: sucursales.nombre }).from(sucursales).where(eq(sucursales.activa, true)),
      this.db.select({
        productoId: stock.productoId, presentacionId: stock.presentacionId, sucursalId: stock.sucursalId, cantidad: stock.cantidad,
      }).from(stock).where(eq(stock.estado, 'disponible' as any)),
      this.db.select({ tipo: webImagenes.tipo, refId: webImagenes.refId, actualizadoEn: webImagenes.actualizadoEn }).from(webImagenes),
      this.db.select({ id: marcas.id, nombre: marcas.nombre }).from(marcas),
    ]);

    /* Stock disponible: forma (producto:presentación) → sucursal → cantidad. Solo sucursales activas. */
    const activas = new Set(sucs.map((x) => x.id));
    const stockDe = new Map<string, Record<string, number>>();
    for (const f of filasStock) {
      if (!activas.has(f.sucursalId)) continue;
      const k = `${f.productoId}:${f.presentacionId ?? ''}`;
      const m = stockDe.get(k) ?? {};
      m[f.sucursalId] = r3((m[f.sucursalId] ?? 0) + Number(f.cantidad));
      stockDe.set(k, m);
    }
    const stockFormado = (productoId: number, presId: number | null) => {
      const m = stockDe.get(`${productoId}:${presId ?? ''}`) ?? {};
      return Object.fromEntries(sucs.map((x) => [String(x.id), m[x.id] ?? 0]));
    };

    /* Lo subido en el módulo Web (ruta relativa a la API): la foto de cada producto y el logo de cada marca. */
    const subida = (tipo: string) => new Map(imgs.filter((i) => i.tipo === tipo)
      .map((i) => [i.refId, rutaImagen(tipo, i.refId, i.actualizadoEn)]));
    const fotoSubida = subida('producto');
    const logoSubido = subida('marca');

    const precios = (ls: any[]) => (ls ?? []).map((l) => ({
      listaId: l.listaId,
      lista: l.nombre,
      modalidad: l.modalidad,
      /** Precio final con IVA de UNA unidad (o un kg, en el granel suelto). */
      precio: l.precioFinalUnitario,
      /** En cuántas unidades se vende en esa lista (1 = suelto; 12 = la caja). */
      unidades: Number(l.unidades) || 1,
      /** Precio final con IVA del formato completo (unidades × precio). */
      precioFormato: l.precioFinalFormato,
      unidadesMinimas: Number(l.unidadesMinimas) || 0,
      codigoBarras: l.codigoBarras || '',
    }));

    const lista = productos
      /* Ni archivados ni lo de uso exclusivo de Coffit (19/10/2026, exclusivoCoffit.ts). */
      .filter((p: any) => p.estado !== 'archivado' && !p.soloCafeteria)
      .map((p: any) => ({
        id: p.id,
        nombre: p.nombre,
        descripcion: p.descripcion || '',
        codigo: p.codigoPropio || '',
        codigoBarras: p.codigoBarras || '',
        dun: p.dun || '',
        marcaId: p.marcaId ?? null,
        marca: p.marca || '',
        categoria: p.categoria || '',
        subcategoria: p.subcategoria || '',
        etiquetas: p.etiquetasNombres ?? [],
        tipo: p.tipo,
        unidad: p.tipo === 'granel' ? 'kg' : 'u',
        estado: p.estado,
        iva: Number(p.iva),
        imagen: fotoSubida.get(p.id) ?? (p.imagenUrl || ''),
        precios: precios(p.listas),
        stock: stockFormado(p.id, null),
        presentaciones: (p.presentaciones ?? []).map((pr: any) => ({
          id: pr.id,
          tamano: tamano(Number(pr.tamKg)),
          kg: Number(pr.tamKg),
          codigoBarras: pr.codigoBarras || '',
          precios: precios(pr.listas),
          stock: stockFormado(p.id, pr.id),
        })),
      }))
      .sort((a: any, b: any) => a.nombre.localeCompare(b.nombre, 'es'));

    /* Las marcas que tienen algún producto en el catálogo, con su logo ('' = sin logo cargado). */
    const productosDe = new Map<number, number>();
    for (const p of lista) if (p.marcaId) productosDe.set(p.marcaId, (productosDe.get(p.marcaId) ?? 0) + 1);
    const marcasConProductos = filasMarcas
      .filter((m) => productosDe.has(m.id))
      .map((m) => ({ id: m.id, nombre: m.nombre, logo: logoSubido.get(m.id) ?? '', productos: productosDe.get(m.id) }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));

    return {
      generado: new Date().toISOString(),
      cantidad: lista.length,
      sucursales: sucs,
      marcas: marcasConProductos,
      listas: cat.listas.filter((l: any) => l.activa)
        .map((l: any) => ({ id: l.id, nombre: l.nombre, modalidad: l.modalidad, orden: l.orden })),
      productos: lista,
    };
  }
}

@Controller('catalogo-externo')
export class CatalogoExternoController {
  constructor(private readonly svc: CatalogoExternoService) {}

  /** Todo el catálogo. Las imágenes subidas vuelven como URL completa de esta misma API. */
  @Get()
  @Publico()
  async catalogo(@Req() req: any, @Res() res: any) {
    const proto = String(req.headers['x-forwarded-proto'] ?? req.protocol ?? 'https').split(',')[0].trim();
    const base = `${proto}://${req.headers['x-forwarded-host'] ?? req.headers.host}/api/`;
    const texto = await this.svc.json(base);
    res.setHeader('Cache-Control', 'public, max-age=60');
    /* Abierto también para una app web de otro dominio (el ERP conserva su origen exacto). */
    if (!res.getHeader('Access-Control-Allow-Origin')) res.setHeader('Access-Control-Allow-Origin', '*');
    // `send` con texto pone el ETag y contesta 304 solo si la app ya lo tiene.
    res.type('application/json').send(texto);
  }
}

@Module({
  imports: [InventarioModule, ListasModule],
  controllers: [CatalogoExternoController],
  providers: [CatalogoExternoService],
})
export class CatalogoExternoModule {}
