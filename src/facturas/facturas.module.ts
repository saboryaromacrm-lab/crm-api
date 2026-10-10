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
 *    existen en el papel del proveedor. Los lee la IA (0153, `ia/`): PDF,
 *    fotos y escaneos; el encabezado que no dio el QR también sale de ahí.
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
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Inject, Injectable, Module,
  NotFoundException, Param, ParseIntPipe, Post, Put, Query, Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { createHash } from 'crypto';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, MaxLength, Min, ValidateNested,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';
import { and, asc, desc, eq, getTableColumns, inArray, ne, sql } from 'drizzle-orm';
import { Auth, Permiso, type Sesion } from '../auth/auth.decoradores';
import { esJefe } from '../auth/auth.guard';
import { mimeReal, nombreSeguro } from '../common/archivos';
import { DRIZZLE, Database } from '../db/drizzle';
import {
  comprobantes, configuracion, facturaArchivos, facturaLecturas, proveedores, sucursales, usuarios,
} from '../db/schema';
import { TIPOS_ARCA, fechaDeTexto, normalizarPuntoVenta, soloDigitos } from './comun';
import { FacturasIaService } from './ia/ia.service';

/* ============================================================================
 * EL QR DE LA FACTURA (RG 4892)
 * ==========================================================================*/


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

/**
 * Por archivo, ya decodificado.
 *
 * Tiene que quedar POR DEBAJO del límite del body de `main.ts` (4 MB), o el tope
 * no se alcanza nunca y el mensaje de error promete algo que no pasa: la request
 * muere antes con un 413 pelado. En base64 los bytes crecen un 33%, así que
 * 2,5 MB de archivo son ~3,4 MB de JSON — el margen que queda es para el resto
 * del cuerpo. La pantalla comprime a ~200 KB, así que esto es solo el techo.
 */
const MAX_BYTES = Math.floor(2.5 * 1024 * 1024);
/** Páginas por factura. Una factura larga tiene 3 o 4 hojas, no 200. */
const MAX_PAGINAS = 20;

/*
 * Las FIRMAS de archivo (qué es el binario según sus bytes, no según lo que
 * dijo el cliente) viven en `common/archivos.ts`: las comparte con el módulo
 * Web, que sube y sirve las imágenes del sitio con el mismo riesgo.
 */

class ArchivoDto {
  @IsOptional() @IsString() @MaxLength(160) nombre?: string;
  /** data URL completa: `data:image/webp;base64,…` */
  @IsString() data!: string;
}

class SubirLecturaDto {
  @IsArray() @ArrayMaxSize(MAX_PAGINAS) @ValidateNested({ each: true }) @Type(() => ArchivoDto)
  archivos!: ArchivoDto[];
  /** Texto crudo del QR, leído en el navegador. Si no vino, se carga a mano. */
  @IsOptional() @IsString() qr?: string;
  @IsOptional() @IsInt() sucursalId?: number;
  @IsOptional() @IsInt() usuarioId?: number;
  @IsOptional() @IsString() observaciones?: string;
}

class PatchLecturaDto {
  @IsOptional() @IsInt() proveedorId?: number;
  @IsOptional() @IsInt() sucursalId?: number;
  /* `liquidacion` entra acá porque el papel de la mitad no facturada también se
   * puede subir a la bandeja y clasificar a mano — no trae QR, obviamente. */
  @IsOptional() @IsIn(['orden_compra', 'remito', 'factura', 'liquidacion', 'nota_credito', 'nota_debito'])
  tipo?: 'orden_compra' | 'remito' | 'factura' | 'liquidacion' | 'nota_credito' | 'nota_debito';
  @IsOptional() @IsIn(['A', 'B', 'C', 'X']) letra?: 'A' | 'B' | 'C' | 'X';
  @IsOptional() @IsString() puntoVenta?: string;
  @IsOptional() @IsInt() @Max(99_999_999, { message: 'El número del comprobante tiene hasta 8 cifras, sin el punto de venta.' }) numero?: number;
  @IsOptional() @IsString() fecha?: string;
  /* El total del papel es la prueba de que los renglones cierran: en negativo no
   * prueba nada, y con 0 el semáforo ya avisa que no se puede validar. */
  @IsOptional() @IsNumber() @Min(0, { message: 'El total del papel no puede ser negativo.' }) total?: number;
  @IsOptional() @IsString() @MaxLength(500) observaciones?: string;
}

