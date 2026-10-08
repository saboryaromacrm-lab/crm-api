import {
  Body, Controller, Get, Inject, Injectable, Module, BadRequestException,
  ForbiddenException, NotFoundException, Param, ParseIntPipe, Post, Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayNotEmpty, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength,
  Min, ValidateNested,
} from 'class-validator';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import {
  comprobantes, comprobanteItems, comprobantePercepciones, facturaArchivos, facturaLecturas, proveedorArticulos,
  productoProveedores, productos, proveedores, proveedorCompromisos, proveedorEcheqs,
  proveedorImputaciones, proveedorPagos, sucursales, usuarios, productoProveedorCostos, presentaciones,
} from '../db/schema';
/* "Factura A 0115-00193307" — la misma etiqueta en la tabla, el detalle, el error
 * y ahora también en Pagos. Vive en `common` y no acá porque `pagos` la necesita
 * y este módulo ya importa de `pagos`: exportarla desde acá cerraba el ciclo. */
import { Auth, Permiso, type Sesion } from '../auth/auth.decoradores';
import { ALICUOTAS_IVA, ALICUOTAS_TEXTO } from '../common/iva';
import { esJefe, tienePermiso } from '../auth/auth.guard';
import { etiquetaDoc } from '../common/documentos';
import { exigirFueraDeConciliado } from '../common/conciliacion';
import { ajustePorAnulacion, fechaDeCuenta } from '../cafeteria/cuenta';
import { normalizarPuntoVenta } from '../facturas/facturas.module';
import { InventarioModule } from '../inventario/inventario.module';
import { InventarioService } from '../inventario/inventario.service';
import { costosFormato } from '../inventario/pricing';
import { PreciosModule, PreciosService, aplicarCambioCosto } from '../precios/precios.module';
import { PagosModule, PagosProveedorService } from '../pagos/pagos.module';

const TIPOS = ['orden_compra', 'remito', 'factura', 'liquidacion', 'nota_credito', 'nota_debito'] as const;

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/** Para que los mensajes de error se lean como los diría una persona. */
const NOMBRE_TIPO: Record<(typeof TIPOS)[number], string> = {
  orden_compra: 'la orden de compra',
  remito: 'el remito',
  factura: 'la factura',
  liquidacion: 'la liquidación',
  nota_credito: 'la nota de crédito',
  nota_debito: 'la nota de débito',
};

/*
 * QUÉ HACE CADA TIPO — las tres preguntas que definen el circuito.
 * ============================================================================
 *                  ¿mueve stock?   ¿genera deuda?   ¿es fiscal?
 *   orden_compra         no              no             no
 *   remito          sí (recepción)       no             no
 *   factura         sí (recepción)       sí             SÍ
 *   liquidacion     sí (recepción)       sí             no      ← la mitad negra
 *   nota_credito    sí (devolución)   resta            SÍ
 *   nota_debito          no            suma            SÍ
 *
 * LA LIQUIDACIÓN aparece en las tres listas de "genera deuda" y "mueve stock" y
 * en NINGUNA de las fiscales. Las listas son explícitas a propósito —se leen y
 * se auditan— pero eso significa que **un tipo nuevo hay que agregarlo en todas**
 * o se cuela un documento que mueve mercadería y no aparece en lo que se debe.
 * Están todas marcadas con el comentario "LISTA DE TIPOS" para poder encontrarlas.
 */

/** Un comprobante no fiscal no discrimina IVA ni lleva percepciones. */
const esFiscal = (tipo: string) => tipo !== 'liquidacion';

/** Una percepción del pie de la factura (RG 5329, IIBB…). */
class PercepcionDto {
  @IsString() nombre!: string;
  @IsOptional() @IsNumber() alicuota?: number;
  @IsOptional() @IsIn(['neto', 'total']) base?: 'neto' | 'total';
  /** El del papel. Si no viene, se calcula con la alícuota. */
  @IsOptional() @IsNumber() importe?: number;
  /** De qué impuesto es (0132): iva | iibb | otro (viene de la del proveedor); '' = por el nombre. */
  @IsOptional() @IsString() tipo?: string;
}

/*
 * TOPES Y PISOS DE LOS IMPORTES DEL RENGLÓN.
 *
 * Estaban con `@IsNumber()` pelado, y eso deja pasar cualquier cosa: `iva: 300`
 * entraba tal cual e inflaba el total y el libro de IVA compras; `descuento:
 * 150` dejaba el renglón en negativo. El `@IsNumber()` de class-validator sí
 * rechaza NaN e Infinity por defecto, así que lo que faltaba era el rango.
 *
 * Los máximos son absurdamente altos a propósito: no están para juzgar una
 * compra grande, están para que un número imposible no llegue a la base.
 */
class ComprobanteItemDto {
  @IsInt() productoId!: number;
  @IsOptional() @IsInt() presentacionId?: number;
  @IsNumber() @Min(0) @Max(1_000_000) cantidad!: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1_000_000_000) costoUnitario?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) descuento?: number;
  /** Cerrada a la lista de la ley (`common/iva`), igual que en el producto. */
  @IsOptional() @IsNumber() @IsIn(ALICUOTAS_IVA as unknown as number[], {
    message: `Alícuota de IVA inválida. Las válidas son: ${ALICUOTAS_TEXTO}%.`,
  }) iva?: number;
  /**
   * El código del artículo COMO LO IMPRIME LA FACTURA del proveedor, cuando el
   * renglón vino de la lectura del PDF. No se guarda en el ítem: alimenta el
   * mapeo aprendido (proveedor, código) → producto, que es lo que hace que la
   * próxima factura reconozca el artículo sola.
   */
  @IsOptional() @IsString() @MaxLength(40) codigoProveedor?: string;
  /** La descripción del papel, para poder auditar el mapeo después. */
  @IsOptional() @IsString() @MaxLength(200) descripcionPapel?: string;
  /**
   * EL RENGLÓN ES PARA COFFIT (0119): lo tildó quien cargó la factura (o tildó
   * «toda la factura es de Coffit»). Un artículo de uso exclusivo de Coffit lo
   * es siempre, venga o no el tilde: la marca de la ficha no se destilda acá.
   */
  @IsOptional() @IsBoolean() paraCafeteria?: boolean;
}

/**
 * Costo que el comprobante deja como nuevo costo de catálogo. La factura ES la
 * lista de precios nueva del proveedor; sin esto, el costo cargado se queda
 * viejo en silencio y se vende con el margen equivocado.
 */
class ActualizarCostoDto {
  @IsInt() productoId!: number;
  /** Costo DEL BULTO, como viene en el papel. */
  @IsNumber() costo!: number;
  /**
   * Kg (granel) o unidades (entero) del bulto de ESTA entrega. Viaja junto con
   * el costo porque son un solo hecho — "la bolsa de 20 kg sale $40.000" — y
   * actualizar el precio con los kilos viejos dejaría el $/kg (que es lo que
   * fija la góndola) mintiendo.
   */
  @IsOptional() @IsNumber() cantidad?: number;
  /**
   * El descuento EFECTIVO del papel para este producto (renglón + bonificación
   * general). Solo lo usa un formato en modo "precio final", que no tiene
   * descuentos propios: su "lo que se paga por bulto" sale del neto del papel.
   */
  @IsOptional() @IsNumber() @Min(0) @Max(100) descuentoPapel?: number;
  /** Trasladar el descuento de la factura al formato (26/9/2026): el % que queda en el formato. */
  @IsOptional() @IsNumber() @Min(0, { message: 'El descuento no puede ser negativo.' }) @Max(99.99, { message: 'El descuento del formato va de 0 a 99,99%.' }) descuento?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100, { message: 'El flete va de 0 a 100%.' }) flete?: number;
}

/**
 * Pago que se registra EN EL MISMO ACTO de cargar el comprobante: el "contado"
 * de verdad. Hasta ahora `condicionPago: 'contado'` era solo una etiqueta —no
 * movía plata—, así que una factura pagada en efectivo seguía figurando como
 * deuda del proveedor.
 *
 * `cajaSesionId` decide de dónde sale: con turno, la plata sale de la caja de
 * esa sucursal y el arqueo lo muestra; sin turno, es plata de administración
 * que no pasa por ninguna caja (una transferencia del negocio).
 */
class PagoContadoDto {
  @IsNumber() importe!: number;
  @IsOptional() @IsIn(['efectivo', 'transferencia', 'tarjeta_debito', 'tarjeta_credito', 'cheque', 'qr', 'otro'])
  medio?: string;
  @IsOptional() @IsInt() cajaSesionId?: number;
  @IsOptional() @IsString() referencia?: string;
}

/** Pago de sucursal YA registrado que este comprobante toma (total o parcial). */
class TomarPagoDto {
  @IsInt() pagoId!: number;
  @IsNumber() importe!: number;
}

/**
 * Un compromiso de pago (0068): "esta factura se paga el día X". Uno solo, o
 * varios como CUOTAS que tienen que sumar el total. El formulario los ofrece
 * prellenados (fecha + días de pago del proveedor) y editables — nunca nacen
 * en silencio.
 */
class CompromisoNuevoDto {
  @IsNumber() @Min(0.01) importe!: number;
  /** 'AAAA-MM-DD'. */
  @IsString() fechaVenc!: string;
  @IsOptional() @IsString() @MaxLength(300) obs?: string;
}

class CreateComprobanteDto {
  @IsIn(TIPOS as unknown as string[]) tipo!: (typeof TIPOS)[number];
  @IsOptional() @IsIn(['A', 'B', 'C', 'X']) letra?: 'A' | 'B' | 'C' | 'X';
  @IsOptional() @IsString() puntoVenta?: string;
  /* Hasta 8 cifras (1/10/2026): es el formato de ARCA (0001-00012345). Antes un
   * número de 11 cifras —punto de venta y número pegados— pasaba y la base lo
   * rechazaba con un 500 genérico («falló algo en el servidor»). */
  @IsOptional() @IsInt() @Min(1, { message: 'El número del comprobante va desde 1.' })
  @Max(99_999_999, { message: 'El número del comprobante tiene hasta 8 cifras, sin el punto de venta (en 0885-18518519 el número es 18518519).' })
  numero?: number;
  @IsInt() proveedorId!: number;
  @IsOptional() @IsInt() sucursalId?: number;
  /**
   * SOLO SE CARGA CONFIRMADO (26/9/2026). El alta en borrador no tenía cómo
   * confirmarse después, y el alta "anulada" dejaba un papel basura con
   * número tomado. Para corregir está Anular. El campo queda por compatibilidad.
   */
  @IsOptional() @IsIn(['confirmado'], {
    message: 'Los comprobantes se cargan confirmados: no hay borradores. Si algo quedó mal, se anula y se vuelve a cargar.',
  }) estado?: 'confirmado';
  @IsOptional() @IsIn(['contado', 'cuenta_corriente']) condicionPago?: 'contado' | 'cuenta_corriente';
  @IsOptional() @IsBoolean() recepcion?: boolean;
  /** El descuento de PIE ("Bonif. 21,38 %"), aparte de los de cada renglón. */
  @IsOptional() @IsNumber() bonificacion?: number;
  /** Su importe tal como lo imprime la factura; si viene, gana sobre el %. */
  @IsOptional() @IsNumber() bonificacionImporte?: number;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => PercepcionDto)
  percepciones?: PercepcionDto[];
  @IsOptional() @IsInt() refComprobanteId?: number;
  @IsOptional() @IsString() observaciones?: string;
  @IsOptional() @IsInt() usuarioId?: number;
  /** El CAE del papel. Viene del QR, no se tipea. */
  @IsOptional() @IsString() cae?: string;
  /**
   * La factura de la bandeja que este comprobante viene a cerrar. Se marca
   * `cargada` en la MISMA transacción: si el comprobante no queda, la factura
   * tampoco se da por procesada.
   */
  @IsOptional() @IsInt() lecturaId?: number;
  @IsOptional() @IsString() fecha?: string;
  @IsOptional() @IsString() fechaCarga?: string;
  @IsOptional() @IsString() vencimientoPago?: string;
  @IsArray() @ArrayNotEmpty() @ValidateNested({ each: true }) @Type(() => ComprobanteItemDto)
  items!: ComprobanteItemDto[];
  /** Los que el usuario tildó en "diferencias de costo" al cargar el comprobante. */
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ActualizarCostoDto)
  actualizarCostos?: ActualizarCostoDto[];
  /** Productos cuyo salto de costo por unidad (más de ×3) alguien confirmó. */
  @IsOptional() @IsArray() @IsInt({ each: true }) confirmarSaltos?: number[];
  /**
   * Productos cuyo proveedor activo pasa a ser el de este comprobante. Es una
   * decisión explícita del usuario en la recepción: cambia qué costo manda el
   * precio de venta, así que no puede ser automático.
   */
  @IsOptional() @IsArray() @IsInt({ each: true })
  activarProveedor?: number[];

  /** El resto que se paga ahora (contado). Ver `PagoContadoDto`. */
  @IsOptional() @ValidateNested() @Type(() => PagoContadoDto)
  pagoContado?: PagoContadoDto;

  /**
   * Pagos que la cajera hizo desde la sucursal y este comprobante toma. Es la
   * forma en que se "aplica" un pago: al cargar la factura, no con un botón
   * suelto en la bandeja.
   */
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => TomarPagoDto)
  tomarPagos?: TomarPagoDto[];

  /** Compromisos de pago (0068): cuotas que suman el total. Ver `CompromisoNuevoDto`. */
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => CompromisoNuevoDto)
  compromisos?: CompromisoNuevoDto[];
}

/**
 * Un renglón al FACTURAR UN REMITO (26/8): el producto y la cantidad están
 * CLAVADOS —son lo que entró al depósito—, y lo único que el papel puede traer
 * distinto es el precio. Por eso el renglón viaja por su `itemId` y no por
 * producto: no hay ambigüedad ni forma de colar mercadería nueva.
 */
class FacturarItemDto {
  @IsInt() itemId!: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1_000_000_000) costoUnitario?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) descuento?: number;
  @IsOptional() @IsNumber() @IsIn(ALICUOTAS_IVA as unknown as number[], {
    message: `Alícuota de IVA inválida. Las válidas son: ${ALICUOTAS_TEXTO}%.`,
  }) iva?: number;
}

/**
 * LLEGÓ LA FACTURA DE UN REMITO (26/8). Es el `CreateComprobanteDto` de una
 * factura menos todo lo que el remito ya decidió: ni tipo, ni proveedor, ni
 * sucursal, ni ítems nuevos — solo el encabezado del papel, los precios reales
 * de los renglones, el pie y cómo se paga.
 */
class AnularComprobanteDto {
  @IsString() @MaxLength(300) motivo!: string;
  @IsOptional() @IsInt() usuarioId?: number;
}

class FacturarRemitoDto {
  @IsOptional() @IsIn(['A', 'B', 'C', 'X']) letra?: 'A' | 'B' | 'C' | 'X';
  @IsOptional() @IsString() puntoVenta?: string;
  /* Hasta 8 cifras (1/10/2026): es el formato de ARCA (0001-00012345). Antes un
   * número de 11 cifras —punto de venta y número pegados— pasaba y la base lo
   * rechazaba con un 500 genérico («falló algo en el servidor»). */
  @IsOptional() @IsInt() @Min(1, { message: 'El número del comprobante va desde 1.' })
  @Max(99_999_999, { message: 'El número del comprobante tiene hasta 8 cifras, sin el punto de venta (en 0885-18518519 el número es 18518519).' })
  numero?: number;
  /** La fecha DEL PAPEL: define el período fiscal de la factura. */
  @IsOptional() @IsString() fecha?: string;
  @IsOptional() @IsString() fechaCarga?: string;
  @IsOptional() @IsString() vencimientoPago?: string;
  /** El CAE del papel (del QR o del PDF). */
  @IsOptional() @IsString() cae?: string;
  /** El papel de la bandeja que esta factura cierra (si entró por ahí). */
  @IsOptional() @IsInt() lecturaId?: number;
  /** Productos cuyo salto de costo por unidad (más de ×3) alguien confirmó. */
  @IsOptional() @IsArray() @IsInt({ each: true }) confirmarSaltos?: number[];
  @IsOptional() @IsString() observaciones?: string;
  @IsOptional() @IsNumber() bonificacion?: number;
  @IsOptional() @IsNumber() bonificacionImporte?: number;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => PercepcionDto)
  percepciones?: PercepcionDto[];
  /** Precios corregidos de los renglones del remito. Los que no vengan quedan como estaban. */
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => FacturarItemDto)
  items?: FacturarItemDto[];
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ActualizarCostoDto)
  actualizarCostos?: ActualizarCostoDto[];
  @IsOptional() @IsArray() @IsInt({ each: true })
  activarProveedor?: number[];
  @IsOptional() @ValidateNested() @Type(() => PagoContadoDto)
  pagoContado?: PagoContadoDto;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => TomarPagoDto)
  tomarPagos?: TomarPagoDto[];
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => CompromisoNuevoDto)
  compromisos?: CompromisoNuevoDto[];
  @IsOptional() @IsInt() usuarioId?: number;
}

