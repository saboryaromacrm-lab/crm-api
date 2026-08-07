/**
 * FACTURAS POR PROCESAR — la bandeja de papeles subidos.
 * ============================================================================
 * Parte de una observación simple: hoy "recibir el papel" y "cargar la factura"
 * son un solo momento, y no tienen por qué serlo. La mercadería llega el martes
 * a la mañana con el camión; el admin carga las facturas el viernes. Entre esos
 * dos momentos el papel se pierde, se moja o se olvida en un cajón.
 *
 * Acá la cajera sube la foto cuando llega el camión y ahí termina su trabajo.
 * El admin procesa la bandeja cuando puede.
 *
 * QUÉ SE LEE Y QUÉ NO
 * -------------------
 * La factura son dos mitades y se resuelven distinto:
 *
 *  - **El encabezado NO se interpreta.** Toda factura electrónica argentina
 *    lleva el **QR de la RG 4892**, que es un JSON en base64 con CUIT del
 *    emisor, tipo, punto de venta, número, fecha, total y CAE. Leer un QR es
 *    determinístico: o lo lee o no lo lee, no hay error de interpretación. De
 *    ahí sale todo este encabezado, exacto.
 *
 *  - **El detalle de renglones sí hay que interpretarlo.** Argentina no tiene
 *    intercambio de factura estructurada (no hay CFDI ni NF-e): los ítems solo
 *    existen en el PDF del proveedor. Eso es la etapa siguiente.
 *
 * Y el dato más útil que trae el QR es el **total**: es el número contra el que
 * después se valida que los renglones cargados cierren. Una factura es
 * auto-verificable — si la suma de los renglones, menos la bonificación, más el
 * IVA, más las percepciones da el total del QR, la carga está *demostrada*.
 *
 * OJO con lo que ese control NO cubre: verifica PLATA, no CANTIDADES.
 * `1 × $12.000` y `12 × $1.000` cierran idéntico, y el segundo mete el stock 12
 * veces mal en silencio. Eso se cuida aparte, comparando contra el costo
 * histórico de la presentación.
 */