class DescartarDto {
  @IsOptional() @IsString() motivo?: string;
}

class VincularDto {
  @IsInt() comprobanteId!: number;
}

class IaConfigDto {
  @IsOptional() @IsNumber() @Min(0) @Max(1000) topeMensualUsd?: number;
  @IsOptional() @IsBoolean() leerAlSubir?: boolean;
}

class EncolarDto {
  /** Las facturas a leer; vacío = todas las pendientes sin leer. */
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsInt({ each: true }) ids?: number[];
}

/* ============================================================================
 * SERVICIO
 * ==========================================================================*/


@Injectable()
export class FacturasService {
  constructor(@Inject(DRIZZLE) private readonly db: Database, private readonly ia: FacturasIaService) {}

  /** El CUIT de la empresa, para poder avisar "esta factura no es nuestra". */
  private async cuitPropio(): Promise<string> {
    const [c] = await this.db.select().from(configuracion)
      .where(eq(configuracion.clave, 'empresa')).limit(1);
    return soloDigitos((c?.valor as any)?.cuit);
  }

  private decodificar(a: ArchivoDto) {
    const m = /^data:([^;]+);base64,(.+)$/.exec(String(a?.data ?? ''));
    if (!m) throw new BadRequestException('El archivo tiene que llegar como data URL en base64.');
    const [, declarado, b64] = m;
    if (!MIMES.includes(declarado)) {
      throw new BadRequestException(`Formato no admitido (${declarado}). Se aceptan fotos JPG/PNG/WebP y PDF.`);
    }

    const buf = Buffer.from(b64, 'base64');
    if (buf.length > MAX_BYTES) {
      const mb = (n: number) => (n / 1024 / 1024).toFixed(1).replace('.', ',');
      throw new BadRequestException(`El archivo pesa ${mb(buf.length)} MB y el máximo es ${mb(MAX_BYTES)} MB.`);
    }

    /*
     * EL MIME SALE DE LOS BYTES, no de lo que dijo el cliente.
     *
     * Se guarda `real`, no `declarado`. Si no coinciden se rechaza en vez de
     * corregir en silencio: un archivo cuyo contenido no es lo que dice ser no
     * es un error de tipeo, y el papel de una factura no llega mal rotulado por
     * accidente desde nuestra propia pantalla.
     */
    const real = mimeReal(buf);
    if (!real) {
      throw new BadRequestException('Ese archivo no es una foto JPG/PNG/WebP ni un PDF: no se pudo reconocer el contenido.');
    }
    if (real !== declarado) {
      throw new BadRequestException(`El archivo dice ser ${declarado} pero su contenido es ${real}.`);
    }

    return { nombre: nombreSeguro(String(a?.nombre ?? ''), 'factura'), mime: real, data: b64 };
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

    // A leer con la IA, en segundo plano (si está configurada y encendida).
    await this.ia.alSubir(id);
    return this.get(id);
  }

  /** Agrega una página a una lectura que ya existe (factura de varias hojas). */
  async agregarArchivo(lecturaId: number, dto: ArchivoDto) {
    const [l] = await this.db.select({ id: facturaLecturas.id, estado: facturaLecturas.estado })
      .from(facturaLecturas).where(eq(facturaLecturas.id, lecturaId)).limit(1);
    if (!l) throw new NotFoundException('Esa factura no existe en la bandeja.');
    if (l.estado !== 'pendiente') throw new BadRequestException('Esa factura ya se procesó.');

    /* Tope de páginas: sin esto la tabla crece sin techo agregando de a una, y el
     * límite del body no lo frena porque cada request es chica. */
    const [n] = await this.db.select({ n: sql<number>`count(*)` })
      .from(facturaArchivos).where(eq(facturaArchivos.lecturaId, lecturaId));
    if (Number(n?.n) >= MAX_PAGINAS) {
      throw new BadRequestException(`Esa factura ya tiene ${MAX_PAGINAS} páginas: si son más, cargala como dos.`);
    }

    const a = this.decodificar(dto);
    await this.db.insert(facturaArchivos).values({ lecturaId, ...a });
    await this.ia.invalidar(lecturaId); // otra página: lo leído ya no es la factura entera
    return this.get(lecturaId);
  }