type PedidoCosto = { costo: number; cantidad?: number; descuento?: number; flete?: number; descuentoPapel?: number };

/**
 * EL CAMBIO DE COSTO QUE DEJA UNA FACTURA EN UN FORMATO — función de módulo
 * porque la usan dos: el registro (que lo graba) y la proyección de góndola
 * (que lo muestra antes). Ver el comentario de `cambioDeCosto` en el servicio.
 */
export function cambioDeCostoFormato(e: any, x: PedidoCosto, iva = 0) {
  const cantidad = Number(x.cantidad) > 0 ? Number(x.cantidad) : undefined;
  if (e.modoCosto === 'final') {
    const q = Math.min(Math.max(Number(e.porcSinFactura) || 0, 0), 100) / 100;
    const neto = (Number(x.costo) || 0) * (1 - Math.min(Math.max(Number(x.descuentoPapel) || 0, 0), 100) / 100);
    return { id: e.id, cantidad, costoFinal: Math.round(neto * ((1 - q) * (1 + iva / 100) + q) * 100) / 100 };
  }
  return { id: e.id, costo: x.costo, descuento: x.descuento, flete: x.flete, cantidad };
}

/** Lo que la pantalla de la factura manda para proyectar la góndola. */
class ProyeccionItemDto {
  @IsInt() productoId!: number;
  @IsOptional() @IsNumber() costoUnitario?: number;
}
class ProyeccionPreciosDto {
  @IsInt() proveedorId!: number;
  /** Si el comprobante ingresa mercadería: la recepción crea el formato que falte. */
  @IsOptional() @IsBoolean() recepcion?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => ProyeccionItemDto)
  items?: ProyeccionItemDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => ActualizarCostoDto)
  actualizarCostos?: ActualizarCostoDto[];
  @IsOptional() @IsArray() @IsInt({ each: true }) activarProveedor?: number[];
}

/** Cuántas veces puede cambiar el costo por unidad sin pedir confirmación (ver `exigirSaltosConfirmados`). */
const SALTO_COSTO = 3;

/**
 * TIPOS QUE LLEVAN NÚMERO SÍ O SÍ (26/9/2026): los que vienen en un papel del
 * proveedor. Sin número no hay control de duplicado posible, y la misma
 * factura cargada dos veces sumaba dos veces el stock y la deuda. La
 * liquidación (interna, letra X) y la orden de compra pueden no tenerlo.
 */
const LLEVAN_NUMERO = new Set(['factura', 'remito', 'nota_credito', 'nota_debito']);

/*
 * EL IVA LO DECIDE LA LETRA (26/9/2026). Sabor y Aroma es Responsable
 * Inscripto, y lo que un proveedor le puede facturar depende de SU condición:
 *
 *   A   el RI discrimina el IVA → es CRÉDITO FISCAL: el costo es el neto.
 *   B   el RI no lo discrimina (o el exento) → el precio YA lo trae adentro y
 *       NO se recupera: ese IVA es costo. Se carga el precio final, IVA 0.
 *   C   el monotributista no tiene IVA → el precio es todo. IVA 0.
 *   X   no es fiscal: eso es una LIQUIDACIÓN, no una factura.
 *
 * Antes la pantalla mandaba el IVA del producto en cualquier letra y el
 * servidor le sumaba el 21% a una factura C: la deuda y el costo inflados en
 * un IVA que el proveedor nunca cobró.
 */
const LETRAS_POR_CONDICION: Record<string, string[]> = {
  responsable_inscripto: ['A', 'B'],
  monotributo: ['C'],
  exento: ['B', 'C'],
  consumidor_final: ['C'],
  no_categorizado: ['C'],
};
const CONDICION_TEXTO: Record<string, string> = {
  responsable_inscripto: 'responsable inscripto', monotributo: 'monotributista', exento: 'exento',
  consumidor_final: 'consumidor final', no_categorizado: 'no categorizado',
};
/** La letra que corresponde si el papel no dice otra cosa. */
export const letraPorDefecto = (condicion?: string | null) => (condicion === 'responsable_inscripto' || !condicion ? 'A' : 'C');
const ES_PAPEL_FISCAL = new Set(['factura', 'nota_credito', 'nota_debito']);

/** ¿Es el choque del único de comprobantes? (dos altas a la vez del mismo papel). */
function esDuplicadoDeBase(e: any) {
  const x = e?.cause ?? e;
  return x?.code === '23505' && String(x?.constraint ?? x?.message ?? '').includes('uq_comprobantes_numero');
}