import {
  BadRequestException, Body, Controller, Delete, Get, Inject, Injectable, Module,
  NotFoundException, Param, ParseIntPipe, Post, Put, Query, Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { createHash } from 'crypto';
import { IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import {
  comprobantes, configuracion, facturaArchivos, facturaLecturas, proveedores, sucursales, usuarios,
} from '../db/schema';

/* ============================================================================
 * EL QR DE LA FACTURA (RG 4892)
 * ==========================================================================*/

/**
 * Códigos de comprobante de ARCA → (tipo, letra) del sistema.
 *
 * Solo están los que emite un PROVEEDOR de mercadería. Los códigos 20x son la
 * **Factura de Crédito Electrónica MiPyME**, que muchos proveedores ya emiten
 * por defecto: sin mapearlas, una buena parte de las facturas reales caería en
 * "tipo desconocido".
 *
 * La letra **M** (51/52/53) no existe en el sistema: se mapea a A porque
 * discrimina IVA igual que una A, y queda anotado en las observaciones.
 */
const TIPOS_ARCA: Record<number, { tipo: 'factura' | 'nota_credito' | 'nota_debito'; letra: 'A' | 'B' | 'C'; nota?: string }> = {
  1: { tipo: 'factura', letra: 'A' },
  2: { tipo: 'nota_debito', letra: 'A' },
  3: { tipo: 'nota_credito', letra: 'A' },
  6: { tipo: 'factura', letra: 'B' },
  7: { tipo: 'nota_debito', letra: 'B' },
  8: { tipo: 'nota_credito', letra: 'B' },
  11: { tipo: 'factura', letra: 'C' },
  12: { tipo: 'nota_debito', letra: 'C' },
  13: { tipo: 'nota_credito', letra: 'C' },
  51: { tipo: 'factura', letra: 'A', nota: 'Factura M (se cargó como A: discrimina IVA igual).' },
  52: { tipo: 'nota_debito', letra: 'A', nota: 'Nota de débito M (se cargó como A).' },
  53: { tipo: 'nota_credito', letra: 'A', nota: 'Nota de crédito M (se cargó como A).' },
  81: { tipo: 'factura', letra: 'A', nota: 'Tique factura A.' },
  82: { tipo: 'factura', letra: 'B', nota: 'Tique factura B.' },
  83: { tipo: 'factura', letra: 'B', nota: 'Tique.' },
  201: { tipo: 'factura', letra: 'A', nota: 'Factura de Crédito Electrónica MiPyME.' },
  202: { tipo: 'nota_debito', letra: 'A', nota: 'ND de Crédito Electrónica MiPyME.' },
  203: { tipo: 'nota_credito', letra: 'A', nota: 'NC de Crédito Electrónica MiPyME.' },
  206: { tipo: 'factura', letra: 'B', nota: 'Factura de Crédito Electrónica MiPyME.' },
  207: { tipo: 'nota_debito', letra: 'B', nota: 'ND de Crédito Electrónica MiPyME.' },
  208: { tipo: 'nota_credito', letra: 'B', nota: 'NC de Crédito Electrónica MiPyME.' },
  211: { tipo: 'factura', letra: 'C', nota: 'Factura de Crédito Electrónica MiPyME.' },
  212: { tipo: 'nota_debito', letra: 'C', nota: 'ND de Crédito Electrónica MiPyME.' },
  213: { tipo: 'nota_credito', letra: 'C', nota: 'NC de Crédito Electrónica MiPyME.' },
};

export type QrFactura = {
  cuit: string;
  cuitReceptor: string;
  tipo: 'factura' | 'nota_credito' | 'nota_debito' | null;
  letra: 'A' | 'B' | 'C' | null;
  puntoVenta: string;
  numero: number | null;
  /** 'AAAA-MM-DD' tal como viene. La conversión a Date es del que la guarda. */
  fecha: string;
  total: number;
  cae: string;
  moneda: string;
  nota: string;
};

const soloDigitos = (v: any) => String(v ?? '').replace(/\D/g, '');

/**
 * PUNTO DE VENTA, SIEMPRE IGUAL — cuatro dígitos.
 *
 * No es cosmético: el índice único de comprobantes compara `punto_venta` como
 * TEXTO. El papel imprime cinco dígitos ("00115"), el sistema usa cuatro
 * ("0001") y el QR trae el número pelado (115). Sin normalizar, la misma factura
 * cargada a mano desde el papel y la que entra por la bandeja quedaban como dos
 * puntos de venta distintos — y el control de duplicados no las cruzaba.
 */
export const normalizarPuntoVenta = (v: any) => {
  const d = soloDigitos(v).replace(/^0+/, '');
  return (d || '1').padStart(4, '0');
};

/**
 * Interpreta el texto de un QR de factura. Acepta la URL completa
 * (`https://www.afip.gob.ar/fe/qr/?p=…`) o el base64 pelado.
 *
 * Devuelve `null` si el texto no es un QR de comprobante: puede ser cualquier
 * otro código que la cámara agarró de la hoja (el del banco al pie, un código
 * de barras del proveedor), y en ese caso el encabezado se carga a mano.
 */
export function interpretarQr(texto: string): QrFactura | null {
  const t = String(texto || '').trim();
  if (!t) return null;

  let b64 = t;
  const m = /[?&]p=([^&\s]+)/.exec(t);
  if (m) b64 = decodeURIComponent(m[1]);
  else if (/^https?:\/\//i.test(t)) return null;   // URL sin ?p= : no es este QR

  let datos: any;
  try {
    datos = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (!datos || typeof datos !== 'object') return null;
  // El JSON del QR siempre trae estas tres. Si no están, es otro código.
  if (datos.cuit == null || datos.tipoCmp == null || datos.nroCmp == null) return null;

  const codigo = Number(datos.tipoCmp);
  const mapeo = TIPOS_ARCA[codigo];
  const notas: string[] = [];
  if (mapeo?.nota) notas.push(mapeo.nota);
  if (!mapeo) notas.push(`Código de comprobante ${codigo} sin equivalencia: elegí el tipo a mano.`);

  const moneda = String(datos.moneda ?? 'PES');
  if (moneda && moneda !== 'PES') {
    notas.push(`La factura está en ${moneda} (cotización ${datos.ctz ?? '?'}): el total del papel no está en pesos.`);
  }

  return {
    cuit: soloDigitos(datos.cuit),
    cuitReceptor: soloDigitos(datos.nroDocRec),
    tipo: mapeo?.tipo ?? null,
    letra: mapeo?.letra ?? null,
    puntoVenta: normalizarPuntoVenta(datos.ptoVta),
    numero: Number(datos.nroCmp) || null,
    fecha: String(datos.fecha ?? '').slice(0, 10),
    total: Number(datos.importe) || 0,
    cae: String(datos.codAut ?? ''),
    moneda,
    nota: notas.join(' '),
  };
}

/* ============================================================================
 * DTOs
 * ==========================================================================*/

const MIMES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
/** Por archivo, ya decodificado. Una foto comprimida a webp pesa ~200 KB. */
const MAX_BYTES = 8 * 1024 * 1024;

class ArchivoDto {
  @IsOptional() @IsString() nombre?: string;
  /** data URL completa: `data:image/webp;base64,…` */
  @IsString() data!: string;
}

class SubirLecturaDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => ArchivoDto) archivos!: ArchivoDto[];
  /** Texto crudo del QR, leído en el navegador. Si no vino, se carga a mano. */
  @IsOptional() @IsString() qr?: string;
  @IsOptional() @IsInt() sucursalId?: number;
  @IsOptional() @IsInt() usuarioId?: number;
  @IsOptional() @IsString() observaciones?: string;
}

class PatchLecturaDto {
  @IsOptional() @IsInt() proveedorId?: number;
  @IsOptional() @IsInt() sucursalId?: number;
  @IsOptional() @IsIn(['orden_compra', 'remito', 'factura', 'nota_credito', 'nota_debito'])
  tipo?: 'orden_compra' | 'remito' | 'factura' | 'nota_credito' | 'nota_debito';
  @IsOptional() @IsIn(['A', 'B', 'C', 'X']) letra?: 'A' | 'B' | 'C' | 'X';
  @IsOptional() @IsString() puntoVenta?: string;
  @IsOptional() @IsInt() numero?: number;
  @IsOptional() @IsString() fecha?: string;
  @IsOptional() @IsNumber() total?: number;
  @IsOptional() @IsString() observaciones?: string;
}

class DescartarDto {
  @IsOptional() @IsString() motivo?: string;
}

class VincularDto {
  @IsInt() comprobanteId!: number;
}

/* ============================================================================
 * SERVICIO
 * ==========================================================================*/

/** 'AAAA-MM-DD' → Date local. Sin la hora, la fecha se corre un día para atrás. */
const fechaDeTexto = (f?: string | null) => {
  const t = String(f || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? new Date(`${t}T00:00:00`) : null;
};

@Injectable()
export class FacturasService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** El CUIT de la empresa, para poder avisar "esta factura no es nuestra". */
  private async cuitPropio(): Promise<string> {
    const [c] = await this.db.select().from(configuracion)
      .where(eq(configuracion.clave, 'empresa')).limit(1);
    return soloDigitos((c?.valor as any)?.cuit);
  }

  private decodificar(a: ArchivoDto) {
    const m = /^data:([^;]+);base64,(.+)$/.exec(String(a?.data ?? ''));
    if (!m) throw new BadRequestException('El archivo tiene que llegar como data URL en base64.');
    const [, mime, b64] = m;
    if (!MIMES.includes(mime)) {
      throw new BadRequestException(`Formato no admitido (${mime}). Se aceptan fotos JPG/PNG/WebP y PDF.`);
    }
    const bytes = Math.floor((b64.length * 3) / 4);
    if (bytes > MAX_BYTES) {
      throw new BadRequestException(`El archivo pesa ${Math.round(bytes / 1024 / 1024)} MB y el máximo es ${MAX_BYTES / 1024 / 1024} MB.`);
    }
    return { nombre: String(a?.nombre ?? '').slice(0, 160), mime, data: b64 };
  }

  /**
   * Sube UN papel (o sus páginas) y le interpreta el QR si vino.
   *
   * Todo lo que se pueda resolver solo, se resuelve acá: el proveedor por CUIT,
   * el tipo y la letra por el código de ARCA. Lo que no, queda en blanco a la
   * vista — nunca adivinado.
   */
  async subir(dto: SubirLecturaDto) {
    const archivos = (dto.archivos ?? []).map((a) => this.decodificar(a));
    if (!archivos.length) throw new BadRequestException('Subí al menos un archivo.');

    const qr = dto.qr ? interpretarQr(dto.qr) : null;
    const notas: string[] = [];
    if (dto.observaciones) notas.push(String(dto.observaciones).slice(0, 500));
    if (qr?.nota) notas.push(qr.nota);

    /* El proveedor sale del CUIT del emisor: es exacto, no es una similitud de
     * nombre. Si ese CUIT no está en el padrón, la lectura queda sin proveedor
     * y la bandeja lo marca en rojo — es una decisión, no algo para inventar. */
    let proveedorId: number | null = null;
    if (qr?.cuit) {
      // El CUIT se guarda como lo tipeó alguien ("30-71234567-9" o pelado): se
      // comparan solo los dígitos, o el match falla por los guiones.
      const [p] = await this.db.select({ id: proveedores.id }).from(proveedores)
        .where(sql`regexp_replace(${proveedores.cuit}, '[^0-9]', '', 'g') = ${qr.cuit}`).limit(1);
      proveedorId = p?.id ?? null;
      if (!proveedorId) notas.push(`El CUIT ${qr.cuit} no está en el padrón de proveedores.`);
    }

    /* "Esta factura no es nuestra": el proveedor le facturó a otra razón social.
     * Cargarla metería crédito fiscal que no corresponde. */
    if (qr?.cuitReceptor) {
      const propio = await this.cuitPropio();
      if (propio && qr.cuitReceptor !== propio) {
        notas.push(`OJO: la factura está a nombre del CUIT ${qr.cuitReceptor}, que no es el de la empresa.`);
      }
    }

    const hash = createHash('sha256').update(archivos.map((a) => a.data).join('')).digest('hex');

    const id = await this.db.transaction(async (tx) => {
      const [l] = await tx.insert(facturaLecturas).values({
        leido: !!qr,
        cuit: qr?.cuit ?? '',
        tipo: qr?.tipo ?? null,
        letra: qr?.letra ?? null,
        puntoVenta: qr?.puntoVenta ?? '',
        numero: qr?.numero ?? null,
        fecha: fechaDeTexto(qr?.fecha),
        total: qr?.total ?? 0,
        cae: qr?.cae ?? '',
        moneda: qr?.moneda ?? '',
        cuitReceptor: qr?.cuitReceptor ?? '',
        proveedorId,
        sucursalId: dto.sucursalId ?? null,
        usuarioId: dto.usuarioId ?? null,
        observaciones: notas.join(' '),
        hash,
      }).returning({ id: facturaLecturas.id });

      await tx.insert(facturaArchivos).values(
        archivos.map((a) => ({ lecturaId: l.id, nombre: a.nombre, mime: a.mime, data: a.data })),
      );
      return l.id;
    });

    return this.get(id);
  }

  /** Agrega una página a una lectura que ya existe (factura de varias hojas). */
  async agregarArchivo(lecturaId: number, dto: ArchivoDto) {
    const [l] = await this.db.select({ id: facturaLecturas.id, estado: facturaLecturas.estado })
      .from(facturaLecturas).where(eq(facturaLecturas.id, lecturaId)).limit(1);
    if (!l) throw new NotFoundException('Esa factura no existe en la bandeja.');
    if (l.estado !== 'pendiente') throw new BadRequestException('Esa factura ya se procesó.');
    const a = this.decodificar(dto);
    await this.db.insert(facturaArchivos).values({ lecturaId, ...a });
    return this.get(lecturaId);
  }

  async borrarArchivo(id: number) {
    const [a] = await this.db.select({ lecturaId: facturaArchivos.lecturaId })
      .from(facturaArchivos).where(eq(facturaArchivos.id, id)).limit(1);
    if (!a) throw new NotFoundException('Ese archivo no existe.');
    const restantes = await this.db.select({ id: facturaArchivos.id }).from(facturaArchivos)
      .where(eq(facturaArchivos.lecturaId, a.lecturaId));
    if (restantes.length <= 1) {
      throw new BadRequestException('Es la única página: descartá la factura entera si no sirve.');
    }
    await this.db.delete(facturaArchivos).where(eq(facturaArchivos.id, id));
    return this.get(a.lecturaId);
  }

  /**
   * El semáforo de una lectura. Rojo FRENA la carga, amarillo se acepta con un
   * click, verde no se muestra. La clave es que los rojos sean pocos y
   * verdaderos: si la bandeja pregunta quince cosas por factura, el admin tipea
   * más rápido a mano.
   */
  private semaforo(l: any, dup: { comprobanteId: number | null; otraLectura: number | null }) {
    const rojos: string[] = [];
    const amarillos: string[] = [];

    if (dup.comprobanteId) rojos.push('Ya hay un comprobante cargado con este número.');
    if (dup.otraLectura) amarillos.push('Este mismo archivo ya está en la bandeja.');
    if (!l.proveedorId) rojos.push('Falta decir de qué proveedor es.');
    if (!l.tipo) rojos.push('Falta el tipo de comprobante.');
    if (!l.numero) rojos.push('Falta el número.');
    if (!l.sucursalId) rojos.push('Falta la sucursal que recibió la mercadería.');
    if (!l.leido) amarillos.push('No se pudo leer el QR: el encabezado se carga a mano.');
    if (l.moneda && l.moneda !== 'PES') amarillos.push('La factura no está en pesos.');
    if (!(Number(l.total) > 0)) amarillos.push('Sin el total del papel no se puede validar que los renglones cierren.');

    return {
      rojos,
      amarillos,
      listo: rojos.length === 0,
    };
  }

  /**
   * La bandeja. El duplicado se resuelve en la misma consulta: preguntarlo fila
   * por fila era una consulta por factura.
   */
  async list(o: { estado?: string; limit?: number } = {}) {
    const estado = o.estado && ['pendiente', 'cargada', 'descartada'].includes(o.estado)
      ? (o.estado as 'pendiente' | 'cargada' | 'descartada') : null;

    const filas = await this.db.select({
      l: facturaLecturas,
      proveedorNombre: proveedores.nombre,
      sucursalNombre: sucursales.nombre,
      usuarioNombre: usuarios.nombre,
      paginas: sql<number>`(select count(*) from ${facturaArchivos} where ${facturaArchivos.lecturaId} = ${facturaLecturas.id})`,
      /* ¿Ya existe un comprobante con este número de este proveedor? Es la
       * pregunta que evita cargar dos veces la misma factura — y con papeles
       * subidos desde el celular, el duplicado deja de ser improbable. */
      dupComprobante: sql<number | null>`(
        select c.id from ${comprobantes} c
        where c.proveedor_id = ${facturaLecturas.proveedorId}
          and c.tipo = ${facturaLecturas.tipo}
          and c.punto_venta = ${facturaLecturas.puntoVenta}
          and c.numero = ${facturaLecturas.numero}
          and c.estado <> 'anulado'
        limit 1)`,
      /* Y la misma foto subida dos veces (pasa: se sube desde el celular y
       * desde la compu). Es aviso, no bloqueo. */
      dupLectura: sql<number | null>`(
        select o.id from ${facturaLecturas} o
        where o.hash = ${facturaLecturas.hash} and o.id <> ${facturaLecturas.id}
          and o.estado = 'pendiente'
        limit 1)`,
    })
      .from(facturaLecturas)
      .leftJoin(proveedores, eq(proveedores.id, facturaLecturas.proveedorId))
      .leftJoin(sucursales, eq(sucursales.id, facturaLecturas.sucursalId))
      .leftJoin(usuarios, eq(usuarios.id, facturaLecturas.usuarioId))
      .where(estado ? eq(facturaLecturas.estado, estado) : undefined)
      .orderBy(desc(facturaLecturas.subidoEn))
      .limit(Math.min(Math.max(Number(o.limit) || 200, 1), 500));

    return filas.map((f: any) => ({
      ...f.l,
      proveedorNombre: f.proveedorNombre ?? '',
      sucursalNombre: f.sucursalNombre ?? '',
      usuarioNombre: f.usuarioNombre ?? '',
      paginas: Number(f.paginas) || 0,
      duplicadoDe: f.dupComprobante ?? null,
      mismoArchivo: f.dupLectura ?? null,
      ...this.semaforo(f.l, { comprobanteId: f.dupComprobante, otraLectura: f.dupLectura }),
    }));
  }

  /** Cuántas esperan: alimenta el número del menú. */
  async pendientes() {
    const [r] = await this.db.select({ n: sql<number>`count(*)` }).from(facturaLecturas)
      .where(eq(facturaLecturas.estado, 'pendiente'));
    return { pendientes: Number(r?.n) || 0 };
  }

  async get(id: number) {
    const [l] = await this.db.select().from(facturaLecturas).where(eq(facturaLecturas.id, id)).limit(1);
    if (!l) throw new NotFoundException('Esa factura no existe en la bandeja.');

    /* Los bytes NUNCA viajan en el detalle: solo la lista de páginas, y cada
     * una se pide por su URL cuando alguien la mira. */
    const archivos = await this.db.select({
      id: facturaArchivos.id, nombre: facturaArchivos.nombre, mime: facturaArchivos.mime,
    }).from(facturaArchivos).where(eq(facturaArchivos.lecturaId, id)).orderBy(asc(facturaArchivos.id));

    const [prov] = l.proveedorId
      ? await this.db.select({ nombre: proveedores.nombre }).from(proveedores).where(eq(proveedores.id, l.proveedorId)).limit(1)
      : [null as any];

    const [dup] = l.proveedorId && l.numero && l.tipo
      ? await this.db.select({ id: comprobantes.id }).from(comprobantes).where(and(
        eq(comprobantes.proveedorId, l.proveedorId),
        eq(comprobantes.tipo, l.tipo),
        eq(comprobantes.puntoVenta, l.puntoVenta),
        eq(comprobantes.numero, l.numero),
        ne(comprobantes.estado, 'anulado'),
      )).limit(1)
      : [null as any];

    return {
      ...l,
      proveedorNombre: prov?.nombre ?? '',
      archivos,
      duplicadoDe: dup?.id ?? null,
      ...this.semaforo(l, { comprobanteId: dup?.id ?? null, otraLectura: null }),
    };
  }

  /** El papel, servido con su tipo. Es lo que se mira al lado del formulario. */
  async verArchivo(id: number, res: Response) {
    const [a] = await this.db.select().from(facturaArchivos).where(eq(facturaArchivos.id, id)).limit(1);
    if (!a) throw new NotFoundException('Ese archivo no existe.');
    res.setHeader('Content-Type', a.mime);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.end(Buffer.from(a.data, 'base64'));
  }

  /**
   * Corrige a mano lo que el QR no pudo dar (o dio mal). Cada corrección es
   * también la que hace que la próxima factura del mismo proveedor salga mejor.
   */
  async patch(id: number, dto: PatchLecturaDto) {
    const [l] = await this.db.select().from(facturaLecturas).where(eq(facturaLecturas.id, id)).limit(1);
    if (!l) throw new NotFoundException('Esa factura no existe en la bandeja.');
    if (l.estado !== 'pendiente') throw new BadRequestException('Esa factura ya se procesó.');

    const patch: any = {};
    if (dto.proveedorId !== undefined) patch.proveedorId = dto.proveedorId || null;
    if (dto.sucursalId !== undefined) patch.sucursalId = dto.sucursalId || null;
    if (dto.tipo !== undefined) patch.tipo = dto.tipo;
    if (dto.letra !== undefined) patch.letra = dto.letra;
    if (dto.puntoVenta !== undefined) patch.puntoVenta = normalizarPuntoVenta(dto.puntoVenta);
    if (dto.numero !== undefined) patch.numero = dto.numero || null;
    if (dto.fecha !== undefined) patch.fecha = fechaDeTexto(dto.fecha);
    if (dto.total !== undefined) patch.total = Number(dto.total) || 0;
    if (dto.observaciones !== undefined) patch.observaciones = String(dto.observaciones).slice(0, 500);

    if (Object.keys(patch).length) {
      await this.db.update(facturaLecturas).set(patch).where(eq(facturaLecturas.id, id));
    }
    return this.get(id);
  }

  /** No correspondía: duplicada, ilegible, o no era nuestra. El papel queda. */
  async descartar(id: number, dto: DescartarDto) {
    const [l] = await this.db.select().from(facturaLecturas).where(eq(facturaLecturas.id, id)).limit(1);
    if (!l) throw new NotFoundException('Esa factura no existe en la bandeja.');
    if (l.estado === 'cargada') throw new BadRequestException('Esa factura ya se cargó: no se descarta.');
    const motivo = String(dto?.motivo ?? '').slice(0, 300);
    await this.db.update(facturaLecturas).set({
      estado: 'descartada',
      observaciones: motivo ? `${l.observaciones} · Descartada: ${motivo}`.trim() : l.observaciones,
    }).where(eq(facturaLecturas.id, id));
    return this.get(id);
  }

  /** Volver a la bandeja algo descartado por error. */
  async recuperar(id: number) {
    const [l] = await this.db.select().from(facturaLecturas).where(eq(facturaLecturas.id, id)).limit(1);
    if (!l) throw new NotFoundException('Esa factura no existe en la bandeja.');
    if (l.estado !== 'descartada') throw new BadRequestException('Solo se recupera algo descartado.');
    await this.db.update(facturaLecturas).set({ estado: 'pendiente' }).where(eq(facturaLecturas.id, id));
    return this.get(id);
  }

  /**
   * "Esta factura ya la había cargado a mano."
   *
   * En vez de descartar el papel y perderlo, se engancha al comprobante que ya
   * existe: la foto queda guardada donde tiene que estar. Es la salida útil
   * para la mitad de los duplicados.
   */
  async vincular(id: number, dto: VincularDto) {
    const [l] = await this.db.select().from(facturaLecturas).where(eq(facturaLecturas.id, id)).limit(1);
    if (!l) throw new NotFoundException('Esa factura no existe en la bandeja.');
    if (l.estado === 'cargada') throw new BadRequestException('Esa factura ya está enganchada a un comprobante.');
    const [c] = await this.db.select({
      id: comprobantes.id, proveedorId: comprobantes.proveedorId, tipo: comprobantes.tipo,
      puntoVenta: comprobantes.puntoVenta, numero: comprobantes.numero,
    }).from(comprobantes).where(eq(comprobantes.id, dto.comprobanteId)).limit(1);
    if (!c) throw new NotFoundException('Ese comprobante no existe.');

    /*
     * TIENE QUE SER DEL MISMO PROVEEDOR.
     *
     * Sin este control se podía enganchar el papel de un proveedor al
     * comprobante de otro, y el daño era doble: la lectura salía de la bandeja
     * marcada como `cargada` SIN haberse cargado nunca (la factura simplemente
     * desaparecía del trabajo pendiente), y el botón "Ver la factura" del
     * comprobante ajeno mostraba el papel equivocado — es decir, el respaldo de
     * un comprobante pasaba a ser la factura de otra empresa.
     */
    if (l.proveedorId && c.proveedorId !== l.proveedorId) {
      throw new BadRequestException(
        'Ese comprobante es de otro proveedor: el papel se engancha al comprobante del proveedor que lo emitió.',
      );
    }
    if (!l.proveedorId) {
      throw new BadRequestException(
        'Primero decí de qué proveedor es el papel: sin eso no se puede verificar que el comprobante sea el correcto.',
      );
    }

    /* El número no bloquea —el papel puede ser la segunda hoja de una factura
     * cargada con otro número de por medio, o el número puede estar mal
     * tipeado— pero queda anotado: es la pista para cuando algo no cuadre. */
    const distinto = l.numero && c.numero && l.numero !== c.numero;
    if (distinto) {
      await this.db.update(facturaLecturas).set({
        observaciones: `${l.observaciones} · Vinculada al ${c.tipo} ${c.puntoVenta}-${c.numero} con número distinto al del papel (${l.numero}).`.trim(),
      }).where(eq(facturaLecturas.id, id));
    }

    await this.db.update(facturaLecturas)
      .set({ estado: 'cargada', comprobanteId: c.id })
      .where(eq(facturaLecturas.id, id));
    return this.get(id);
  }

  /** Los papeles de un comprobante ya cargado, para el botón "Ver la factura". */
  async archivosDeComprobante(comprobanteId: number) {
    const lecturas = await this.db.select({ id: facturaLecturas.id }).from(facturaLecturas)
      .where(eq(facturaLecturas.comprobanteId, comprobanteId));
    if (!lecturas.length) return [];
    return this.db.select({
      id: facturaArchivos.id, nombre: facturaArchivos.nombre, mime: facturaArchivos.mime,
    }).from(facturaArchivos)
      .where(inArray(facturaArchivos.lecturaId, lecturas.map((x: any) => x.id)))
      .orderBy(asc(facturaArchivos.id));
  }
}

/* ============================================================================
 * CONTROLADOR
 * ==========================================================================*/

@Controller('facturas')
export class FacturasController {
  constructor(private readonly svc: FacturasService) {}

  @Get('lecturas') list(@Query('estado') estado?: string, @Query('limit') limit?: string) {
    return this.svc.list({ estado, limit: limit ? Number(limit) : undefined });
  }

  @Get('pendientes') pendientes() {
    return this.svc.pendientes();
  }

  // Antes de `lecturas/:id` no hace falta orden especial (prefijos distintos),
  // pero sí que el archivo se sirva por su propia ruta: es una URL de <img>.
  @Get('archivos/:id') archivo(@Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    return this.svc.verArchivo(id, res);
  }

  @Get('comprobante/:id/archivos') deComprobante(@Param('id', ParseIntPipe) id: number) {
    return this.svc.archivosDeComprobante(id);
  }

  @Get('lecturas/:id') get(@Param('id', ParseIntPipe) id: number) {
    return this.svc.get(id);
  }

  @Post('lecturas') subir(@Body() dto: SubirLecturaDto) {
    return this.svc.subir(dto);
  }

  @Post('lecturas/:id/archivos') agregar(@Param('id', ParseIntPipe) id: number, @Body() dto: ArchivoDto) {
    return this.svc.agregarArchivo(id, dto);
  }

  @Delete('archivos/:id') borrarArchivo(@Param('id', ParseIntPipe) id: number) {
    return this.svc.borrarArchivo(id);
  }

  @Put('lecturas/:id') patch(@Param('id', ParseIntPipe) id: number, @Body() dto: PatchLecturaDto) {
    return this.svc.patch(id, dto);
  }

  @Post('lecturas/:id/descartar') descartar(@Param('id', ParseIntPipe) id: number, @Body() dto: DescartarDto) {
    return this.svc.descartar(id, dto);
  }

  @Post('lecturas/:id/recuperar') recuperar(@Param('id', ParseIntPipe) id: number) {
    return this.svc.recuperar(id);
  }

  @Post('lecturas/:id/vincular') vincular(@Param('id', ParseIntPipe) id: number, @Body() dto: VincularDto) {
    return this.svc.vincular(id, dto);
  }
}

@Module({
  controllers: [FacturasController],
  providers: [FacturasService],
  exports: [FacturasService],
})
export class FacturasModule {}