  async borrarArchivo(id: number) {
    const [a] = await this.db.select({ lecturaId: facturaArchivos.lecturaId })
      .from(facturaArchivos).where(eq(facturaArchivos.id, id)).limit(1);
    if (!a) throw new NotFoundException('Ese archivo no existe.');
    /*
     * UNA VEZ CARGADA, EL PAPEL NO SE TOCA MÁS.
     *
     * Este borrado es DURO: la fila se va y con ella la imagen. Mientras la
     * factura está en la bandeja tiene sentido —se sacó una foto de más, se
     * fotografió la hoja equivocada—, pero cuando ya está cargada esa imagen es
     * el respaldo del comprobante que quedó en la contabilidad. Borrarla deja el
     * asiento sin el papel que lo justifica, y no hay vuelta atrás.
     */
    const [lec] = await this.db.select({ estado: facturaLecturas.estado })
      .from(facturaLecturas).where(eq(facturaLecturas.id, a.lecturaId)).limit(1);
    if (lec?.estado === 'cargada') {
      throw new BadRequestException(
        'Esa factura ya está cargada: sus páginas son el respaldo del comprobante y no se borran. '
        + 'Si el comprobante está mal, anulalo desde Facturación.',
      );
    }
    const restantes = await this.db.select({ id: facturaArchivos.id }).from(facturaArchivos)
      .where(eq(facturaArchivos.lecturaId, a.lecturaId));
    if (restantes.length <= 1) {
      throw new BadRequestException('Es la única página: descartá la factura entera si no sirve.');
    }
    await this.db.delete(facturaArchivos).where(eq(facturaArchivos.id, id));
    await this.ia.invalidar(a.lecturaId);
    return this.get(a.lecturaId);
  }