@Injectable()
export class ComprobantesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly inv: InventarioService,
    private readonly precios: PreciosService,
    /** El pago es del proveedor, no del comprobante: acá solo se lo invoca. */
    private readonly pagos: PagosProveedorService,
  ) {}

  private async withItems(c: any) {
    const items = await this.db.select().from(comprobanteItems).where(eq(comprobanteItems.comprobanteId, c.id));
    return { ...c, items };
  }

  /**
   * LAS NOTAS QUE AJUSTAN CADA FACTURA, en una consulta para todas.
   * ============================================================================
   * Una nota de crédito o de débito casi nunca vive sola: nace de UNA factura —
   * la mercadería que se devolvió de esa entrega, el flete que se olvidaron de
   * cobrar en ese remito. `refComprobanteId` guarda de cuál.
   *
   * Sin esto, la NC solo restaba de la deuda TOTAL del proveedor y la factura
   * seguía ofreciendo su importe entero para pagar: el que paga factura por
   * factura le pagaba de más, aunque la cuenta del proveedor cerrara bien.
   *
   * Signo: la **ND suma** (el proveedor cobra más por esa factura) y la
   * **NC resta**. Devuelve un Map por el id de la FACTURA referenciada.
   */
  private async ajustesDe(idsFactura: number[]) {
    const porFactura = new Map<number, { ajuste: number; notas: any[] }>();
    if (!idsFactura.length) return porFactura;

    const notas = await this.db.select({
      id: comprobantes.id,
      tipo: comprobantes.tipo,
      letra: comprobantes.letra,
      puntoVenta: comprobantes.puntoVenta,
      numero: comprobantes.numero,
      fecha: comprobantes.fecha,
      total: comprobantes.total,
      observaciones: comprobantes.observaciones,
      refComprobanteId: comprobantes.refComprobanteId,
    }).from(comprobantes).where(and(
      inArray(comprobantes.refComprobanteId, idsFactura),
      inArray(comprobantes.tipo, ['nota_credito', 'nota_debito']),
      eq(comprobantes.estado, 'confirmado'),
    )).orderBy(comprobantes.id);

    for (const n of notas) {
      const ref = n.refComprobanteId!;
      const acc = porFactura.get(ref) ?? { ajuste: 0, notas: [] };
      const signo = n.tipo === 'nota_debito' ? 1 : -1;
      acc.ajuste = r2(acc.ajuste + signo * n.total);
      acc.notas.push({ ...n, signo });
      porFactura.set(ref, acc);
    }
    return porFactura;
  }

  /**
   * El saldo de VERDAD de un comprobante: lo que dice el papel, más lo que sus
   * notas de débito le agregaron, menos lo que sus notas de crédito le
   * descontaron, menos lo que ya se pagó.
   */
  private saldoReal(c: { total: number; pagado: number }, ajuste = 0) {
    return r2(c.total + ajuste - c.pagado);
  }

  /**
   * De dónde salió la plata de estos comprobantes, en UNA consulta para todos.
   *
   * Es lo que hace identificable en la tabla que una factura se pagó con plata
   * que salió de la caja de una sucursal: viaja el nombre de la sucursal, el
   * turno y el cajero. Devuelve un Map por comprobanteId.
   */
  private async pagosDe(ids: number[]) {
    const porId = new Map<number, any[]>();
    if (!ids.length) return porId;

    const filas = await this.db.select({
      comprobanteId: proveedorImputaciones.comprobanteId,
      importe: proveedorImputaciones.importe,
      pagoId: proveedorPagos.id,
      fecha: proveedorPagos.fecha,
      medio: proveedorPagos.medio,
      concepto: proveedorPagos.concepto,
      cajaSesionId: proveedorPagos.cajaSesionId,
      sucursalId: proveedorPagos.sucursalId,
      sucursalNombre: sucursales.nombre,
      usuarioNombre: usuarios.nombre,
    })
      .from(proveedorImputaciones)
      .innerJoin(proveedorPagos, eq(proveedorPagos.id, proveedorImputaciones.pagoId))
      .leftJoin(sucursales, eq(sucursales.id, proveedorPagos.sucursalId))
      .leftJoin(usuarios, eq(usuarios.id, proveedorPagos.usuarioId))
      .where(and(
        inArray(proveedorImputaciones.comprobanteId, ids),
        eq(proveedorPagos.estado, 'activo'),
      ))
      .orderBy(proveedorImputaciones.id);

    for (const f of filas) {
      const arr = porId.get(f.comprobanteId!) ?? [];
      arr.push(f);
      porId.set(f.comprobanteId!, arr);
    }
    return porId;
  }

  async list(q: {
    proveedorId?: number; tipo?: string; estado?: string;
    verLiquidaciones?: boolean; limit?: number;
  }) {
    const conds: any[] = [];
    if (q.proveedorId) conds.push(eq(comprobantes.proveedorId, Number(q.proveedorId)));
    if (q.tipo) conds.push(eq(comprobantes.tipo, q.tipo as any));
    if (q.estado) conds.push(eq(comprobantes.estado, q.estado as any));
    /*
     * SIN el permiso `liquidaciones`, la mitad no facturada no viaja — ni
     * pidiéndola por `?tipo=liquidacion`. El `ne` corre igual que el filtro de
     * arriba, así que la combinación "pedí liquidaciones y no puedo verlas"
     * devuelve vacío en vez de todo.
     */
    if (!q.verLiquidaciones) conds.push(ne(comprobantes.tipo, 'liquidacion' as any));
    const where = conds.length ? and(...conds) : undefined;
    /*
     * TECHO DEL LISTADO — era el único del sistema sin ninguno.
     *
     * Devolvía TODOS los comprobantes con todos sus ítems, percepciones, pagos y
     * notas, y se pide al abrir Facturación y en cada recarga (cargar una factura
     * recargaba la lista completa). Los vecinos ya tenían el suyo: movimientos
     * 300, pagos 300/1000, historial de precios 100/500.
     *
     * Se pudo poner recién ahora: mientras el saldo del proveedor se calculaba
     * en el navegador sumando esta lista, acotarla habría dejado el saldo mal
     * **en silencio** para cualquier proveedor con más comprobantes que el tope.
     * Ese cálculo se mudó a `saldos()`, que suma en la base sin traer nada.
     */
    const limit = Math.min(Math.max(Number(q.limit) || 300, 1), 1000);
    const rows = await this.db.select().from(comprobantes).where(where)
      .orderBy(desc(comprobantes.id)).limit(limit);
    if (!rows.length) return [];

    /*
     * Ítems y pagos de TODOS los comprobantes en dos consultas, no una por
     * fila. Antes esto hacía un SELECT de ítems por comprobante: con seis
     * facturas no se nota, con las miles de un año son miles de viajes por
     * cada vez que se abre la pantalla.
     */
    const ids = rows.map((c) => c.id);
    const [items, pagos, percs, ajustes] = await Promise.all([
      this.db.select().from(comprobanteItems).where(inArray(comprobanteItems.comprobanteId, ids)),
      this.pagosDe(ids),
      this.db.select().from(comprobantePercepciones).where(inArray(comprobantePercepciones.comprobanteId, ids)),
      this.ajustesDe(ids),
    ]);
    const itemsPorId = new Map<number, any[]>();
    for (const it of items) {
      const arr = itemsPorId.get(it.comprobanteId) ?? [];
      arr.push(it);
      itemsPorId.set(it.comprobanteId, arr);
    }
    const percsPorId = new Map<number, any[]>();
    for (const p of percs) {
      const arr = percsPorId.get(p.comprobanteId) ?? [];
      arr.push(p);
      percsPorId.set(p.comprobanteId, arr);
    }

    /*
     * La etiqueta de la factura que ajusta cada nota, para que la tabla pueda
     * decir "NC de la Factura A 0115-193307" sin pedir el detalle.
     *
     * Se piden las referenciadas que NO están en el resultado: con el filtro
     * puesto en "notas de crédito", la factura de la que salen no viene en
     * `rows` y la etiqueta quedaba vacía justo donde más se necesita.
     */
    const etiquetas = new Map<number, string>(rows.map((c) => [c.id, etiquetaDoc(c)]));
    const refsFaltantes = [...new Set(
      rows.map((c) => c.refComprobanteId).filter((x): x is number => !!x && !etiquetas.has(x)),
    )];
    if (refsFaltantes.length) {
      const refs = await this.db.select({
        id: comprobantes.id, tipo: comprobantes.tipo, letra: comprobantes.letra,
        puntoVenta: comprobantes.puntoVenta, numero: comprobantes.numero,
      }).from(comprobantes).where(inArray(comprobantes.id, refsFaltantes));
      for (const r of refs) etiquetas.set(r.id, etiquetaDoc(r));
    }

    return rows.map((c) => {
      const aj = ajustes.get(c.id);
      return {
        ...c,
        items: itemsPorId.get(c.id) ?? [],
        percepciones: percsPorId.get(c.id) ?? [],
        pagos: pagos.get(c.id) ?? [],
        // Lo que sus notas le sumaron o restaron, y cuáles fueron.
        ajuste: aj?.ajuste ?? 0,
        notas: aj?.notas ?? [],
        // Si ESTA fila es una nota: a qué factura pertenece.
        refEtiqueta: c.refComprobanteId ? (etiquetas.get(c.refComprobanteId) ?? '') : '',
        saldo: this.saldoReal(c, aj?.ajuste ?? 0),
      };
    });
  }

  /**
   * Un comprobante con lo mismo que devuelve el listado: ítems, los pagos que
   * lo cancelaron (con su sucursal y turno) y el saldo. La forma es idéntica
   * para que el detalle y la tabla lean el mismo objeto y no haya un campo que
   * exista en una pantalla y falte en la otra.
   */
  async get(id: number) {
    const [c] = await this.db.select().from(comprobantes).where(eq(comprobantes.id, id)).limit(1);
    if (!c) throw new NotFoundException('Comprobante inexistente.');
    const [conItems, pagos, percepciones, papeles] = await Promise.all([
      this.withItems(c),
      this.pagosDe([id]),
      this.db.select().from(comprobantePercepciones).where(eq(comprobantePercepciones.comprobanteId, id)),
      /* El papel del que salió esta factura, si entró por la bandeja o si
       * alguien lo engachó después. Es lo que se mira cuando el total no cierra
       * seis meses más tarde. Solo los metadatos: los bytes se piden por URL. */
      this.db.select({
        id: facturaArchivos.id, nombre: facturaArchivos.nombre, mime: facturaArchivos.mime,
      }).from(facturaArchivos)
        .innerJoin(facturaLecturas, eq(facturaLecturas.id, facturaArchivos.lecturaId))
        .where(eq(facturaLecturas.comprobanteId, id))
        .orderBy(facturaArchivos.id),
    ]);

    /* Las dos puntas del vínculo con las notas: si es una FACTURA, cuáles la
     * ajustan; si es una NOTA, de qué factura salió. El detalle tiene que poder
     * explicar el total sin que nadie cruce dos pantallas. */
    const ajustes = await this.ajustesDe([id]);
    const aj = ajustes.get(id);
    let ref: any = null;
    if (c.refComprobanteId) {
      const [r] = await this.db.select().from(comprobantes)
        .where(eq(comprobantes.id, c.refComprobanteId)).limit(1);
      if (r) ref = { id: r.id, etiqueta: etiquetaDoc(r), fecha: r.fecha, total: r.total };
    }

    return {
      ...conItems,
      percepciones,
      papeles,
      pagos: pagos.get(id) ?? [],
      ajuste: aj?.ajuste ?? 0,
      notas: aj?.notas ?? [],
      ref,
      refEtiqueta: ref?.etiqueta ?? '',
      saldo: this.saldoReal(c, aj?.ajuste ?? 0),
    };
  }

  /**
   * LAS FACTURAS QUE UNA NOTA PUEDE AJUSTAR.
   * ============================================================================
   * Alimenta el selector del paso 3 al cargar una NC o una ND. Solo facturas
   * confirmadas del MISMO proveedor: una nota no puede ajustar la factura de
   * otro, ni un remito (que no genera deuda), ni otra nota.
   *
   * Cada una viene con su saldo REAL —descontando lo pagado y lo que ya le
   * ajustaron otras notas— porque es el número contra el que el usuario decide.
   */
  async referenciables(proveedorId: number) {
    const facturas = await this.db.select().from(comprobantes).where(and(
      eq(comprobantes.proveedorId, proveedorId),
      eq(comprobantes.tipo, 'factura'),
      eq(comprobantes.estado, 'confirmado'),
    )).orderBy(desc(comprobantes.fecha), desc(comprobantes.id));
    if (!facturas.length) return [];

    const ajustes = await this.ajustesDe(facturas.map((f) => f.id));
    return facturas.map((f) => {
      const aj = ajustes.get(f.id);
      return {
        id: f.id,
        etiqueta: etiquetaDoc(f),
        fecha: f.fecha,
        total: f.total,
        pagado: f.pagado,
        ajuste: aj?.ajuste ?? 0,
        notas: (aj?.notas ?? []).length,
        saldo: this.saldoReal(f, aj?.ajuste ?? 0),
      };
    });
  }

  /**
   * Lo que ya no se trae NO entra por una factura de compra. Vale para
   * discontinuado y archivado: si el producto volvió, la decisión es
   * reactivarlo (un clic, conserva precios e historial), no cargarlo como si
   * nunca se hubiera dado de baja — así el estado no miente.
   */
  /**
   * Valida que todo lo que se compra siga activo y devuelve QUÉ productos son
   * de uso exclusivo de la cafetería (0101): una sola lectura para las dos
   * cosas, porque se hace en el camino de cada alta.
   */
  private async productosComprables(items: Array<{ productoId: number; presentacionId?: number | null }>): Promise<Set<number>> {
    const ids = [...new Set((items ?? []).map((it) => it.productoId).filter((x) => x != null))];
    if (!ids.length) return new Set();
    const filas = await this.db.select({
      id: productos.id, nombre: productos.nombre, estado: productos.estado, soloCafeteria: productos.soloCafeteria,
    }).from(productos).where(inArray(productos.id, ids));
    /* Un producto que no existe daba "error del servidor" (la clave foránea). */
    const faltan = ids.filter((id) => !filas.some((f) => f.id === id));
    if (faltan.length) {
      throw new BadRequestException(`Hay renglones con un producto que no existe (código interno ${faltan.join(', ')}): quitalo y buscalo de nuevo.`);
    }
    await this.exigirPaquetesDelProducto(items, filas);
    const dados = filas.filter((f) => f.estado !== 'activo');
    if (dados.length) {
      const nombres = dados.map((d) => `${d.nombre} (${d.estado})`).join(', ');
      throw new BadRequestException(
        `Estos productos ya no se compran: ${nombres}. Si volvés a traerlos, reactivalos en Compras › Productos y cargá la factura de nuevo.`,
      );
    }
    return new Set(filas.filter((f) => f.soloCafeteria).map((f) => f.id));
  }

  /**
   * EL PAQUETE TIENE QUE SER DE ESE PRODUCTO (26/9/2026). Uno inexistente daba
   * "error del servidor", y el de OTRO producto entraba: el stock quedaba en
   * un paquete que ese producto no tiene y no aparecía en ningún lado.
   */
  private async exigirPaquetesDelProducto(
    items: Array<{ productoId: number; presentacionId?: number | null }>,
    prods: Array<{ id: number; nombre: string }>,
  ) {
    const presIds = [...new Set(items.map((it) => it.presentacionId).filter((x): x is number => x != null))];
    if (!presIds.length) return;
    const pres = await this.db.select({ id: presentaciones.id, productoId: presentaciones.productoId })
      .from(presentaciones).where(inArray(presentaciones.id, presIds));
    for (const it of items) {
      if (it.presentacionId == null) continue;
      const p = pres.find((x) => x.id === it.presentacionId);
      if (!p || p.productoId !== it.productoId) {
        const nombre = prods.find((x) => x.id === it.productoId)?.nombre ?? 'Un producto';
        throw new BadRequestException(`${nombre}: el paquete elegido no es de este producto (o ya no existe). Volvé a elegirlo.`);
      }
    }
  }

  /** La sucursal de recepción tiene que existir (antes: "error del servidor"). */
  private async exigirSucursal(sucursalId?: number | null) {
    if (sucursalId == null) return;
    const [s] = await this.db.select({ id: sucursales.id, nombre: sucursales.nombre, activa: sucursales.activa }).from(sucursales).where(eq(sucursales.id, sucursalId)).limit(1);
    if (!s) throw new BadRequestException('La sucursal elegida no existe: volvé a elegirla.');
    if (!s.activa) throw new BadRequestException(`${s.nombre} está desactivada: el local cerró. Elegí otra sucursal.`);
  }

  /**
   * LA PARTE DE COFFIT DE UN PIE (0101): el neto YA BONIFICADO de los renglones
   * del café. Sale de los mismos `items` que devuelve `armarPie`, así que cierra
   * al centavo con el neto gravado del documento.
   */
  private netoCafeteriaDe(items: Array<{ subtotal: number }>, esDelCafe: (it: any) => boolean) {
    return r2(items.reduce((a, it) => a + (esDelCafe(it) ? it.subtotal : 0), 0));
  }

  /* ------------------------- EL PIE DE LA FACTURA -------------------------
   * En el mismo orden en que lo lee el papel: los renglones dan el bruto, la
   * bonificación general lo baja, el IVA se calcula sobre el neto YA
   * bonificado (si se calculara antes, el IVA quedaría más alto que el de la
   * factura) y las percepciones se suman al final — no son IVA, son pago a
   * cuenta de otro impuesto.
   *
   * Es UN método porque lo usan dos puertas: el alta (`create`) y la
   * conversión del remito (`facturar`). El mismo papel tiene que dar el mismo
   * total entre por donde entre.
   */
  private armarPie(
    entrada: {
      items: Array<Record<string, any>>;
      bonificacion?: number; bonificacionImporte?: number; percepciones?: PercepcionDto[];
    },
    fiscal: boolean,
    ivaDefault: number,
    /** ¿La letra discrimina IVA? Solo la A (ver LETRAS_POR_CONDICION). */
    discriminaIva = true,
  ) {
    let bruto = 0;
    // El spread conserva los campos del renglón original (productoId, itemId…);
    // el tipo se abre a propósito porque las dos puertas traen formas distintas.
    const items: Array<Record<string, any> & { iva: number; subtotal: number }> = entrada.items.map((it) => {
      const cantidad = Number(it.cantidad) || 0;
      const costo = Number(it.costoUnitario) || 0;
      const desc = Number(it.descuento) || 0;
      const ivaP = it.iva != null ? Number(it.iva) : ivaDefault;
      const neto = cantidad * costo * (1 - desc / 100);
      bruto += neto;
      return { ...it, iva: ivaP, subtotal: neto };
    });

    // La bonificación llega como % o como importe: el IMPORTE manda cuando
    // viene, porque el proveedor redondea a su manera y el total tiene que dar
    // igual al del papel, al centavo.
    const bonifPct = Number(entrada.bonificacion) || 0;
    if (bonifPct < 0 || bonifPct >= 100) {
      if (bonifPct !== 0) throw new BadRequestException('La bonificación tiene que estar entre 0 y 100%.');
    }
    let bonificacionImporte = entrada.bonificacionImporte != null
      ? Number(entrada.bonificacionImporte) || 0
      : r2(bruto * bonifPct / 100);
    /*
     * EL SIGNO SE VALIDA ANTES DEL TECHO, y no es un detalle de orden.
     *
     * El techo de abajo compara `bonificacionImporte > bruto`. Con una
     * bonificación NEGATIVA la comparación es falsa —así que el techo no se
     * dispara—, y el clamp que sigue la deja en 0… pero antes ya había sumado al
     * bruto: mandando ítems que dieran bruto negativo se grababa un comprobante
     * con TOTAL NEGATIVO, que resta de la cuenta corriente del proveedor como
     * una nota de crédito que nadie emitió.
     */
    if (!(bonificacionImporte >= 0)) {
      throw new BadRequestException('La bonificación no puede ser negativa.');
    }
    if (bonificacionImporte > bruto + 0.009) {
      throw new BadRequestException('La bonificación no puede ser mayor que el subtotal de los ítems.');
    }
    if (bonificacionImporte < 0) bonificacionImporte = 0;
    // El factor real, para repartir la bonificación entre los renglones y que
    // el libro de IVA cierre con el neto gravado de cada alícuota.
    const factorBonif = bruto > 0 ? 1 - bonificacionImporte / bruto : 1;

    /*
     * EN UNA LIQUIDACIÓN EL IVA ES CERO, y se fuerza acá y no en la pantalla.
     *
     * No es cosmético: si el renglón guardara su 21%, el importe existiría en la
     * base y cualquier suma futura de IVA de compras lo levantaría como crédito
     * fiscal de una factura que no existe. El precio de la mitad no facturada ya
     * viene sin IVA — es la razón por la que es más barata.
     */
    /*
     * EL IVA POR ALÍCUOTA Y AL CENTAVO, como el papel (26/9/2026): el neto
     * gravado de cada alícuota se redondea y SU IVA se calcula sobre ese
     * número. Antes se sumaba el IVA renglón por renglón sin redondear y la
     * base guardaba fracciones de centavo ($321.336,82625). En B, C y X no hay
     * IVA que discriminar: el precio cargado ya es el final.
     */
    const porAlicuota = new Map<number, number>();
    for (const it of items) {
      const neto = it.subtotal * factorBonif;
      it.subtotal = r2(neto);
      if (!fiscal || !discriminaIva) it.iva = 0;
      porAlicuota.set(it.iva, (porAlicuota.get(it.iva) ?? 0) + neto);
    }
    let subtotalNeto = 0;
    let ivaTotal = 0;
    for (const [alicuota, base] of porAlicuota) {
      const gravado = r2(base);
      subtotalNeto += gravado;
      ivaTotal += r2(gravado * alicuota / 100);
    }
    subtotalNeto = r2(subtotalNeto);
    ivaTotal = r2(ivaTotal);

    // Percepciones: cada una con su nombre y alícuota copiados del proveedor,
    // porque la factura del año pasado tiene que seguir explicando su total.
    const conIva = subtotalNeto + ivaTotal;
    // Las percepciones son pago a cuenta de un impuesto: en un comprobante que
    // no existe para ARCA no hay nada a cuenta de qué. Se descartan.
    const percepciones = (fiscal ? (entrada.percepciones ?? []) : [])
      .filter((p) => (p?.nombre ?? '').trim())
      .map((p) => {
        const base = p.base === 'total' ? 'total' : 'neto';
        const alicuota = Number(p.alicuota) || 0;
        const calculado = (base === 'total' ? conIva : subtotalNeto) * alicuota / 100;
        // El importe del papel gana: el proveedor puede redondear distinto.
        const importe = p.importe != null ? Number(p.importe) || 0 : r2(calculado);
        const tipo = ['iva', 'iibb', 'otro'].includes(String((p as any).tipo ?? '')) ? String((p as any).tipo) : '';
        return { nombre: String(p.nombre).trim(), alicuota, base: base as 'neto' | 'total', importe, tipo };
      })
      .filter((p) => p.importe > 0.009);
    /*
     * UNA PERCEPCIÓN TIENE UN TAMAÑO RAZONABLE (26/9/2026). Las de IIBB y
     * IVA rondan entre 1% y 6% del neto; sin tope, un cero de más ($5.000.000
     * sobre una factura de $121) se cargaba como deuda. 15% es holgado.
     */
    for (const p of percepciones) {
      if (p.alicuota > 15) {
        throw new BadRequestException(`La percepción ${p.nombre} dice ${p.alicuota}%: las percepciones rondan entre 1% y 6%. Revisá la alícuota.`);
      }
      if (subtotalNeto > 0 && p.importe > subtotalNeto * 0.15 + 0.01) {
        throw new BadRequestException(
          `La percepción ${p.nombre} es $${r2(p.importe).toFixed(2)}: el ${Math.round((p.importe / subtotalNeto) * 100)}% del neto. `
          + 'Las percepciones rondan entre 1% y 6%; revisá el importe.',
        );
      }
    }
    const percepcionesTotal = r2(percepciones.reduce((a, p) => a + p.importe, 0));

    const total = r2(subtotalNeto + ivaTotal + percepcionesTotal);
    return { items, bonifPct, bonificacionImporte, subtotalNeto, ivaTotal, percepciones, percepcionesTotal, total };
  }

  /**
   * LAS CUOTAS DEL COMPROMISO, normalizadas y validadas contra el saldo que
   * queda en cuenta corriente (el total menos lo que se paga en el mismo acto).
   * Compartida por el alta y la conversión del remito: comprometer plata que ya
   * se pagó infla el saldo proyectado, entre por donde entre la factura.
   */
  private normalizarCompromisos(
    dto: { compromisos?: CompromisoNuevoDto[]; pagoContado?: PagoContadoDto; tomarPagos?: TomarPagoDto[] },
    total: number,
  ) {
    const compromisosNorm = (dto.compromisos ?? []).map((k) => ({
      importe: r2(k.importe),
      fechaVenc: new Date(`${String(k.fechaVenc).slice(0, 10)}T00:00:00`),
      obs: String(k.obs ?? '').trim().slice(0, 300),
    }));
    if (!compromisosNorm.length) return compromisosNorm;
    for (const k of compromisosNorm) {
      if (Number.isNaN(k.fechaVenc.getTime())) {
        throw new BadRequestException('La fecha de vencimiento del compromiso va como AAAA-MM-DD.');
      }
    }
    /* Las cuotas cubren LO QUE QUEDA EN CUENTA CORRIENTE: el total menos lo
     * que se paga en el mismo acto (contado + pagos de sucursal tomados). */
    const sumaComp = r2(compromisosNorm.reduce((a, k) => a + k.importe, 0));
    const contadoPrevisto = r2((Number(dto.pagoContado?.importe) || 0)
      + (dto.tomarPagos ?? []).reduce((a, t) => a + (Number(t.importe) || 0), 0));
    const saldoPrevisto = r2(total - contadoPrevisto);
    if (Math.abs(sumaComp - saldoPrevisto) > 0.009) {
      throw new BadRequestException(
        `Los compromisos suman ${sumaComp} y lo que queda en cuenta corriente es ${saldoPrevisto}: las cuotas tienen que cubrir ese saldo exacto.`,
      );
    }
    return compromisosNorm;
  }

  /**
   * EL COMPROMISO NACE CON LA FACTURA (0068), en la misma transacción: si la
   * factura no queda, la promesa tampoco. Si el proveedor cobra con ECHEQ,
   * nace también el echeq con número y banco "a completar" — el papel del
   * echeq se emite después, y la cartera lo espera con nombre.
   */
  private async crearCompromisosTx(
    tx: any,
    c: { id: number; fecha: Date; puntoVenta: string; numero: number | null },
    prov: { id: number; medioHabitual?: string | null },
    compromisosNorm: Array<{ importe: number; fechaVenc: Date; obs: string }>,
    nombreDoc: string,
  ) {
    const esEcheq = prov.medioHabitual === 'echeq';
    const n = compromisosNorm.length;
    for (let i = 0; i < n; i++) {
      const k = compromisosNorm[i];
      const [comp] = await tx.insert(proveedorCompromisos).values({
        proveedorId: prov.id,
        comprobanteId: c.id,
        importe: k.importe,
        fechaEmision: c.fecha,
        fechaVenc: k.fechaVenc,
        origen: 'factura',
        esEcheq,
        cuota: n > 1 ? i + 1 : null,
        cuotas: n > 1 ? n : null,
        obs: k.obs,
      }).returning();
      if (esEcheq) {
        await tx.insert(proveedorEcheqs).values({
          numero: `PEND-${comp.id}`,
          banco: 'A definir',
          importe: k.importe,
          fechaEmision: c.fecha,
          fechaVenc: k.fechaVenc,
          proveedorId: prov.id,
          compromisoId: comp.id,
          obs: `Auto-creado con ${nombreDoc} ${c.puntoVenta}-${c.numero ?? c.id} — completar número y banco reales.`,
        });
      }
    }
  }

  /*
   * EL PAGO EN EL MISMO ACTO, después del commit del comprobante y a propósito.
   *
   * Va afuera de la transacción porque `PagosProveedorService` maneja la suya
   * (el pago, su egreso de caja y el recálculo son una sola operación). Si el
   * pago falla —turno cerrado, el pago que se quiso tomar ya no tiene saldo—,
   * el comprobante queda cargado y con deuda: un estado válido y recuperable
   * desde el detalle. Perder también la carga de la factura sería peor.
   *
   * Al final, la CONDICIÓN se deriva de lo que realmente se pagó: quedó
   * saldado = contado, quedó saldo = cuenta corriente. Así el campo no puede
   * contradecir al saldo.
   */
  private async saldarEnElActo(
    id: number,
    args: {
      proveedorId: number; concepto: string; fecha?: string; sucursalId?: number | null; usuarioId?: number;
      tomarPagos?: TomarPagoDto[]; pagoContado?: PagoContadoDto;
    },
    opciones: { sucursalSesion: number; cruzaSucursales?: boolean },
  ) {
    // Primero los pagos que ya existían: es plata que ya salió del cajón y
    // la factura viene a explicarla.
    for (const t of args.tomarPagos ?? []) {
      /* El `true` final: esta imputación pasa DENTRO del alta, donde el total
       * ya se validó completo (contado + tomados + cuotas = total exacto).
       * Sin él, el candado del modo "por facturas" rechazaba lo más común —
       * el flete adelantado, el vuelto que se le dejó al repartidor— por ser
       * un importe menor al saldo de la factura. */
      await this.pagos.imputar(Number(t.pagoId), {
        imputaciones: [{ comprobanteId: id, importe: Number(t.importe) }],
        usuarioId: args.usuarioId,
      }, opciones.cruzaSucursales, true);
    }
    // Y después el resto que se paga en el acto.
    const contado = Number(args.pagoContado?.importe) || 0;
    if (contado > 0) {
      await this.pagos.crear({
        proveedorId: args.proveedorId,
        destino: 'mercaderia',
        importe: contado,
        medio: args.pagoContado?.medio,
        fecha: args.fecha,
        concepto: args.concepto,
        referencia: args.pagoContado?.referencia,
        sucursalId: args.sucursalId ?? undefined,
        cajaSesionId: args.pagoContado?.cajaSesionId,
        usuarioId: args.usuarioId,
        imputaciones: [{ comprobanteId: id, importe: contado }],
        // Mismo motivo que arriba: el contado puede ser una entrega parcial
        // con el resto en cuotas, y el total ya se validó completo.
      }, opciones.sucursalSesion, opciones.cruzaSucursales, true);
    }

    /*
     * Se fija UNA vez, al crear: describe cómo se acordó esta compra. Que una
     * factura en cuenta corriente se pague después no la convierte en contado.
     */
    if ((args.tomarPagos?.length || contado > 0)) {
      const [final] = await this.db.select({ total: comprobantes.total, pagado: comprobantes.pagado })
        .from(comprobantes).where(eq(comprobantes.id, id)).limit(1);
      const saldado = final && final.pagado >= final.total - 0.009;
      await this.db.update(comprobantes)
        .set({ condicionPago: saldado ? 'contado' : 'cuenta_corriente' })
        .where(eq(comprobantes.id, id));
    }
  }

  /**
   * El alta. El choque del único de la base (dos altas a la vez del mismo
   * papel: el control previo lo pasan las dos) se contesta como lo que es.
   */
  async create(dto: CreateComprobanteDto, opciones: any) {
    try {
      return await this.crearComprobante(dto, opciones);
    } catch (e) {
      if (esDuplicadoDeBase(e)) {
        throw new BadRequestException('Ese comprobante ya está cargado (¿se apretó dos veces "Registrar"?). Buscalo en Facturación.');
      }
      throw e;
    }
  }

  private async crearComprobante(
    dto: CreateComprobanteDto,
    opciones: { puedeTocarPrecios?: boolean; sucursalSesion: number; cruzaSucursales?: boolean },
  ) {
    /*
     * RECIBIR MERCADERÍA Y TOCAR PRECIOS SON DOS PERMISOS DISTINTOS.
     *
     * Estos dos bloques del alta llaman al servicio de precios por adentro, así
     * que sin este corte alcanzaba `compras.facturacion` para reescribir el
     * costo de catálogo —y con él el precio de góndola— salteando el
     * `@Permiso('precios')` que cierra su controller.
     *
     * Se RECHAZA en vez de ignorar en silencio: quien recibe la mercadería tildó
     * "actualizar costos" y tiene que enterarse de que eso no se aplicó, no
     * descubrirlo la semana que viene mirando un margen que nunca cambió.
     */
    if (!opciones.puedeTocarPrecios && (dto.actualizarCostos?.length || dto.activarProveedor?.length)) {
      throw new ForbiddenException(
        'Para actualizar costos o cambiar el proveedor activo hace falta el permiso de precios. '
        + 'Registrá el comprobante sin esa parte y pedile a quien maneja precios que la haga.',
      );
    }

    const [prov] = await this.db.select().from(proveedores).where(eq(proveedores.id, dto.proveedorId)).limit(1);
    if (!prov) throw new BadRequestException('Proveedor inválido.');
    await exigirFueraDeConciliado(this.db, prov.id, dto.fecha, 'cargar un comprobante');
    if (!dto.items?.length) throw new BadRequestException('Agregá al menos un ítem.');
    if (LLEVAN_NUMERO.has(dto.tipo) && !dto.numero) {
      throw new BadRequestException(`Poné el número ${NOMBRE_TIPO[dto.tipo] ? `de ${NOMBRE_TIPO[dto.tipo]}` : 'del comprobante'} (el del papel): sin número no se puede controlar que no esté cargado dos veces.`);
    }
    this.exigirCostosDeLaFactura(dto.items.map((x) => Number(x.productoId)), dto.actualizarCostos, dto.activarProveedor);
    await this.exigirSucursal(dto.sucursalId);
    const delCafe = await this.productosComprables(dto.items);

    // Un proveedor monotributista o exento NO discrimina IVA: asumir 21% inflaría
    // el total del comprobante y ensuciaría el libro de IVA compras.
    const esRI = prov.condicionIva === 'responsable_inscripto';
    const ivaDefault = esRI ? 21 : 0;

    const fiscal = esFiscal(dto.tipo);
    /* La LETRA del papel, y con ella el IVA (ver LETRAS_POR_CONDICION). */
    const letraDoc = dto.tipo === 'liquidacion' ? 'X' : (dto.letra ?? letraPorDefecto(prov.condicionIva));
    if (ES_PAPEL_FISCAL.has(dto.tipo)) this.exigirLetra(letraDoc, prov);
    const discriminaIva = fiscal && letraDoc === 'A';
    this.validarFechas(dto);
    await this.exigirUnidadesEnteras(dto.items);

    /* EL PIE DE LA FACTURA — la cuenta vive en `armarPie()`, compartida con
     * `facturar()` (la conversión del remito): dos copias de esta matemática
     * habrían divergido tarde o temprano y el total dejaría de cerrar con el
     * papel según por qué puerta se cargó. */
    const {
      items, bonifPct, bonificacionImporte, subtotalNeto, ivaTotal, percepciones, percepcionesTotal, total,
    } = this.armarPie(dto, fiscal, ivaDefault, discriminaIva);
    /* Lo que de este papel es del café, congelado con el documento (0101): los
     * exclusivos siempre, y los que se tildaron al cargar (0119). */
    /* LA NOTA HEREDA LA MARCA DE SU FACTURA (0120, acordado en la conciliación
     * con Coffit): lo que en la factura era de Coffit lo es también en la NC o
     * ND que la ajusta, aunque no se tilde. Si no, la devolución de algo que
     * Coffit pagó le quedaba a la distribuidora. */
    const heredados = new Set<number>();
    if (dto.refComprobanteId != null && (dto.tipo === 'nota_credito' || dto.tipo === 'nota_debito')) {
      const filas = await this.db.select({ productoId: comprobanteItems.productoId }).from(comprobanteItems)
        .where(and(eq(comprobanteItems.comprobanteId, dto.refComprobanteId), eq(comprobanteItems.paraCafeteria, true)));
      for (const f of filas) heredados.add(f.productoId);
    }
    const esDelCafe = (it: { productoId: number; paraCafeteria?: boolean }) => delCafe.has(it.productoId)
      || heredados.has(it.productoId) || it.paraCafeteria === true;
    const netoCafeteria = this.netoCafeteriaDe(items, esDelCafe);
    /*
     * UN COMPROBANTE QUE SUMA DEUDA NO PUEDE TENER TOTAL NEGATIVO.
     *
     * Es el cinturón de seguridad de lo de arriba: con los pisos del renglón y
     * el signo de la bonificación ya validados no debería poder pasar, pero el
     * total sale de sumar seis cosas y este es el número que va a la cuenta
     * corriente del proveedor. Un negativo acá se comporta como una nota de
     * crédito que nadie emitió — le baja la deuda al proveedor sin papel.
     *
     * La NC queda afuera de la regla a propósito: su total es positivo y lo que
     * resta es el signo con que se aplica, no el importe.
     */
    if (['factura', 'liquidacion', 'nota_debito'].includes(dto.tipo) && total <= 0) {
      throw new BadRequestException(
        `El total de ${NOMBRE_TIPO[dto.tipo]} da ${r2(total)}: revisá las cantidades, los costos y la bonificación.`,
      );
    }
    /* Siempre confirmado: ver el `estado` del DTO. */
    const estado = 'confirmado' as const;
    // El papel imprime cinco dígitos y el sistema usa cuatro: normalizar acá es
    // lo que hace que el único de la base cruce las dos formas de cargarlo.
    const puntoVenta = normalizarPuntoVenta(dto.puntoVenta ?? '0001');
    // LISTA DE TIPOS · mueve stock hacia adentro. La liquidación va acá: la
    // mercadería de la mitad no facturada entró al depósito igual que la otra.
    const ingresaStock = !!dto.recepcion
      && (dto.tipo === 'remito' || dto.tipo === 'factura' || dto.tipo === 'liquidacion');
    /**
     * UNA NOTA DE CRÉDITO CON RECEPCIÓN **SACA** MERCADERÍA.
     *
     * Faltaba: la NC ya descontaba la deuda pero la mercadería devuelta quedaba
     * en stock. No se puede hacer automático por tipo, porque una NC no siempre
     * es una devolución: también ajusta un precio mal facturado o compensa un
     * bulto roto que igual te quedaste. Por eso lo decide `recepcion`, que acá
     * significa "esta NC devuelve mercadería".
     */
    const egresaStock = !!dto.recepcion && dto.tipo === 'nota_credito';
    if ((ingresaStock || egresaStock) && !dto.sucursalId) {
      throw new BadRequestException('Indicá la sucursal de recepción.');
    }

    /**
     * LA FACTURA QUE LA NOTA AJUSTA.
     * ==========================================================================
     * Una NC o ND nace de UNA factura: la mercadería que se devolvió de esa
     * entrega, el flete que no se cobró en ese remito. Atarla es lo que hace que
     * el saldo de esa factura diga la verdad — sin la referencia, la NC restaba
     * de la deuda total del proveedor y la factura seguía ofreciendo su importe
     * entero para pagar.
     *
     * Se valida acá y no en el DTO porque son reglas de datos, no de forma: el
     * proveedor tiene que ser el mismo, tiene que ser una factura (un remito no
     * genera deuda y una nota no se ajusta con otra nota) y tiene que estar
     * confirmada.
     */
    const esNota = dto.tipo === 'nota_credito' || dto.tipo === 'nota_debito';
    if (dto.refComprobanteId != null) {
      if (!esNota) {
        throw new BadRequestException('Solo una nota de crédito o de débito ajusta a otro comprobante.');
      }
      const [ref] = await this.db.select().from(comprobantes)
        .where(eq(comprobantes.id, dto.refComprobanteId)).limit(1);
      if (!ref) throw new BadRequestException('La factura que se quiere ajustar no existe.');
      if (ref.proveedorId !== prov.id) {
        throw new BadRequestException(`Esa factura no es de ${prov.nombre}: una nota no puede ajustar la factura de otro proveedor.`);
      }
      if (ref.tipo !== 'factura') {
        throw new BadRequestException(`Una nota solo ajusta una factura, y ${etiquetaDoc(ref)} no lo es.`);
      }
      if (ref.estado !== 'confirmado') {
        throw new BadRequestException(`${etiquetaDoc(ref)} está ${ref.estado}: no se le pueden aplicar notas.`);
      }
      // La nota va con la letra de su factura: una NC A de una factura C
      // devolvería un crédito fiscal que nunca existió.
      if (ref.letra !== letraDoc) {
        throw new BadRequestException(`La nota tiene que ser de la misma letra que ${etiquetaDoc(ref)} (${ref.letra}), no ${letraDoc}.`);
      }
    }

    /*
     * LOS COMPROMISOS DE PAGO (0068). Solo un documento confirmado que GENERA
     * deuda puede traerlos, y la suma tiene que dar el total exacto: el
     * compromiso es la promesa de pagar ESTA factura, no un número suelto.
     */
    const puedeComprometer = estado === 'confirmado'
      && (dto.tipo === 'factura' || dto.tipo === 'liquidacion');
    if (dto.compromisos?.length && !puedeComprometer) {
      throw new BadRequestException('Los compromisos de pago son de una factura o liquidación confirmada.');
    }
    const compromisosNorm = this.normalizarCompromisos(dto, total);

    /**
     * El mismo comprobante no se carga dos veces. El índice único de la base es
     * la garantía real (dos pestañas en paralelo se pasan por arriba de este
     * chequeo), pero sin esto el usuario veía un error de Postgres en crudo.
     */
    // El papel de la bandeja tiene que ser ESTE comprobante.
    if (dto.lecturaId) {
      await this.exigirLecturaCoincide(dto.lecturaId, prov, { tipo: dto.tipo, letra: letraDoc, puntoVenta, numero: dto.numero ?? null, total });
    }
    if (dto.numero) {
      // Con la letra y sin los anulados, igual que el único de la base (0107).
      const [ya] = await this.db.select({ id: comprobantes.id }).from(comprobantes).where(and(
        eq(comprobantes.proveedorId, prov.id),
        eq(comprobantes.tipo, dto.tipo),
        eq(comprobantes.letra, letraDoc as any),
        eq(comprobantes.puntoVenta, puntoVenta),
        eq(comprobantes.numero, dto.numero),
        ne(comprobantes.estado, 'anulado'),
      )).limit(1);
      if (ya) {
        throw new BadRequestException(
          `${prov.nombre} ya tiene cargada ${NOMBRE_TIPO[dto.tipo]} ${letraDoc} ${puntoVenta}-${dto.numero} (comprobante #${ya.id}).`,
        );
      }
    }

    const id = await this.db.transaction(async (tx) => {
      /*
       * EL TOPE DE LA NOTA DE CRÉDITO (26/9/2026), con la factura tomada: dos
       * notas a la vez no pueden pasarse entre las dos. Una NC no resta más
       * de lo que queda de su factura, y si devuelve mercadería, no devuelve
       * más de lo que vino en ella. Antes una NC de $12 millones sobre una
       * factura de $317 mil dejaba la deuda en negativo.
       */
      if (dto.tipo === 'nota_credito' && dto.refComprobanteId != null && estado === 'confirmado') {
        await this.exigirTopeNotaCredito(tx, dto.refComprobanteId, total, egresaStock ? dto.items : null);
      }
      const [c] = await tx.insert(comprobantes).values({
        tipo: dto.tipo,
        /* La liquidación es SIEMPRE letra X y no se deja elegir: la A significa
         * "discrimina IVA" y este comprobante no discrimina nada. Con letra A la
         * etiqueta decía "Liquidación A", que promete algo que no hay. */
        letra: letraDoc as any,
        puntoVenta,
        numero: dto.numero ?? null,
        /* 'AAAA-MM-DD' pelado se parsea UTC y el día retrocede uno en UTC−3;
         * si ya viene con hora (el store la agrega) se respeta tal cual. */
        fecha: dto.fecha ? new Date(dto.fecha.length <= 10 ? `${dto.fecha}T00:00:00` : dto.fecha) : undefined,
        fechaCarga: dto.fechaCarga ? new Date(dto.fechaCarga.length <= 10 ? `${dto.fechaCarga}T00:00:00` : dto.fechaCarga) : undefined,
        /* Con renglones de Coffit y fecha de un mes ya cerrado en su cuenta,
         * entra a la cuenta hoy (0120). */
        cuentaFecha: items.some((it) => esDelCafe(it as any))
          ? await fechaDeCuenta(tx, dto.fecha ? new Date(dto.fecha.length <= 10 ? `${dto.fecha}T00:00:00` : dto.fecha) : new Date())
          : null,
        proveedorId: prov.id, sucursalId: dto.sucursalId ?? null,
        estado, condicionPago: dto.condicionPago ?? 'cuenta_corriente',
        vencimientoPago: dto.vencimientoPago ? new Date(dto.vencimientoPago.length <= 10 ? `${dto.vencimientoPago}T00:00:00` : dto.vencimientoPago) : null,
        recepcion: !!dto.recepcion,
        bonificacion: bonifPct, bonificacionImporte: r2(bonificacionImporte),
        subtotalNeto, ivaTotal, percepcionesTotal: r2(percepcionesTotal), total,
        netoCafeteria,
        /* Un comprobante no fiscal NO GUARDA CAE. Se podía cargar el papel de una
         * factura A real (con su CAE y su IVA) eligiendo tipo liquidación: la
         * API forzaba IVA 0 y letra X pero se guardaba el CAE igual, y quedaba un
         * no fiscal con número de autorización de ARCA. Aparte de perder el
         * crédito fiscal de esa factura, deja lista la trampa para cualquier
         * chequeo futuro del estilo "tiene CAE ⇒ es fiscal". */
        cae: fiscal ? String(dto.cae ?? '').slice(0, 32) : '',
        refComprobanteId: dto.refComprobanteId ?? null, observaciones: dto.observaciones ?? '', usuarioId: dto.usuarioId ?? null,
      }).returning();

      await tx.insert(comprobanteItems).values(items.map((it) => ({
        comprobanteId: c.id, productoId: it.productoId, presentacionId: it.presentacionId ?? null,
        cantidad: Number(it.cantidad) || 0, costoUnitario: Number(it.costoUnitario) || 0,
        descuento: Number(it.descuento) || 0, iva: it.iva, subtotal: it.subtotal,
        paraCafeteria: esDelCafe(it as any),
      })));

      /*
       * APRENDER EL MAPEO DE ARTÍCULOS. Si el renglón vino de la lectura del
       * PDF trae el código con el que el proveedor lo imprime: acá — recién al
       * GUARDAR, o sea con una persona confirmando la factura entera — se
       * recuerda (proveedor, código) → producto. La próxima factura del mismo
       * proveedor reconoce el artículo sin similitudes de nombre.
       *
       * Es upsert: si el mapeo existía y el admin eligió otro producto en este
       * alta, la elección nueva PISA la vieja. Un mapeo mal aprendido se
       * corrige solo en la factura siguiente.
       */
      for (const it of dto.items) {
        const codigo = String(it.codigoProveedor ?? '').trim();
        if (!codigo) continue;
        await tx.insert(proveedorArticulos).values({
          proveedorId: prov.id,
          codigo,
          productoId: it.productoId,
          descripcion: String(it.descripcionPapel ?? '').trim().slice(0, 200),
          actualizadoEn: new Date(),
        }).onConflictDoUpdate({
          target: [proveedorArticulos.proveedorId, proveedorArticulos.codigo],
          set: {
            productoId: it.productoId,
            descripcion: String(it.descripcionPapel ?? '').trim().slice(0, 200),
            actualizadoEn: new Date(),
          },
        });
      }

      if (percepciones.length) {
        await tx.insert(comprobantePercepciones).values(
          percepciones.map((p) => ({ comprobanteId: c.id, ...p })),
        );
      }

      /* El compromiso (0068) nace en la MISMA transacción — ver `crearCompromisosTx`. */
      if (compromisosNorm.length) {
        await this.crearCompromisosTx(tx, c, prov, compromisosNorm, NOMBRE_TIPO[dto.tipo]);
      }

      if (ingresaStock) {
        await this.inv.ingresarStockItems(tx, {
          sucursalId: dto.sucursalId, proveedorId: prov.id, proveedorNombre: prov.nombre, usuarioId: dto.usuarioId,
          descripcion: `Recepción ${dto.tipo} ${c.puntoVenta}-${c.numero ?? c.id}`, items: dto.items,
        });
      }

      /* La devolución al proveedor: sale del stock disponible. Si no hay
       * cantidad suficiente el helper corta la transacción — mejor que dejar
       * stock negativo por una NC cargada con el número de bultos equivocado. */
      if (egresaStock) {
        await this.inv.egresarStockItems(tx, {
          sucursalId: dto.sucursalId, usuarioId: dto.usuarioId, tipoMovimiento: 'devolucion',
          descripcion: `Devolución a ${prov.nombre} · NC ${c.puntoVenta}-${c.numero ?? c.id}`,
          items: dto.items,
        });
      }

      /**
       * Los costos que el usuario aceptó actualizar viajan en la MISMA
       * transacción que el comprobante: o queda todo o no queda nada. Se hace
       * después del ingreso de stock porque ese paso puede crear la entrada
       * producto/proveedor que recién entonces existe para actualizar.
       */
      const pedidos = (dto.actualizarCostos ?? []).filter((x) => Number(x.costo) > 0);
      if (pedidos.length) {
        const entradas = await tx.select().from(productoProveedores)
          .where(and(
            eq(productoProveedores.proveedorId, prov.id),
            inArray(productoProveedores.productoId, pedidos.map((x) => x.productoId)),
          ));
        const porProducto = this.formatoPorProducto(entradas);
        const ivaDe = await this.ivaDeProductos(tx, pedidos.map((x) => x.productoId));
        await this.exigirSaltosConfirmados(tx, porProducto, pedidos, dto.confirmarSaltos, ivaDe);

        /**
         * El tamaño del bulto de ESTA entrega (kg o unidades) viaja DENTRO del
         * cambio de costo (0108): si la bolsa pasó de 25 a 20 kg, el precio
         * nuevo del bulto solo tiene sentido con los kilos nuevos, y el lote
         * tiene que poder deshacer los dos juntos si se anula la factura.
         */
        const cambios = pedidos
          .map((x) => {
            const e = porProducto.get(x.productoId);
            return e ? this.cambioDeCosto(e, x, ivaDe.get(x.productoId)) : null;
          })
          .filter(Boolean) as any[];

        if (cambios.length) {
          await this.precios.actualizarCostos({
            cambios,
            origen: 'recepcion',
            motivo: `${dto.tipo} ${c.puntoVenta}-${c.numero ?? c.id} · ${prov.nombre}`,
            usuarioId: dto.usuarioId,
            comprobanteId: c.id,
          } as any, tx);
        }
      }

      // Y el cambio de proveedor activo, si el usuario lo tildó. Va después de
      // actualizar costos para que el precio nuevo salga con el costo nuevo.
      if (dto.activarProveedor?.length) {
        await this.precios.activarProveedor({
          productoIds: dto.activarProveedor,
          proveedorId: prov.id,
          origen: 'recepcion',
          motivo: `${dto.tipo} ${c.puntoVenta}-${c.numero ?? c.id} · ${prov.nombre}`,
          usuarioId: dto.usuarioId,
          comprobanteId: c.id,
        }, tx);
      }

      /**
       * Y se cierra la factura de la bandeja, en la MISMA transacción: si el
       * comprobante no llega a quedar, el papel sigue esperando. Es un UPDATE de
       * una línea y por eso va acá y no invocando al módulo de facturas — traer
       * un módulo entero para esto ataba dos servicios sin necesidad.
       */
      if (dto.lecturaId) {
        const cerrada = await tx.update(facturaLecturas)
          .set({ estado: 'cargada', comprobanteId: c.id })
          .where(and(eq(facturaLecturas.id, dto.lecturaId), eq(facturaLecturas.estado, 'pendiente')))
          .returning({ id: facturaLecturas.id });
        // Cargada = el papel ya no hace falta (pedido del dueño, 28/9/2026): se
        // borra en la misma transacción, así si el alta se cae el papel queda.
        if (cerrada.length) await tx.delete(facturaArchivos).where(eq(facturaArchivos.lecturaId, dto.lecturaId));
      }
      return c.id;
    });
    // La evolución de precios se registra DESPUÉS del commit: dentro de la
    // transacción los costos nuevos todavía no son visibles para el snapshot.
    const tocados = [
      ...(dto.actualizarCostos ?? []).map((x) => x.productoId),
      ...(dto.activarProveedor ?? []),
    ];
    if (tocados.length) {
      await this.precios.registrarEvolucion(tocados, 'costo', {
        detalle: 'Recepción de comprobante', usuarioId: dto.usuarioId ?? null,
      });
    }

    /*
     * EL PAGO, después del commit y a propósito — ver `saldarEnElActo`.
     *
     * Solo los documentos que GENERAN deuda se pagan. Una nota de crédito
     * resta deuda: pagarla no significa nada.
     */
    // LISTA DE TIPOS · genera deuda. La liquidación va acá: al proveedor se le
    // debe la mitad no facturada igual que la facturada, y se le paga junto.
    const generaDeuda = estado === 'confirmado'
      && (dto.tipo === 'factura' || dto.tipo === 'liquidacion' || dto.tipo === 'nota_debito');
    if (generaDeuda) {
      await this.saldarEnElActo(id, {
        proveedorId: prov.id,
        concepto: `${dto.tipo} ${letraDoc} ${puntoVenta}-${dto.numero ?? id}`.trim(),
        fecha: dto.fecha,
        sucursalId: dto.sucursalId,
        usuarioId: dto.usuarioId,
        tomarPagos: dto.tomarPagos,
        pagoContado: dto.pagoContado,
      }, opciones);
    }
    /*
     * Si esta nota ajusta una factura, el saldo de ESA factura acaba de
     * cambiar: el puente de compromisos (0068) corre para cerrarlos — la NC
     * que salda el resto de una factura en cuenta corriente tiene que apagar
     * su compromiso igual que lo apagaría un pago.
     */
    if (esNota && dto.refComprobanteId && estado === 'confirmado') {
      await this.pagos.sincronizarComprobante(dto.refComprobanteId);
    }
    return this.get(id);
  }

  /**
   * LLEGÓ LA FACTURA DE UN REMITO (26/8) — el remito PASA A SER la factura.
   * ==========================================================================
   * El circuito real que esto resuelve: el proveedor entrega la mercadería con
   * un remito y la factura llega días después. El remito ya ingresó el stock
   * (se vende desde el día uno); cuando aparece el papel, este método convierte
   * ESE documento en la factura — mismo id, misma mercadería— completando lo
   * que el remito no tenía: número y letra del papel, precios reales, pie
   * (bonificación, percepciones, IVA), la deuda del proveedor y el pago.
   *
   * LO QUE NO HACE, y es todo el punto: **no toca el stock**. La mercadería
   * entró UNA vez, con el remito. Cargar la factura como documento nuevo la
   * ingresaba de vuelta — el agujero que motivó este circuito.
   *
   * Producto y cantidad de cada renglón quedan CLAVADOS (son lo que entró al
   * depósito); si el papel difiere en cantidades, eso es una diferencia de
   * entrega y se resuelve como siempre: ajuste de stock o nota de crédito.
   * Es el espejo de Ventas ⚠ Sin facturar (0073): el documento provisorio
   * pasa a ser el definitivo, con rastro en observaciones.
   */
  /** La letra tiene que ser una que ese proveedor PUEDE emitir (ver LETRAS_POR_CONDICION). */
  private exigirLetra(letra: string, prov: { nombre: string; condicionIva?: string | null }) {
    if (letra === 'X') {
      throw new BadRequestException('Una factura X no es fiscal: si no hay factura, cargalo como liquidación.');
    }
    const cond = prov.condicionIva ?? 'responsable_inscripto';
    const permitidas = LETRAS_POR_CONDICION[cond] ?? ['A', 'B', 'C'];
    if (!permitidas.includes(letra)) {
      throw new BadRequestException(
        `${prov.nombre} figura como ${CONDICION_TEXTO[cond] ?? cond}: emite factura ${permitidas.join(' o ')}, no ${letra}. `
        + 'Si el papel dice otra cosa, corregí su condición frente al IVA en la ficha del proveedor.',
      );
    }
  }

  /**
   * LAS FECHAS, con sentido (26/9/2026): una fecha mal escrita daba "error del
   * servidor", se aceptaba una factura del 2030 y un vencimiento anterior a la
   * emisión. Un día de margen hacia adelante por el huso horario.
   */
  private validarFechas(dto: { fecha?: string; vencimientoPago?: string; fechaCarga?: string }) {
    const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const leer = (v: string | undefined, campo: string) => {
      if (v == null || v === '') return null;
      const corta = String(v).length <= 10;
      const d = new Date(corta ? `${v}T00:00:00` : v);
      if (Number.isNaN(d.getTime()) || (corta && (!/^\d{4}-\d{2}-\d{2}$/.test(v) || iso(d) !== v))) {
        throw new BadRequestException(`La ${campo} no es una fecha válida (${v}).`);
      }
      return d;
    };
    const fecha = leer(dto.fecha, 'fecha del comprobante');
    const venc = leer(dto.vencimientoPago, 'fecha de vencimiento del pago');
    const carga = leer(dto.fechaCarga, 'fecha de carga');
    const manana = Date.now() + 36 * 3600 * 1000;
    if (fecha && fecha.getTime() > manana) {
      throw new BadRequestException('La fecha del comprobante es futura: revisá el día y el año del papel.');
    }
    if (fecha && fecha.getTime() < Date.now() - 3 * 366 * 86400000) {
      throw new BadRequestException('La fecha del comprobante tiene más de tres años: revisá el año del papel.');
    }
    if (carga && carga.getTime() > manana) throw new BadRequestException('La fecha de carga no puede ser futura.');
    if (venc && fecha && iso(venc) < iso(fecha)) {
      throw new BadRequestException('El vencimiento del pago no puede ser anterior a la fecha del comprobante.');
    }
  }

  /**
   * EL FORMATO DE ESTE PROVEEDOR PARA CADA PRODUCTO — uno solo y siempre el
   * mismo (26/9/2026): el de id más bajo, igual que `formatoDeProveedor` del
   * inventario y que la pantalla. Con dos formatos del mismo proveedor (caja
   * x6 y x12) el Map se quedaba con el último que devolviera la base, sin
   * orden: la pantalla comparaba contra uno y se grababa en el otro.
   */
  private formatoPorProducto(entradas: any[]) {
    const out = new Map<number, any>();
    for (const e of [...entradas].sort((x, y) => x.id - y.id)) if (!out.has(e.productoId)) out.set(e.productoId, e);
    return out;
  }

  /** La alícuota de cada producto: el modo "precio final" la necesita para su cuenta. */
  private async ivaDeProductos(ex: any, ids: number[]) {
    if (!ids.length) return new Map<number, number>();
    const filas = await ex.select({ id: productos.id, iva: productos.iva }).from(productos).where(inArray(productos.id, ids));
    return new Map<number, number>(filas.map((p: any) => [p.id, Number(p.iva) || 0]));
  }

  /**
   * EL CAMBIO DE COSTO QUE DEJA LA FACTURA EN UN FORMATO (26/9/2026).
   *
   * En modo LISTA la factura escribe su costo de lista y el bulto; los
   * descuentos del formato siguen aplicando (o se trasladan, si se tildó).
   *
   * En modo PRECIO FINAL lo que manda es "lo que se paga por el bulto, papeles
   * sumados" (`costoFinal`), y el costo de lista no entra en ninguna cuenta: la
   * factura escribía `costo`, el historial decía "0 → X" y la góndola no se
   * movía nunca. Ahora se escribe el precio final que corresponde al papel:
   * la mercadería neta del bulto (lista × (1 − descuento del papel)) llevada a
   * desembolso con la misma fórmula del formato — (1−q)·(1+IVA) + q —, así que
   * el costo neto que deriva el motor es exactamente el de la factura.
   */
  private cambioDeCosto(e: any, x: PedidoCosto, iva = 0) {
    return cambioDeCostoFormato(e, x, iva);
  }

  /**
   * LA GÓNDOLA QUE VA A DEJAR ESTA FACTURA, antes de registrarla (26/9/2026).
   *
   * La pantalla la calculaba con una copia propia de la cuenta y le erraba
   * justo donde duele: sin el IVA (con "% sin factura" o en precio final daba
   * hasta un 21% de más), moviendo precios FIJOS que en la caja no se mueven,
   * con el margen deducido del precio ya redondeado y con el redondeo general
   * en vez del del producto. Ahora la calcula el servidor reproduciendo paso a
   * paso lo que va a hacer el registro —el formato nuevo si la recepción lo
   * crea, el cambio de costo (`cambioDeCostoFormato` + `aplicarCambioCosto`) y
   * el proveedor activo— y derivando el precio con la función del historial y
   * del POS. No graba nada.
   */
  async proyectarPrecios(dto: ProyeccionPreciosDto) {
    const pedidos = (dto.actualizarCostos ?? []).filter((x) => Number(x.costo) > 0);
    const activar = new Set((dto.activarProveedor ?? []).map(Number));
    const items = dto.items ?? [];
    const ids = [...new Set([...pedidos.map((x) => x.productoId), ...activar, ...items.map((x) => x.productoId)])]
      .map(Number).filter((n) => n > 0).slice(0, 500);
    const ivaDe = await this.ivaDeProductos(this.db, ids);
    const proyeccion = await this.precios.proyectarPiso(ids, (formatos) => {
      for (const pid of ids) {
        /* El formato de ESTE proveedor: el de id más bajo, igual que el registro. */
        let mio = formatos.filter((f) => f.productoId === pid && f.proveedorId === dto.proveedorId)
          .sort((a, b) => a.id - b.id)[0];
        /* La recepción lo CREA si no existe (con el costo del renglón, bulto 1),
         * y lo deja activo solo si el producto no tenía ninguno. */
        const it = items.find((x) => Number(x.productoId) === pid);
        if (!mio && dto.recepcion && it) {
          mio = {
            /* Un formato nuevo lleva el id más ALTO (es el último en nacer). */
            id: Number.MAX_SAFE_INTEGER - pid, productoId: pid, proveedorId: dto.proveedorId, costo: Number(it.costoUnitario) || 0,
            descuento: 0, descuento2: 0, descuento3: 0, descuento4: 0, flete: 0, cantidad: 1,
            modoCosto: 'lista', costoFinal: 0, porcSinFactura: 0, usarParaPrecio: false,
          };
          if (!formatos.some((f) => f.productoId === pid && f.usarParaPrecio)) mio.usarParaPrecio = true;
          formatos.push(mio);
        }
        if (!mio) continue;
        const x = pedidos.find((p) => p.productoId === pid);
        if (x) Object.assign(mio, aplicarCambioCosto(mio, cambioDeCostoFormato(mio, x, ivaDe.get(pid) ?? 0)));
        if (activar.has(pid)) {
          for (const f of formatos) if (f.productoId === pid) f.usarParaPrecio = false;
          mio.usarParaPrecio = true;
        }
      }
      return formatos;
    });
    return proyeccion.map((p: any) => ({
      ...p,
      /* ¿El formato de este proveedor es el que fija el precio después? */
      defineEsteProveedor: p.formatoActivoDespues?.proveedorId === dto.proveedorId,
    }));
  }

  /**
   * UN SALTO DE MÁS DE ×3 EN EL COSTO POR UNIDAD SE CONFIRMA (26/9/2026).
   *
   * Un cero de menos en el bulto (1 en vez de 10) o en el costo multiplica el
   * $/u. y la góndola lo sigue al instante: el Aceite pasó de $19.402 a
   * $194.020 con una factura. Los aumentos reales de un proveedor no son ×3 de
   * una entrega a otra, así que por encima de eso se frena y se pide que
   * alguien lo mire; si es real (cambió el tamaño de verdad), se confirma con
   * un tilde y pasa. La primera compra (sin costo previo) no se compara.
   */
  private async exigirSaltosConfirmados(
    ex: any, formatos: Map<number, any>,
    pedidos: { productoId: number; costo: number; cantidad?: number; descuentoPapel?: number }[],
    confirmados?: number[],
    ivaDe: Map<number, number> = new Map(),
  ) {
    const ok = new Set(confirmados ?? []);
    const saltos: { productoId: number; antes: number; despues: number; factor: number }[] = [];
    for (const x of pedidos) {
      const e = formatos.get(x.productoId);
      if (!e || ok.has(x.productoId)) continue;
      const bulto = Number(x.cantidad) > 0 ? Number(x.cantidad) : (Number(e.cantidad) > 0 ? Number(e.cantidad) : 1);
      /* Se compara lo comparable: en modo lista, lista contra lista; en modo
       * final, el costo neto que deriva el formato contra el neto del papel. */
      let antes: number; let despues: number;
      if (e.modoCosto === 'final') {
        antes = costosFormato(e, ivaDe.get(x.productoId) ?? 0).costoNetoUnitario;
        despues = (Number(x.costo) || 0) * (1 - (Number(x.descuentoPapel) || 0) / 100) / bulto;
      } else {
        antes = Number(e.costo) / (Number(e.cantidad) > 0 ? Number(e.cantidad) : 1);
        despues = Number(x.costo) / bulto;
      }
      if (!(antes > 0)) continue;
      const factor = despues / antes;
      if (factor > SALTO_COSTO || factor < 1 / SALTO_COSTO) saltos.push({ productoId: x.productoId, antes, despues, factor });
    }
    if (!saltos.length) return;
    const nombres = new Map<number, any>((await ex.select({ id: productos.id, nombre: productos.nombre, tipo: productos.tipo })
      .from(productos).where(inArray(productos.id, saltos.map((z) => z.productoId)))).map((p: any) => [p.id, p]));
    const $ = (n: number) => `$${n.toLocaleString('es-AR', { maximumFractionDigits: 2 })}`;
    const detalle = saltos.map((z) => {
      const p = nombres.get(z.productoId);
      const u = p?.tipo === 'granel' ? 'kg' : 'u.';
      const veces = z.factor >= 1 ? `×${z.factor.toFixed(1).replace('.', ',')}` : `÷${(1 / z.factor).toFixed(1).replace('.', ',')}`;
      return `${p?.nombre ?? 'Un producto'}: ${$(z.antes)} → ${$(z.despues)} por ${u} (${veces})`;
    }).join('; ');
    throw new BadRequestException(
      `Revisá el bulto y el costo antes de actualizar: ${detalle}. Un salto así suele ser un error de tipeo `
      + 'y mueve la góndola al instante. Si es correcto, tildá "Es correcto" en Impacto en precios.',
    );
  }

  /** Productos por unidad y paquetes van enteros; solo el granel suelto va en kilos. */
  private async exigirUnidadesEnteras(items: { productoId: number; presentacionId?: number | null; cantidad: number }[]) {
    const ids = [...new Set(items.map((x) => Number(x.productoId)))];
    if (!ids.length) return;
    const prods = await this.db.select({ id: productos.id, nombre: productos.nombre, tipo: productos.tipo }).from(productos).where(inArray(productos.id, ids));
    const de = new Map(prods.map((p: any) => [p.id, p]));
    for (const it of items) {
      const p: any = de.get(Number(it.productoId));
      const enKg = p?.tipo === 'granel' && !it.presentacionId;
      const c = Number(it.cantidad) || 0;
      if (!enKg && Math.abs(c - Math.round(c)) > 1e-9) {
        throw new BadRequestException(`${p?.nombre ?? 'Un producto'}: ${it.presentacionId ? 'los paquetes' : 'las unidades'} van enteras (llegó ${String(c).replace('.', ',')}).`);
      }
    }
  }

  /**
   * EL PAPEL DE LA BANDEJA TIENE QUE SER ESTE COMPROBANTE (26/9/2026). Se
   * podía "procesar" el papel de un proveedor cargando la factura de otro, por
   * otro importe, y el papel quedaba "cargado" igual. Se compara lo que el
   * papel dice (lo leído del QR o lo corregido a mano en la bandeja).
   */
  private async exigirLecturaCoincide(lecturaId: number, prov: { id: number; nombre: string }, doc: {
    tipo: string; letra: string; puntoVenta: string; numero: number | null; total: number;
  }) {
    const [l] = await this.db.select().from(facturaLecturas).where(eq(facturaLecturas.id, lecturaId)).limit(1);
    if (!l) throw new BadRequestException('Ese papel de la bandeja no existe.');
    if (l.estado !== 'pendiente') throw new BadRequestException(`Ese papel ya está ${l.estado}: no se puede volver a cargar.`);
    const distinto: string[] = [];
    if (l.proveedorId && l.proveedorId !== prov.id) {
      const [otro] = await this.db.select({ nombre: proveedores.nombre }).from(proveedores).where(eq(proveedores.id, l.proveedorId)).limit(1);
      distinto.push(`el papel es de ${otro?.nombre ?? 'otro proveedor'} y se está cargando a ${prov.nombre}`);
    }
    if (l.tipo && l.tipo !== doc.tipo) distinto.push(`el papel es ${l.tipo.replace('_', ' ')} y se carga como ${doc.tipo.replace('_', ' ')}`);
    if (l.letra && l.letra !== doc.letra) distinto.push(`el papel es letra ${l.letra} y se carga como ${doc.letra}`);
    if (l.puntoVenta && normalizarPuntoVenta(l.puntoVenta) !== doc.puntoVenta) distinto.push(`el punto de venta del papel es ${normalizarPuntoVenta(l.puntoVenta)}, no ${doc.puntoVenta}`);
    if (l.numero && doc.numero && Number(l.numero) !== Number(doc.numero)) distinto.push(`el número del papel es ${l.numero}, no ${doc.numero}`);
    if (Number(l.total) > 0 && Math.abs(Number(l.total) - doc.total) > 1) {
      distinto.push(`el papel dice $${Number(l.total).toFixed(2)} y lo cargado da $${doc.total.toFixed(2)}`);
    }
    if (distinto.length) {
      throw new BadRequestException(
        `Lo cargado no coincide con el papel de la bandeja: ${distinto.join('; ')}. `
        + 'Revisá los renglones, la bonificación y las percepciones, o corregí el papel en Procesamiento de facturas.',
      );
    }
  }

  /**
   * LOS COSTOS SE ACTUALIZAN SOLO DE LO QUE VINO EN ESTE PAPEL (26/9/2026).
   * El servidor aceptaba cambiar desde una factura el costo de cualquier
   * producto: un renglón mal mandado dejaba el cereal a $1 y su góndola en el
   * piso sin que ese producto estuviera en la factura. El costo de lo que no
   * se compró se cambia desde Precios, donde se ve lo que se toca.
   */
  private exigirCostosDeLaFactura(productoIds: number[], actualizar?: { productoId: number }[], activar?: number[]) {
    const enPapel = new Set(productoIds.map(Number));
    const ajenos = [...(actualizar ?? []).map((x) => Number(x.productoId)), ...(activar ?? []).map(Number)]
      .filter((pid) => !enPapel.has(pid));
    if (ajenos.length) {
      throw new BadRequestException(
        `Se quiso cambiar el costo de ${ajenos.length === 1 ? 'un producto que no está' : `${ajenos.length} productos que no están`} en este comprobante. `
        + 'Desde una factura solo se actualiza lo que vino en ella; el resto se cambia desde Precios.',
      );
    }
  }

  /**
   * El tope de una NC contra su factura, dentro de la transacción del alta y
   * con la factura tomada (FOR UPDATE): importe y, si devuelve mercadería,
   * cantidades por producto. Las anuladas no cuentan.
   */
  private async exigirTopeNotaCredito(tx: any, refId: number, totalNota: number, devueltos: any[] | null) {
    const [ref] = await tx.select().from(comprobantes).where(eq(comprobantes.id, refId)).limit(1).for('update');
    if (!ref) throw new BadRequestException('La factura que se quiere ajustar no existe.');
    const notas = await tx.select().from(comprobantes)
      .where(and(eq(comprobantes.refComprobanteId, refId), eq(comprobantes.estado, 'confirmado')));
    const nc = notas.filter((n: any) => n.tipo === 'nota_credito').reduce((a: number, n: any) => a + Number(n.total), 0);
    const nd = notas.filter((n: any) => n.tipo === 'nota_debito').reduce((a: number, n: any) => a + Number(n.total), 0);
    const queda = r2(Number(ref.total) + nd - nc);
    if (totalNota > queda + 0.009) {
      throw new BadRequestException(
        `La nota de crédito es de $${r2(totalNota).toFixed(2)} y a ${etiquetaDoc(ref)} le quedan $${queda.toFixed(2)} para ajustar`
        + `${nc > 0.009 ? ` (ya tiene $${r2(nc).toFixed(2)} en notas de crédito)` : ''}. Revisá el importe.`,
      );
    }
    if (!devueltos) return;
    const clave = (x: any) => `${x.productoId}:${x.presentacionId ?? ''}`;
    const vino = new Map<string, number>();
    for (const it of await tx.select().from(comprobanteItems).where(eq(comprobanteItems.comprobanteId, refId))) {
      vino.set(clave(it), (vino.get(clave(it)) ?? 0) + Number(it.cantidad));
    }
    const idsNC = notas.filter((n: any) => n.tipo === 'nota_credito' && n.recepcion).map((n: any) => n.id);
    const yaDevuelto = new Map<string, number>();
    if (idsNC.length) {
      for (const it of await tx.select().from(comprobanteItems).where(inArray(comprobanteItems.comprobanteId, idsNC))) {
        yaDevuelto.set(clave(it), (yaDevuelto.get(clave(it)) ?? 0) + Number(it.cantidad));
      }
    }
    const pide = new Map<string, number>();
    for (const it of devueltos) pide.set(clave(it), (pide.get(clave(it)) ?? 0) + (Number(it.cantidad) || 0));
    const nombres = new Map((await tx.select({ id: productos.id, nombre: productos.nombre }).from(productos)
      .where(inArray(productos.id, [...new Set(devueltos.map((x: any) => Number(x.productoId)))]))).map((p: any) => [p.id, p.nombre]));
    const problemas: string[] = [];
    for (const [k, c] of pide) {
      const pid = Number(k.split(':')[0]);
      const libre = r2((vino.get(k) ?? 0) - (yaDevuelto.get(k) ?? 0));
      if (!vino.has(k)) problemas.push(`${nombres.get(pid) ?? `#${pid}`} no vino en esa factura`);
      else if (c > libre + 1e-9) problemas.push(`${nombres.get(pid) ?? `#${pid}`}: se devuelven ${c} y de esa factura quedan ${libre} por devolver`);
    }
    if (problemas.length) throw new BadRequestException(`La devolución no cierra con ${etiquetaDoc(ref)}: ${problemas.join('; ')}.`);
  }

  /* ==================================================================== *
   * ANULAR UN COMPROBANTE (0106)
   * ==================================================================== */

  /**
   * QUÉ PASARÍA SI SE ANULA, sin tocar nada. La pantalla lo muestra ANTES de
   * pedir la confirmación: lo que frena (con la acción para destrabarlo) y lo
   * que se va a deshacer. `anular` vuelve a calcular todo adentro de su
   * transacción — esto es para leer, no una promesa.
   */
  async previsualizarAnulacion(id: number) {
    const [c] = await this.db.select().from(comprobantes).where(eq(comprobantes.id, id)).limit(1);
    if (!c) throw new NotFoundException('Comprobante inexistente.');
    return this.planAnulacion(this.db, c);
  }

  private async planAnulacion(ex: any, c: any) {
    const bloqueos: string[] = [];
    if (c.estado === 'anulado') {
      return {
        comprobante: { id: c.id, etiqueta: etiquetaDoc(c), estado: c.estado, total: Number(c.total) },
        puedeAnular: false, bloqueos: ['Ya está anulado.'], pagos: [], notas: [],
        stock: { sentido: 0, sucursalId: c.sucursalId, renglones: [] as any[] }, costos: [] as any[],
        cuotasPendientes: 0, lectura: null, lotes: [] as string[],
      };
    }

    /* Pagos aplicados: la plata ya salió contra este papel. Se desaplican
     * primero (quedan a cuenta del proveedor, para la factura correcta). */
    const pagos = await ex.select({
      imputacionId: proveedorImputaciones.id, pagoId: proveedorPagos.id, importe: proveedorImputaciones.importe,
      fecha: proveedorPagos.fecha, medio: proveedorPagos.medio,
    }).from(proveedorImputaciones)
      .innerJoin(proveedorPagos, eq(proveedorPagos.id, proveedorImputaciones.pagoId))
      .where(and(eq(proveedorImputaciones.comprobanteId, c.id), ne(proveedorPagos.estado, 'anulado')));
    if (pagos.length) {
      const total = pagos.reduce((a: number, p: any) => a + Number(p.importe), 0);
      bloqueos.push(`Tiene ${pagos.length} pago(s) aplicado(s) por $${total.toFixed(2)}: desaplicalos primero (quedan a cuenta del proveedor).`);
    }

    /* Notas que la ajustan: anularla dejaría una NC restando de una factura que no existe. */
    const notas = await ex.select({ id: comprobantes.id, tipo: comprobantes.tipo, letra: comprobantes.letra, puntoVenta: comprobantes.puntoVenta, numero: comprobantes.numero })
      .from(comprobantes)
      .where(and(eq(comprobantes.refComprobanteId, c.id), eq(comprobantes.estado, 'confirmado')));
    if (notas.length) {
      bloqueos.push(`La ajusta${notas.length > 1 ? 'n' : ''} ${notas.map((n: any) => etiquetaDoc(n)).join(', ')}: anulá primero ${notas.length > 1 ? 'esas notas' : 'esa nota'}.`);
    }

    /* El stock: sale lo que ingresó (factura, remito, liquidación) o vuelve lo
     * que la NC devolvió. Sin recepción o sin sucursal, no se mueve nada. */
    const items = await ex.select().from(comprobanteItems).where(eq(comprobanteItems.comprobanteId, c.id));
    const sentido: 0 | 1 | -1 = !c.recepcion || !c.sucursalId ? 0
      : (['factura', 'remito', 'liquidacion'].includes(c.tipo) ? -1 : (c.tipo === 'nota_credito' ? 1 : 0));
    const renglones = items.map((it: any) => ({ productoId: it.productoId, presentacionId: it.presentacionId ?? null, cantidad: Number(it.cantidad) || 0 }));
    const stock = sentido === 0 ? [] : (await this.inv.stockDeRenglones(c.sucursalId, renglones))
      .map((x) => ({ ...x, alcanza: sentido > 0 || x.libre || x.hay + 1e-9 >= x.cantidad }));
    const noAlcanza = stock.filter((x) => !x.alcanza);
    /* Con una nota viva, lo que falta en el stock suele ser justamente lo que
     * esa nota devolvió: se revisa después de anularla, no antes. */
    if (noAlcanza.length && !notas.length) {
      bloqueos.push(`Ya se vendió o se movió parte de la mercadería: ${noAlcanza.map((x) => `${x.nombre} (ingresaron ${x.cantidad}, hay ${x.hay})`).join('; ')}. Para devolverla al proveedor, cargá una nota de crédito.`);
    }

    /* Los costos que cambió este comprobante, por lote. */
    const lotes = (await ex.selectDistinct({ lote: productoProveedorCostos.lote }).from(productoProveedorCostos)
      .where(and(eq(productoProveedorCostos.comprobanteId, c.id), ne(productoProveedorCostos.origen, 'reversion' as any))))
      .map((x: any) => x.lote).filter(Boolean);
    const costos: any[] = [];
    for (const lote of lotes) {
      const ev = await this.precios.evaluarLote(ex, lote);
      const nombres = await ex.select({ ppId: productoProveedores.id, nombre: productos.nombre }).from(productoProveedores)
        .innerJoin(productos, eq(productos.id, productoProveedores.productoId))
        .where(inArray(productoProveedores.id, ev.filas.map((f: any) => f.productoProveedorId)));
      const nombreDe = new Map(nombres.map((n: any) => [n.ppId, n.nombre]));
      for (const { f } of ev.revertibles) costos.push({ producto: nombreDe.get(f.productoProveedorId), de: f.costo, a: f.costoAnterior, vuelve: true, ...(f.cantidad != null ? { bultoDe: f.cantidad, bultoA: f.cantidadAnterior } : {}) });
      for (const x of ev.salteadas) costos.push({ producto: nombreDe.get(x.id), de: x.f?.costo, a: x.f?.costoAnterior, vuelve: false, motivo: x.motivo });
    }

    const compromisos = await ex.select({ id: proveedorCompromisos.id }).from(proveedorCompromisos)
      .where(and(eq(proveedorCompromisos.comprobanteId, c.id), eq(proveedorCompromisos.pagado, false)));
    const [lectura] = await ex.select({ id: facturaLecturas.id }).from(facturaLecturas)
      .where(eq(facturaLecturas.comprobanteId, c.id)).limit(1);

    return {
      comprobante: { id: c.id, etiqueta: etiquetaDoc(c), estado: c.estado, total: Number(c.total) },
      puedeAnular: bloqueos.length === 0,
      bloqueos,
      pagos,
      notas: notas.map((n: any) => ({ id: n.id, etiqueta: etiquetaDoc(n) })),
      stock: { sentido, sucursalId: c.sucursalId, renglones: stock },
      costos,
      cuotasPendientes: compromisos.length,
      lectura: lectura?.id ?? null,
      lotes,
    };
  }

  /**
   * ANULAR (0106). Deshace, en UNA transacción, todo lo que el comprobante
   * hizo al cargarse: el stock, los costos (los que nadie volvió a tocar), las
   * cuotas pendientes y el papel de la bandeja, que vuelve a "por procesar".
   * No se borra: queda "anulado" con quién, cuándo y por qué.
   *
   * Lo que FRENA no se resuelve solo, porque cada cosa es una decisión: los
   * pagos aplicados se desaplican a mano (la plata ya salió), las notas que lo
   * ajustan se anulan antes, y la mercadería que ya se vendió no se puede
   * "des-ingresar" — eso es una nota de crédito de devolución.
   */
  async anular(id: number, dto: AnularComprobanteDto, opciones: { puedeTocarPrecios: boolean; puedeLiquidaciones: boolean }) {
    const motivo = String(dto.motivo ?? '').trim();
    if (motivo.length < 3) throw new BadRequestException('Escribí el motivo de la anulación: queda en el comprobante.');

    const r = await this.db.transaction(async (tx) => {
      const [c] = await tx.select().from(comprobantes).where(eq(comprobantes.id, id)).limit(1).for('update');
      if (!c) throw new NotFoundException('Comprobante inexistente.');
      await exigirFueraDeConciliado(tx, c.proveedorId, c.fecha, 'anular un comprobante');
      if (c.tipo === 'liquidacion' && !opciones.puedeLiquidaciones) {
        throw new ForbiddenException('Anular una liquidación pide el permiso de liquidaciones.');
      }
      const plan = await this.planAnulacion(tx, c);
      if (!plan.puedeAnular) throw new BadRequestException(plan.bloqueos.join(' '));
      if (plan.costos.some((x: any) => x.vuelve) && !opciones.puedeTocarPrecios) {
        throw new ForbiddenException('Este comprobante cambió costos: anularlo los vuelve atrás, y eso pide el permiso de precios.');
      }

      if (plan.stock.sentido !== 0) {
        await this.inv.revertirStockComprobante(tx, {
          sucursalId: c.sucursalId!, sentido: plan.stock.sentido as 1 | -1, usuarioId: dto.usuarioId ?? null,
          descripcion: `Anulación de ${etiquetaDoc(c)}: ${motivo}`,
          items: plan.stock.renglones.map((x: any) => ({ productoId: x.productoId, presentacionId: x.presentacionId, cantidad: x.cantidad })),
        });
      }

      const tocados: number[] = [];
      for (const lote of plan.lotes) {
        const rv = await this.precios.revertirLoteTx(tx, lote, dto.usuarioId ?? undefined);
        tocados.push(...rv.productoIds);
      }

      // Las cuotas que todavía no se pagaron: sin factura no hay promesa.
      const pendientes = await tx.select({ id: proveedorCompromisos.id }).from(proveedorCompromisos)
        .where(and(eq(proveedorCompromisos.comprobanteId, c.id), eq(proveedorCompromisos.pagado, false)));
      if (pendientes.length) {
        const ids = pendientes.map((x: any) => x.id);
        await tx.update(proveedorEcheqs).set({ estado: 'anulado' })
          .where(and(inArray(proveedorEcheqs.compromisoId, ids), inArray(proveedorEcheqs.estado, ['emitido', 'entregado'])));
        await tx.delete(proveedorCompromisos).where(inArray(proveedorCompromisos.id, ids));
      }

      // El papel vuelve a la bandeja: sigue siendo la factura del proveedor, y
      // la carga correcta se hace desde ahí.
      await tx.update(facturaLecturas).set({ estado: 'pendiente', comprobanteId: null })
        .where(eq(facturaLecturas.comprobanteId, c.id));

      const [anulado] = await tx.update(comprobantes).set({
        estado: 'anulado', anuladoEn: new Date(), anuladoPor: dto.usuarioId ?? null, motivoAnulacion: motivo,
      }).where(and(eq(comprobantes.id, c.id), ne(comprobantes.estado, 'anulado'))).returning();
      if (!anulado) throw new BadRequestException('Ya está anulado.');
      /* Si ya estaba en un mes cerrado de la cuenta con Coffit, el cierre lo
       * contó: la anulación deja el ajuste contrario en el mes abierto (0120). */
      if (Number(c.netoCafeteria) > 0 && ['factura', 'liquidacion', 'nota_debito', 'nota_credito'].includes(c.tipo)) {
        await ajustePorAnulacion(tx, {
          fechaCuenta: c.cuentaFecha ?? c.fecha,
          efecto: Number(c.netoCafeteria) * (c.tipo === 'nota_credito' ? -1 : 1),
          documento: etiquetaDoc(c),
          usuarioId: dto.usuarioId ?? null,
        });
      }
      return { c: anulado, plan, tocados };
    });

    // Después del commit, como en el alta: la evolución de precios y las
    // cuotas de la factura que esta nota ajustaba.
    if (r.tocados.length) {
      await this.precios.registrarEvolucion([...new Set(r.tocados)], 'reversion', {
        detalle: `Anulación de ${etiquetaDoc(r.c)}`, usuarioId: dto.usuarioId ?? null,
      });
    }
    if (r.c.refComprobanteId) await this.pagos.sincronizarComprobante(r.c.refComprobanteId);
    return {
      ok: true,
      comprobante: r.c,
      stock: r.plan.stock,
      costosRevertidos: r.plan.costos.filter((x: any) => x.vuelve).length,
      costosQueQuedan: r.plan.costos.filter((x: any) => !x.vuelve),
      cuotasBorradas: r.plan.cuotasPendientes,
      lecturaDevuelta: r.plan.lectura,
    };
  }

  /** "Llegó la factura", con el mismo trato del choque de base que el alta. */
  async facturar(id: number, dto: FacturarRemitoDto, opciones: { puedeTocarPrecios?: boolean; sucursalSesion: number; cruzaSucursales?: boolean }) {
    try {
      return await this.facturarRemito(id, dto, opciones);
    } catch (e) {
      if (esDuplicadoDeBase(e)) {
        throw new BadRequestException('Esa factura ya está cargada para este proveedor (mismo número y letra). Revisá el número del papel.');
      }
      throw e;
    }
  }

  private async facturarRemito(
    id: number,
    dto: FacturarRemitoDto,
    opciones: { puedeTocarPrecios?: boolean; sucursalSesion: number; cruzaSucursales?: boolean },
  ) {
    // El mismo corte de permisos que el alta: facturar también puede tocar precios.
    if (!opciones.puedeTocarPrecios && (dto.actualizarCostos?.length || dto.activarProveedor?.length)) {
      throw new ForbiddenException(
        'Para actualizar costos o cambiar el proveedor activo hace falta el permiso de precios. '
        + 'Facturá el remito sin esa parte y pedile a quien maneja precios que la haga.',
      );
    }

    const [c] = await this.db.select().from(comprobantes).where(eq(comprobantes.id, id)).limit(1);
    if (!c) throw new NotFoundException('Comprobante inexistente.');
    if (c.tipo !== 'remito') {
      throw new BadRequestException(`${etiquetaDoc(c)} no es un remito: solo un remito pendiente se convierte en factura.`);
    }
    if (c.estado !== 'confirmado') {
      throw new BadRequestException(`El remito está ${c.estado}: no se puede facturar.`);
    }
    const [prov] = await this.db.select().from(proveedores).where(eq(proveedores.id, c.proveedorId)).limit(1);
    if (!prov) throw new BadRequestException('El proveedor del remito ya no existe.');
    await exigirFueraDeConciliado(this.db, prov.id, dto.fecha ?? c.fecha, 'facturar un remito');

    const filasRemito = await this.db.select().from(comprobanteItems)
      .where(eq(comprobanteItems.comprobanteId, id)).orderBy(comprobanteItems.id);
    if (!filasRemito.length) throw new BadRequestException('El remito no tiene ítems.');

    /* Los precios corregidos viajan POR itemId: no hay matching por producto ni
     * forma de colar un renglón nuevo. Un itemId ajeno corta todo. */
    const porItem = new Map((dto.items ?? []).map((x) => [Number(x.itemId), x]));
    for (const k of porItem.keys()) {
      if (!filasRemito.some((f) => f.id === k)) {
        throw new BadRequestException('Uno de los renglones enviados no pertenece a este remito.');
      }
    }

    const esRI = prov.condicionIva === 'responsable_inscripto';
    const ivaDefault = esRI ? 21 : 0;
    // La factura que llegó: su letra decide el IVA, igual que en el alta.
    const letraFactura = dto.letra ?? letraPorDefecto(prov.condicionIva);
    this.exigirLetra(letraFactura, prov);
    this.validarFechas(dto);
    const base = filasRemito.map((f) => {
      const o = porItem.get(f.id);
      return {
        itemId: f.id,
        // CLAVADOS: el producto y la cantidad son lo que entró al depósito.
        productoId: f.productoId,
        cantidad: f.cantidad,
        costoUnitario: o?.costoUnitario != null ? Number(o.costoUnitario) : f.costoUnitario,
        descuento: o?.descuento != null ? Number(o.descuento) : f.descuento,
        iva: o?.iva != null ? Number(o.iva) : (f.iva ?? ivaDefault),
      };
    });

    // El MISMO pie que el alta (armarPie), armado con los renglones del
    // remito y los precios del papel: la factura siempre es fiscal.
    const pieReal = this.armarPie(
      { items: base, bonificacion: dto.bonificacion, bonificacionImporte: dto.bonificacionImporte, percepciones: dto.percepciones },
      true,
      ivaDefault,
      letraFactura === 'A',
    );
    if (dto.lecturaId) {
      await this.exigirLecturaCoincide(dto.lecturaId, prov, {
        tipo: 'factura', letra: letraFactura, puntoVenta: normalizarPuntoVenta(dto.puntoVenta ?? c.puntoVenta ?? '0001'),
        numero: dto.numero ?? c.numero ?? null, total: pieReal.total,
      });
    }
    if (pieReal.total <= 0) {
      throw new BadRequestException(`El total de la factura da ${r2(pieReal.total)}: revisá los costos y la bonificación.`);
    }
    /* La marca del renglón se congeló al cargar el remito; acá solo cambian
     * los precios, así que la parte del café se recalcula sobre esa marca. */
    const delCafe = new Set(filasRemito.filter((f) => f.paraCafeteria).map((f) => f.id));
    const netoCafeteria = this.netoCafeteriaDe(pieReal.items, (it) => delCafe.has(it.itemId));

    const puntoVenta = normalizarPuntoVenta(dto.puntoVenta ?? c.puntoVenta ?? '0001');
    const numeroFactura = dto.numero ?? c.numero ?? null;
    if (!numeroFactura) {
      throw new BadRequestException('Poné el número de la factura (el del papel): sin número no se puede controlar que no esté cargada dos veces.');
    }
    this.exigirCostosDeLaFactura(filasRemito.map((f) => f.productoId), dto.actualizarCostos, dto.activarProveedor);
    // La factura resultante tampoco se puede duplicar contra las ya cargadas.
    if (numeroFactura) {
      const [ya] = await this.db.select({ id: comprobantes.id }).from(comprobantes).where(and(
        eq(comprobantes.proveedorId, prov.id),
        eq(comprobantes.tipo, 'factura'),
        eq(comprobantes.letra, letraFactura as any),
        eq(comprobantes.puntoVenta, puntoVenta),
        eq(comprobantes.numero, numeroFactura),
        ne(comprobantes.estado, 'anulado'),
        ne(comprobantes.id, id),
      )).limit(1);
      if (ya) {
        throw new BadRequestException(
          `${prov.nombre} ya tiene cargada la factura ${letraFactura} ${puntoVenta}-${numeroFactura} (comprobante #${ya.id}).`,
        );
      }
    }

    const compromisosNorm = this.normalizarCompromisos(dto, pieReal.total);

    // La etiqueta del remito, capturada ANTES de convertirlo: es el rastro.
    const etiquetaRemito = etiquetaDoc(c);
    const fechaRemito = c.fecha instanceof Date ? c.fecha.toISOString().slice(0, 10) : String(c.fecha).slice(0, 10);

    await this.db.transaction(async (tx) => {
      // etiquetaDoc ya dice "Remito A 0001-…": no se repite la palabra.
      const rastro = `Nace del ${etiquetaRemito} (${fechaRemito}): la mercadería ya había ingresado — el stock no se vuelve a mover.`;
      const [actualizado] = await tx.update(comprobantes).set({
        tipo: 'factura',
        letra: letraFactura as any,
        puntoVenta,
        numero: dto.numero ?? c.numero ?? null,
        // La fecha pasa a ser LA DEL PAPEL: es la que define el período fiscal.
        fecha: dto.fecha ? new Date(dto.fecha.length <= 10 ? `${dto.fecha}T00:00:00` : dto.fecha) : c.fecha,
        cuentaFecha: netoCafeteria > 0
          ? await fechaDeCuenta(tx, dto.fecha ? new Date(dto.fecha.length <= 10 ? `${dto.fecha}T00:00:00` : dto.fecha) : c.fecha)
          : null,
        fechaCarga: dto.fechaCarga
          ? new Date(dto.fechaCarga.length <= 10 ? `${dto.fechaCarga}T00:00:00` : dto.fechaCarga)
          : new Date(),
        vencimientoPago: dto.vencimientoPago
          ? new Date(dto.vencimientoPago.length <= 10 ? `${dto.vencimientoPago}T00:00:00` : dto.vencimientoPago)
          : null,
        condicionPago: 'cuenta_corriente',
        bonificacion: pieReal.bonifPct,
        bonificacionImporte: r2(pieReal.bonificacionImporte),
        subtotalNeto: pieReal.subtotalNeto,
        ivaTotal: pieReal.ivaTotal,
        percepcionesTotal: r2(pieReal.percepcionesTotal),
        total: pieReal.total,
        netoCafeteria,
        cae: String(dto.cae ?? '').slice(0, 32),
        observaciones: [String(dto.observaciones ?? '').trim(), String(c.observaciones ?? '').trim(), rastro]
          .filter(Boolean).join('\n'),
        // Quién facturó (puede no ser quien cargó el remito).
        ...(dto.usuarioId != null ? { usuarioId: dto.usuarioId } : {}),
        /*
         * SOLO SI SIGUE SIENDO UN REMITO (26/9/2026). El control de arriba lee
         * una foto: dos "Llegó la factura" a la vez lo pasaban los dos, y el
         * remito quedaba con las cuotas DOBLES ($110.868 de compromisos para
         * una factura de $55.434). El UPDATE toma la fila: el segundo espera,
         * la encuentra ya convertida, no toca nada y su transacción entera se
         * cae — cuotas incluidas.
         */
      }).where(and(eq(comprobantes.id, id), eq(comprobantes.tipo, 'remito'), eq(comprobantes.estado, 'confirmado'))).returning();
      if (!actualizado) {
        throw new BadRequestException(`${etiquetaRemito} ya se convirtió en factura (¿se apretó dos veces?). Actualizá la pantalla.`);
      }

      // Los renglones conservan producto y cantidad; cambian precio, desc. e IVA.
      for (const it of pieReal.items as any[]) {
        await tx.update(comprobanteItems).set({
          costoUnitario: Number(it.costoUnitario) || 0,
          descuento: Number(it.descuento) || 0,
          iva: it.iva,
          subtotal: it.subtotal,
        }).where(eq(comprobanteItems.id, it.itemId));
      }

      /* Un remito no debería tener percepciones, pero si alguna quedó, la
       * factura las reemplaza por las del papel — no se suman dos veces. */
      await tx.delete(comprobantePercepciones).where(eq(comprobantePercepciones.comprobanteId, id));
      if (pieReal.percepciones.length) {
        await tx.insert(comprobantePercepciones).values(
          pieReal.percepciones.map((p) => ({ comprobanteId: id, ...p })),
        );
      }

      /* El compromiso (0068) nace recién AHORA: el remito no generaba deuda,
       * así que no había nada que prometer hasta este momento. */
      if (compromisosNorm.length) {
        await this.crearCompromisosTx(tx, actualizado, prov, compromisosNorm, 'la factura');
      }

      /*
       * Los costos que el usuario aceptó actualizar, igual que en el alta: la
       * factura ES la lista de precios nueva del proveedor, y acá es donde por
       * fin llegan los precios reales (el remito entró con los de catálogo).
       */
      const pedidos = (dto.actualizarCostos ?? []).filter((x) => Number(x.costo) > 0);
      if (pedidos.length) {
        const entradas = await tx.select().from(productoProveedores)
          .where(and(
            eq(productoProveedores.proveedorId, prov.id),
            inArray(productoProveedores.productoId, pedidos.map((x) => x.productoId)),
          ));
        const porProducto = this.formatoPorProducto(entradas);
        const ivaDe = await this.ivaDeProductos(tx, pedidos.map((x) => x.productoId));
        await this.exigirSaltosConfirmados(tx, porProducto, pedidos, dto.confirmarSaltos, ivaDe);

        const cambios = pedidos
          .map((x) => {
            const e = porProducto.get(x.productoId);
            return e ? this.cambioDeCosto(e, x, ivaDe.get(x.productoId)) : null;
          })
          .filter(Boolean) as any[];

        if (cambios.length) {
          await this.precios.actualizarCostos({
            cambios,
            origen: 'recepcion',
            motivo: `factura ${puntoVenta}-${dto.numero ?? id} · ${prov.nombre} (del remito ${etiquetaRemito})`,
            usuarioId: dto.usuarioId,
            comprobanteId: id,
          } as any, tx);
        }
      }

      if (dto.activarProveedor?.length) {
        await this.precios.activarProveedor({
          productoIds: dto.activarProveedor,
          proveedorId: prov.id,
          origen: 'recepcion',
          motivo: `factura ${puntoVenta}-${dto.numero ?? id} · ${prov.nombre} (del remito ${etiquetaRemito})`,
          usuarioId: dto.usuarioId,
          comprobanteId: id,
        }, tx);
      }

      // Y el papel de la bandeja que esta factura cierra, si vino de ahí.
      if (dto.lecturaId) {
        const cerrada = await tx.update(facturaLecturas)
          .set({ estado: 'cargada', comprobanteId: id })
          .where(and(eq(facturaLecturas.id, dto.lecturaId), eq(facturaLecturas.estado, 'pendiente')))
          .returning({ id: facturaLecturas.id });
        if (cerrada.length) await tx.delete(facturaArchivos).where(eq(facturaArchivos.lecturaId, dto.lecturaId));
      }
    });

    // La evolución de precios, DESPUÉS del commit (igual que en el alta).
    const tocados = [
      ...(dto.actualizarCostos ?? []).map((x) => x.productoId),
      ...(dto.activarProveedor ?? []),
    ];
    if (tocados.length) {
      await this.precios.registrarEvolucion(tocados, 'costo', {
        detalle: 'Facturación de remito', usuarioId: dto.usuarioId ?? null,
      });
    }

    // Recién ahora existe deuda que pagar: el remito no debía nada.
    await this.saldarEnElActo(id, {
      proveedorId: prov.id,
      concepto: `factura ${letraFactura} ${puntoVenta}-${dto.numero ?? id}`.trim(),
      fecha: dto.fecha,
      sucursalId: c.sucursalId,
      usuarioId: dto.usuarioId,
      tomarPagos: dto.tomarPagos,
      pagoContado: dto.pagoContado,
    }, opciones);

    return this.get(id);
  }

  /**
   * Cuenta corriente del proveedor por MERCADERÍA: facturas + ND − NC, menos lo
   * que ya se le pagó contra esos comprobantes (`pagado`, que mantiene el
   * módulo de Pagos a proveedores).
   *
   * Ojo con el alcance: acá solo entran los comprobantes de compra. La cuenta
   * COMPLETA del proveedor —que además suma sus gastos y sus pagos a cuenta sin
   * aplicar— la arma `GET /pagos-proveedor/cuenta/:id`.
   */
  async cuenta(proveedorId: number) {
    const cs = await this.db.select().from(comprobantes)
      .where(and(eq(comprobantes.proveedorId, proveedorId), eq(comprobantes.estado, 'confirmado')))
      .orderBy(desc(comprobantes.id));
    let deuda = 0;
    let pagado = 0;
    for (const c of cs) {
      // Antes solo contaba la cta. cte.: una factura al contado sin pago
      // registrado desaparecía del saldo aunque no se hubiera pagado nunca.
      // Ahora la deuda la define el documento y la cancela el pago.
      // LISTA DE TIPOS · suman a la cuenta corriente. La liquidación también:
      // la plata que se le paga al proveedor es UNA, facturada o no.
      if (c.tipo === 'factura' || c.tipo === 'liquidacion' || c.tipo === 'nota_debito') {
        deuda += c.total; pagado += c.pagado;
      } else if (c.tipo === 'nota_credito') deuda -= c.total;
    }
    /*
     * El TOTAL del proveedor no cambia por atar las notas a su factura —una NC
     * resta de la deuda igual, referenciada o no—, así que este número siguió
     * estando bien todo este tiempo. Lo que cambia es la ATRIBUCIÓN: cada
     * comprobante viene con su ajuste y su saldo real, que es lo que estaba mal
     * cuando se pagaba factura por factura.
     */
    const ajustes = await this.ajustesDe(cs.map((c) => c.id));
    const etiquetas = new Map(cs.map((c) => [c.id, etiquetaDoc(c)]));
    const conAjuste = cs.map((c) => {
      const aj = ajustes.get(c.id);
      return {
        ...c,
        ajuste: aj?.ajuste ?? 0,
        notas: aj?.notas ?? [],
        refEtiqueta: c.refComprobanteId ? (etiquetas.get(c.refComprobanteId) ?? '') : '',
        saldo: this.saldoReal(c, aj?.ajuste ?? 0),
      };
    });
    return {
      proveedorId,
      saldo: r2(deuda - pagado),
      deuda: r2(deuda),
      pagado: r2(pagado),
      comprobantes: conAjuste,
    };
  }

  /**
   * EL SALDO DE TODOS LOS PROVEEDORES, EN UNA CONSULTA.
   * ==========================================================================
   * Existe para que la pantalla deje de calcularlo. `cuentaProveedor()` del
   * frontend sumaba sobre los comprobantes que tenía en memoria, y eso traía
   * dos problemas:
   *
   *   1. era la CUARTA copia de la fórmula de la deuda, y ya se había
   *      desalineado antes (le faltaba la liquidación, y filtraba por
   *      `condicionPago`, criterio que el backend abandonó);
   *   2. desde que el listado esconde las liquidaciones a quien no tiene el
   *      permiso, ese saldo salía **más bajo que la deuda real** para ese
   *      usuario, sin ningún aviso. Un saldo que depende de quién lo mira no es
   *      un saldo.
   *
   * Y es lo que permite ponerle límite al listado: mientras el saldo se
   * calculara con lo que había en memoria, acotar el listado lo habría dejado
   * mal en silencio.
   *
   * Va en UNA consulta agrupada, no una por proveedor: son cinco líneas de SQL
   * contra N viajes.
   */
  async saldos() {
    const filas = await this.db
      .select({
        proveedorId: comprobantes.proveedorId,
        // Mismo criterio que `cuenta()`: la deuda la define el DOCUMENTO y la
        // cancela el PAGO. La NC resta; la orden de compra y el remito no suman.
        deuda: sql<number>`coalesce(sum(case
          when ${comprobantes.tipo} in ('factura','liquidacion','nota_debito') then ${comprobantes.total}
          when ${comprobantes.tipo} = 'nota_credito' then -${comprobantes.total}
          else 0 end), 0)`,
        pagado: sql<number>`coalesce(sum(case
          when ${comprobantes.tipo} in ('factura','liquidacion','nota_debito') then ${comprobantes.pagado}
          else 0 end), 0)`,
      })
      .from(comprobantes)
      .where(eq(comprobantes.estado, 'confirmado'))
      .groupBy(comprobantes.proveedorId);

    const porProveedor: Record<number, number> = {};
    let total = 0;
    for (const f of filas) {
      const saldo = r2(Number(f.deuda) - Number(f.pagado));
      porProveedor[f.proveedorId] = saldo;
      total += saldo;
    }
    return { total: r2(total), porProveedor };
  }
}

/**
 * TODO EL CONTROLLER PIDE `compras.facturacion`, lecturas incluidas.
 *
 * Acá vive la deuda con los proveedores y lo que se les compró a cada precio:
 * no es un dato que necesite ninguna otra pantalla del sistema (el arranque del
 * inventario arma lo suyo directo de la base, no pasando por acá), así que
 * cerrarlo entero no le saca nada a nadie.
 */
@Controller('comprobantes')
@Permiso('compras.facturacion')
export class ComprobantesController {
  constructor(private readonly svc: ComprobantesService) {}

  /** La góndola que dejaría la factura, sin grabar nada (ver `proyectarPrecios`). */
  @Post('proyectar-precios')
  proyectar(@Body() dto: ProyeccionPreciosDto) {
    return this.svc.proyectarPrecios(dto);
  }

  @Get()
  list(
    @Auth() auth: Sesion,
    @Query('proveedorId') proveedorId?: string,
    @Query('tipo') tipo?: string,
    @Query('estado') estado?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.list({
      proveedorId: proveedorId ? Number(proveedorId) : undefined, tipo, estado,
      limit: limit ? Number(limit) : undefined,
      /*
       * LA MITAD NO FACTURADA es un permiso aparte (`liquidaciones`). El filtro
       * estaba SOLO en el navegador, así que `?tipo=liquidacion` la devolvía
       * igual a quien se le había negado: el que esconde el botón no puede ser
       * el mismo que decide si el dato viaja.
       */
      verLiquidaciones: tienePermiso(auth.permisos, ['liquidaciones']),
    });
  }

  /**
   * Ruta fija ANTES de `cuenta/:proveedorId` y de `:id`: Nest resuelve por orden
   * de declaración, así que si fuera después, `saldos` entraría como si fuera un
   * id y devolvería 400.
   */
  @Get('saldos')
  saldos() {
    return this.svc.saldos();
  }

  @Get('cuenta/:proveedorId')
  cuenta(@Param('proveedorId', ParseIntPipe) proveedorId: number) {
    return this.svc.cuenta(proveedorId);
  }

  /** Las facturas que una NC/ND de este proveedor puede ajustar, con su saldo. */
  @Get('referenciables/:proveedorId')
  referenciables(@Param('proveedorId', ParseIntPipe) proveedorId: number) {
    return this.svc.referenciables(proveedorId);
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.svc.get(id);
  }

  /**
   * LLEGÓ LA FACTURA DE UN REMITO: el remito `:id` pasa a ser la factura, sin
   * volver a mover stock. Mismos permisos que el alta — y el mismo corte de
   * `precios`, porque también puede actualizar costos por adentro.
   */
  /** Qué pasaría al anular: lo que frena y lo que se deshace (0106). */
  @Get(':id/anulacion')
  anulacion(@Param('id', ParseIntPipe) id: number) {
    return this.svc.previsualizarAnulacion(id);
  }

  @Post(':id/anular')
  anular(@Param('id', ParseIntPipe) id: number, @Body() dto: AnularComprobanteDto, @Auth() auth: Sesion) {
    return this.svc.anular(id, dto, {
      puedeTocarPrecios: tienePermiso(auth.permisos, ['precios']),
      puedeLiquidaciones: tienePermiso(auth.permisos, ['liquidaciones']),
    });
  }

  @Post(':id/facturar')
  facturar(@Param('id', ParseIntPipe) id: number, @Body() dto: FacturarRemitoDto, @Auth() auth: Sesion) {
    return this.svc.facturar(id, dto, {
      puedeTocarPrecios: tienePermiso(auth.permisos, ['precios']),
      sucursalSesion: auth.sucursalId,
      cruzaSucursales: esJefe(auth),
    });
  }

  @Post()
  create(@Body() dto: CreateComprobanteDto, @Auth() auth: Sesion) {
    /*
     * LA PUERTA DE ATRÁS DE PRECIOS.
     *
     * `create` llama por adentro a `precios.actualizarCostos` y
     * `precios.activarProveedor` con datos que vienen del body. El controller de
     * precios está cerrado con `@Permiso('precios')`… y esto lo saltea: un solo
     * POST reescribía el costo de catálogo y con él el precio de góndola.
     *
     * Es la regla de las dos puertas otra vez — cerrar el controller no alcanza
     * cuando otro módulo llama al servicio por adentro. Recibir mercadería
     * (`compras.facturacion`) y tocar precios son dos permisos distintos, así que
     * se piden los dos.
     */
    return this.svc.create(dto, {
      puedeTocarPrecios: tienePermiso(auth.permisos, ['precios']),
      // Para el pago contado: el turno de caja tiene que ser de esta sucursal.
      sucursalSesion: auth.sucursalId,
      // Y para tomar un pago que ya existía: solo el jefe cruza de sucursal.
      cruzaSucursales: esJefe(auth),
    });
  }
}

@Module({
  imports: [InventarioModule, PreciosModule, PagosModule],
  controllers: [ComprobantesController],
  providers: [ComprobantesService],
})
export class ComprobantesModule {}