  /**
   * El semáforo de una lectura. Rojo FRENA la carga, amarillo se acepta con un
   * click, verde no se muestra. La clave es que los rojos sean pocos y
   * verdaderos: si la bandeja pregunta quince cosas por factura, el admin tipea
   * más rápido a mano.
   */
  private semaforo(l: any, dup: { comprobanteId: number | null; otraLectura: number | null }, paginas: number | null = null) {
    const rojos: string[] = [];
    const amarillos: string[] = [];

    if (dup.comprobanteId) rojos.push('Ya hay un comprobante cargado con este número.');
    if (dup.otraLectura) amarillos.push('Este mismo archivo ya está en la bandeja.');
    if (!l.proveedorId) rojos.push('Falta decir de qué proveedor es.');
    if (!l.tipo) rojos.push('Falta el tipo de comprobante.');
    if (!l.numero) rojos.push('Falta el número.');
    if (!l.sucursalId) rojos.push('Falta la sucursal que recibió la mercadería.');
    /* Sin QR, el encabezado lo completa la IA al leerla (0153): solo se avisa mientras no lo hizo. */
    if (!l.leido && l.iaEstado !== 'lista') amarillos.push('No se pudo leer el QR: el encabezado sale de lo que lea la IA (o se carga a mano).');
    if (l.moneda && l.moneda !== 'PES') amarillos.push('La factura no está en pesos.');
    if (!(Number(l.total) > 0)) amarillos.push('Sin el total del papel no se puede validar que los renglones cierren.');
    /* Volvió a la bandeja porque se anuló su comprobante, y el papel se había
       borrado al cargarla: para leerla de nuevo hay que volver a subirlo. */
    if (paginas === 0 && l.estado === 'pendiente') {
      amarillos.push('El archivo se borró cuando se cargó: si hay que procesarla de nuevo, agregá la factura otra vez.');
    }

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

    const { ia: _ia, ...columnas } = getTableColumns(facturaLecturas);
    const filas = await this.db.select({
      l: columnas,
      /* De la lectura con IA viaja solo el resumen: el detalle lo pide el alta. */
      iaResumen: sql<any>`case when ${facturaLecturas.ia} is null then null else jsonb_build_object(
        'cierra', ${facturaLecturas.ia}->'control'->'cierra', 'costoUsd', ${facturaLecturas.ia}->'costoUsd',
        'modelo', ${facturaLecturas.ia}->'modelo', 'error', ${facturaLecturas.ia}->'error',
        'renglones', jsonb_array_length(coalesce(${facturaLecturas.ia}->'renglones', '[]'::jsonb)),
        'problemas', ${facturaLecturas.ia}->'control'->'problemas') end`,
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
      iaResumen: f.iaResumen ?? null,
      proveedorNombre: f.proveedorNombre ?? '',
      sucursalNombre: f.sucursalNombre ?? '',
      usuarioNombre: f.usuarioNombre ?? '',
      paginas: Number(f.paginas) || 0,
      duplicadoDe: f.dupComprobante ?? null,
      /* `dupLectura` NO viaja como campo propio: nadie lo leía. Lo que sí se usa
       * es el amarillo que sale de él, acá abajo. */
      ...this.semaforo(f.l, { comprobanteId: f.dupComprobante, otraLectura: f.dupLectura }, Number(f.paginas) || 0),
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

    /* Las tres consultas que siguen no dependen entre sí, así que van juntas: en
     * serie eran tres viajes a la base, y `subir` termina llamando acá.
     *
     * Los bytes NUNCA viajan en el detalle: solo la lista de páginas, y cada una
     * se pide por su URL cuando alguien la mira. */
    const [archivos, provs, dups] = await Promise.all([
      this.db.select({
        id: facturaArchivos.id, nombre: facturaArchivos.nombre, mime: facturaArchivos.mime,
      }).from(facturaArchivos).where(eq(facturaArchivos.lecturaId, id)).orderBy(asc(facturaArchivos.id)),

      l.proveedorId
        ? this.db.select({ nombre: proveedores.nombre }).from(proveedores).where(eq(proveedores.id, l.proveedorId)).limit(1)
        : Promise.resolve([] as Array<{ nombre: string }>),

      l.proveedorId && l.numero && l.tipo
        ? this.db.select({ id: comprobantes.id }).from(comprobantes).where(and(
          eq(comprobantes.proveedorId, l.proveedorId),
          eq(comprobantes.tipo, l.tipo),
          eq(comprobantes.puntoVenta, l.puntoVenta),
          eq(comprobantes.numero, l.numero),
          ne(comprobantes.estado, 'anulado'),
        )).limit(1)
        : Promise.resolve([] as Array<{ id: number }>),
    ]);
    const prov = provs[0];
    const dup = dups[0];

    return {
      ...l,
      proveedorNombre: prov?.nombre ?? '',
      archivos,
      duplicadoDe: dup?.id ?? null,
      ...this.semaforo(l, { comprobanteId: dup?.id ?? null, otraLectura: null }, archivos.length),
    };
  }

  /** El papel, servido con su tipo. Es lo que se mira al lado del formulario. */
  async verArchivo(id: number, res: Response) {
    const [a] = await this.db.select().from(facturaArchivos).where(eq(facturaArchivos.id, id)).limit(1);
    if (!a) throw new NotFoundException('Ese archivo no existe.');
    res.setHeader('Content-Type', a.mime);
    /*
     * `nosniff` corta el olfateo de contenido: sin él, un navegador puede decidir
     * que el archivo "en realidad" es otra cosa y tratarlo como tal, y ahí un
     * mime verificado al subir deja de servir de nada. Y `inline` con nombre
     * explícito para que se vea al lado del formulario (es lo que se quiere) pero
     * con un nombre saneado, no el que vino en el pedido.
     */
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `inline; filename="${nombreSeguro(a.nombre, 'factura')}"`);
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

    await this.db.transaction(async (tx) => {
      await tx.update(facturaLecturas)
        .set({ estado: 'cargada', comprobanteId: c.id })
        .where(eq(facturaLecturas.id, id));
      // Cargada = el papel ya no hace falta (pedido del dueño, 28/9/2026).
      await tx.delete(facturaArchivos).where(eq(facturaArchivos.lecturaId, id));
    });
    return this.get(id);
  }

  /* ====================================================================
   * EL PAPEL NO SE GUARDA UNA VEZ CARGADO (28/9/2026, pedido del dueño)
   * ====================================================================
   * La factura ya queda en el sistema como comprobante: guardar además el
   * archivo solo engorda la base y los respaldos. Al cargarla se borra (ver
   * `comprobantes.module` y `vincular`); lo que ya estaba guardado de antes
   * se libera desde acá, a pedido y con confirmación en pantalla.
   */
  async espacioCargadas() {
    const r = await this.db.execute(sql`
      SELECT count(*)::int AS archivos, coalesce(sum(length(a.data)), 0)::bigint AS base64
      FROM factura_archivos a JOIN factura_lecturas l ON l.id = a.lectura_id
      WHERE l.estado = 'cargada'
    `);
    const f: any = r.rows[0] ?? {};
    // El base64 ocupa 4/3 del archivo real.
    return { archivos: Number(f.archivos) || 0, bytes: Math.round((Number(f.base64) || 0) * 0.75) };
  }

  async liberarCargadas() {
    const antes = await this.espacioCargadas();
    await this.db.execute(sql`
      DELETE FROM factura_archivos a USING factura_lecturas l
      WHERE l.id = a.lectura_id AND l.estado = 'cargada'
    `);
    return { ok: true, borrados: antes.archivos, bytes: antes.bytes };
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

/*
 * LA BANDEJA DE PAPELES, ENTERA, PIDE `compras.lecturas`.
 *
 * No la consume ninguna otra pantalla (el contador del sidebar sale del
 * arranque del inventario, que lo calcula solo), asi que cerrarla completa no
 * le saca nada a nadie. Sin esto, cualquier sesion podia hacer desaparecer del
 * trabajo pendiente la factura que subio la cajera, pisar el encabezado que
 * vino del QR, o BORRAR una pagina escaneada de una factura ya cargada.
 */
@Controller('facturas')
@Permiso('compras.lecturas')
export class FacturasController {
  constructor(private readonly svc: FacturasService, private readonly ia: FacturasIaService) {}

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

  /* ---------------- LA LECTURA CON IA (0153): solo superadmin y admin ---------------- */

  @Get('ia/estado') iaEstado(@Auth() s: Sesion) { soloJefe(s); return this.ia.estado(); }
  @Put('ia/config') iaConfig(@Auth() s: Sesion, @Body() dto: IaConfigDto) { soloJefe(s); return this.ia.guardarConfig(dto); }
  /** Leer (o volver a leer) estas facturas; sin ids, todas las pendientes sin leer. */
  @Post('ia/leer') iaLeer(@Auth() s: Sesion, @Body() dto: EncolarDto) {
    soloJefe(s);
    return dto.ids?.length ? this.ia.encolar(dto.ids) : this.ia.encolarPendientes();
  }
  /** Lo que el alta precarga: renglones con su producto, candidatos y sugerencias. */
  @Get('lecturas/:id/propuesta') iaPropuesta(@Auth() s: Sesion, @Param('id', ParseIntPipe) id: number) {
    soloJefe(s);
    return this.ia.propuesta(id);
  }
  /** Que la IA elija entre los candidatos de los renglones sin producto (queda como sugerencia). */
  @Post('lecturas/:id/elegir') iaElegir(@Auth() s: Sesion, @Param('id', ParseIntPipe) id: number) {
    soloJefe(s);
    return this.ia.elegir(id, s.usuarioId);
  }

  /** Cuánto ocupan todavía los papeles de facturas ya cargadas, y liberarlo. */
  @Get('espacio') espacio() {
    return this.svc.espacioCargadas();
  }

  @Post('liberar') liberar() {
    return this.svc.liberarCargadas();
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

/** La IA gasta plata: además de la bandeja, solo superadmin y admin (decisión del dueño). */
function soloJefe(s: Sesion) {
  if (!esJefe(s)) throw new ForbiddenException('La lectura con IA es solo para el superadmin y el admin.');
}

@Module({
  controllers: [FacturasController],
  providers: [FacturasService, FacturasIaService],
  exports: [FacturasService],
})
export class FacturasModule {}
