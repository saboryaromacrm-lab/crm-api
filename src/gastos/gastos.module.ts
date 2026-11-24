/**
 * GASTOS — lo que la empresa paga y no es mercadería
 * ============================================================================
 * Circuito completo y chico: se carga el comprobante que llegó, se imputa a una
 * categoría del plan de gastos, y se paga (de una o en partes). De ahí salen
 * las dos preguntas que el negocio hace todos los días: **qué tengo que pagar**
 * (bandeja de vencimientos) y **en qué se me va la plata** (resumen por rubro).
 *
 * Tres decisiones que valen la pena explicar:
 *
 *  1. El proveedor es el MISMO de compras. Un CUIT, una entidad. Lo que separa
 *     los dos mundos es el documento, no la persona (ver `schema.ts`).
 *  2. Pagar en efectivo desde un turno de caja abierto genera el EGRESO en esa
 *     caja, en la misma transacción. Sin eso, el dinero sale del cajón y el
 *     arqueo de la noche no cierra por un motivo que ya nadie recuerda.
 *  3. Un gasto con pagos no se anula ni se le cambian los importes: primero se
 *     revierte el pago. La plata que salió tiene que poder rastrearse siempre.
 */
import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Inject, Injectable,
  Module, NotFoundException, Param, ParseIntPipe, Patch, Post, Put, Query, Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min,
  ValidateNested,
} from 'class-validator';
import { and, asc, desc, eq, gte, inArray, lte, ne, or, sql } from 'drizzle-orm';
import { mimeReal, nombreSeguro } from '../common/archivos';
import { fechaLocal } from '../common/documentos';
import { exigirFueraDeConciliado } from '../common/conciliacion';
import { ajustePorAnulacion, fechaDeCuenta, importeEnCuenta } from '../cafeteria/cuenta';
import { DRIZZLE, Database } from '../db/drizzle';
import {
  auditoria, comprobantes, gastoAdjuntos, gastoCategorias, gastos, gastoItems, gastosRecurrentes, proveedores, sucursales, usuarios,
} from '../db/schema';
import {
  NETO_DE_LA_ENTREGA, NETO_DEL_RENGLON, ORIGENES_FLETE, PAPELES_DE_LA_ENTREGA, TIPOS_CON_FLETE, coincideNumero, papelMasCercano,
  sugerirProveedor, type FleteOrigen,
} from './fletes';

/**
 * LO QUE UN GASTO DE COFFIT LE SUMA A SU CUENTA: su TOTAL, con IVA y
 * percepciones (0176: Coffit paga precio final). Con signo: la NC resta.
 */
const paraCuentaCoffit = (g: { total: number }) => Math.round(Number(g.total) * 100) / 100;
/** Lo que se le sumaba antes del cambio (0120): sin lo que recupera la empresa. Es lo que contaron los meses cerrados. */
const paraCuentaSinIva = (g: { total: number; iva: number; percDgi: number; percDgr: number }) =>
  Math.round((Number(g.total) - Number(g.iva) - Number(g.percDgi) - Number(g.percDgr)) * 100) / 100;
import { Auth, Permiso, type Sesion } from '../auth/auth.decoradores';
import { esJefe, tienePermiso } from '../auth/auth.guard';
import { PagosModule, PagosProveedorService, esAdminPagos, exigirFechaPago } from '../pagos/pagos.module';
import { exigirFueraDeCashflow, type OpcionesCashflow } from '../cashflow/vinculo';
import { PERMISO_RESULTADOS } from '../resultados/permiso';
import { MESES_FRECUENCIA, sumarMeses } from '../resultados/reglas';
import { RepartoDto, exigirReparto } from '../resultados/reparto';
import { hoyAr } from '../cafeteria/cuenta';

/**
 * LAS FECHAS DEL GASTO (27/9/2026). Se aceptaba un gasto fechado en 2035 y un
 * vencimiento ocho meses ANTES de la factura. Ahora: la fecha no es futura ni
 * de más de un año atrás, y el vencimiento no es anterior a la fecha.
 */
const DIAS_ATRAS_GASTO = 365;
function exigirFechasGasto(fecha?: Date | null, vencimiento?: Date | null) {
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const manana = new Date(hoy); manana.setDate(manana.getDate() + 1);
  const tope = new Date(hoy); tope.setDate(tope.getDate() - DIAS_ATRAS_GASTO);
  const fmt = (d: Date) => d.toLocaleDateString('es-AR');
  if (fecha) {
    if (fecha.getTime() >= manana.getTime()) throw new BadRequestException(`El gasto no puede tener fecha futura (${fmt(fecha)}).`);
    if (fecha.getTime() < tope.getTime()) {
      throw new BadRequestException(`La fecha ${fmt(fecha)} tiene más de un año: revisala.`);
    }
  }
  const base = fecha ?? hoy;
  if (vencimiento && vencimiento.getTime() < new Date(base).setHours(0, 0, 0, 0)) {
    throw new BadRequestException(`El vencimiento (${fmt(vencimiento)}) no puede ser anterior a la fecha del gasto (${fmt(base)}).`);
  }
}

/**
 * Redondeo a dos decimales, y última red contra los números que no son números.
 *
 * `Number.isFinite` no está de adorno: `1e308` es un `number` finito que pasa
 * cualquier `@IsNumber()`, pero multiplicado por 100 desborda a `Infinity`, que
 * es truthy, sobrevive a `|| 0` y **Postgres lo acepta** en una columna
 * `double precision`. Un solo gasto así dejaba el resumen del mes y el badge
 * del sidebar en blanco. El tope de verdad lo pone `@Max(TOPE_IMPORTE)` en los
 * DTOs —ahí el que carga recibe un mensaje—; esto es el piso de abajo.
 */
const money = (n: number) => {
  const v = Number(n) * 100;
  return Number.isFinite(v) ? Math.round(v) / 100 : 0;
};

/** Mil millones de pesos en un solo renglón de gasto: no existe, y corta el desborde. */
const TOPE_IMPORTE = 1_000_000_000;

/** Igual que la bandeja de facturas: una foto de comprobante no pesa más. */
const MAX_BYTES_ADJUNTO = Math.floor(2.5 * 1024 * 1024);

/** 'AAAA-MM-DD', lo único que manda un `<input type="date">`. */
const SOLO_FECHA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * QUIÉN ENTRA A GASTOS — las claves que el catálogo declaraba y nadie exigía.
 * ============================================================================
 * Este controller no tenía NINGÚN permiso. Las siete secciones y las cuatro
 * acciones existían desde el primer día en `usuarios.module.ts`, se podían
 * tildar en la pantalla de roles… y no las leía nadie: el único filtro era el
 * sub-sidebar del dashboard, que decide qué panel dibuja. Con eso, cualquier
 * sesión —el rol Cafetería, que ve una sola pantalla— pedía `/gastos/resumen` y
 * se llevaba la estructura de costos entera de la empresa.
 *
 * `PISO` es el permiso de LECTURA del módulo: tener alguna de sus secciones.
 * Va a nivel de clase y alcanza para los catálogos que todas las pantallas
 * necesitan. Cada escritura vuelve a pedir lo suyo — y ojo con la semántica:
 * un `@Permiso` de método REEMPLAZA al de la clase, no se suman, así que cada
 * uno tiene que listar todo lo que acepta.
 *
 * `PERMISOS_PAGO` es el caso serio: los tres endpoints que terminan llamando a
 * `PagosProveedorService.crear()` generan un EGRESO DE EFECTIVO en un turno de
 * caja. Ese servicio ya estaba cerrado del lado de `PagosProveedorController`;
 * Gastos lo volvía a abrir por el costado. Las claves son las mismas de allá
 * (misma plata, mismos caminos legítimos) más la acción propia de gastos.
 */
const PISO_GASTOS = [
  'gastos.gastos', 'gastos.pagos', 'gastos.pagos_proveedor',
  'gastos.categorias', 'gastos.proveedores', 'gastos.resumen',
];
/** Ver un gasto: las tres secciones que lo muestran en pantalla. */
const PERMISOS_VER = ['gastos.gastos', 'gastos.pagos', 'gastos.resumen'];
/** Mover plata: crea el egreso del cajón. Espejo de `PagosProveedorController`. */
const PERMISOS_PAGO = ['gastos_pagar', 'gastos_pagar_proveedor', 'ventas.caja'];
/** Imputar: decidir contra qué documento se descuenta un pago que ya existe. */
const PERMISOS_IMPUTAR = ['gastos_imputar', 'gastos.pagos_proveedor', 'compras.pagos'];

/*
 * `fechaLocal` vive en `common/documentos`. Está compartida con Cafetería —eran
 * dos copias idénticas— porque es la trampa del `<input type="date">`: manda
 * 'AAAA-MM-DD' pelado, `new Date('2026-08-05')` lo lee como MEDIANOCHE UTC, y en
 * UTC−3 eso es el 4 a las 21:00, así que el gasto fechado el 5 se listaba el 4.
 * En dos copias, arreglar una no arreglaba la otra.
 */

/** "0001-00000123" → "1-123"; lo demás, sin espacios ni signos y en minúsculas. */
function normalizarNumero(n?: string | null) {
  const t = String(n ?? '').trim();
  const m = /^0*(\d+)\s*-\s*0*(\d+)$/.exec(t);
  if (m) return `${Number(m[1])}-${Number(m[2])}`;
  return t.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^0+(?=\d)/, '');
}
function normalizarTexto(t?: string | null) {
  return String(t ?? '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

const TIPOS_DOC = ['factura', 'ticket', 'recibo', 'nota_credito', 'otro'] as const;

/**
 * LA NOTA DE CRÉDITO DE UN GASTO VA EN NEGATIVO (27/9/2026). Se guardaba con
 * importe positivo y todo la leía como gasto: el resumen del mes SUBÍA $500 y
 * aparecía en Cuentas a pagar como deuda. En negativo resta sola en todas las
 * sumas que ya existen (resumen, saldo del proveedor, estado de cuenta,
 * Gerencia, Coffit) y no se ofrece para pagar. Nace "pagada": no hay nada que
 * pagarle. La cargan en positivo, como dice el papel; el signo lo pone acá.
 */
const esNotaCredito = (tipo?: string | null) => tipo === 'nota_credito';

/**
 * EL MES AL QUE CORRESPONDE (0152, devengado: el alquiler de octubre va en
 * octubre aunque la factura sea de noviembre). 'AAAA-MM' → su día 1; vacío o
 * el mismo mes de la fecha → null (vale el de la fecha, como siempre). Hasta
 * un año para cada lado: más lejos es un error de tipeo.
 */
function periodoDe(periodo: string | null | undefined, fecha: Date): string | null {
  if (!periodo) return null;
  const [y, m] = periodo.split('-').map(Number);
  const dif = (y - fecha.getFullYear()) * 12 + (m - (fecha.getMonth() + 1));
  if (dif === 0) return null;
  if (Math.abs(dif) > 12) {
    throw new BadRequestException('El mes al que corresponde puede ser hasta un año antes o después de la fecha del gasto.');
  }
  return `${periodo}-01`;
}
const CAMPOS_IMPORTE = ['neto', 'iva', 'otros', 'impInternos', 'percDgi', 'percDgr', 'total'] as const;
function conSigno<T extends Record<string, any>>(x: T, signo: 1 | -1): T {
  const out: any = { ...x };
  for (const k of CAMPOS_IMPORTE) if (typeof out[k] === 'number') out[k] = money(out[k] * signo);
  return out;
}
const MEDIOS = ['efectivo', 'transferencia', 'tarjeta_debito', 'tarjeta_credito', 'cheque', 'qr', 'otro'] as const;

/* ------------------------------- DTOs ------------------------------- */

/*
 * LAS FECHAS SE VALIDAN, no se confían. `new Date('lunes')` no explota: devuelve
 * `Invalid Date`, que viaja calladito hasta que Drizzle le pide un ISO y ahí sí
 * revienta con un 500 y el stack en el log. Pagos ya lo había resuelto así; acá
 * faltaba. Lo mismo con los importes y su `@Max`: ver el comentario de `money`.
 */
/*
 * `PagoDto` va ANTES de `GastoDto` porque este lo referencia como tipo anidado:
 * `emitDecoratorMetadata` escribe el `design:type` en el momento en que la clase
 * se define, así que declararlo después explota con "Cannot access before
 * initialization" al arrancar. No es orden estético.
 */
class PagoDto {
  @IsNumber() @Min(0.01) @Max(TOPE_IMPORTE) importe!: number;
  @IsOptional() @IsIn(MEDIOS as unknown as string[]) medio?: string;
  @IsOptional() @Matches(SOLO_FECHA, { message: 'La fecha va como AAAA-MM-DD.' }) fecha?: string;
  @IsOptional() @IsString() referencia?: string;
  /** Efectivo por transferencia (0175): quién transfirió a cambio de nuestro efectivo; va con medio transferencia. */
  @IsOptional() @IsString() @MaxLength(80) cambioPor?: string;
  /** De qué cuenta propia salió la transferencia (0207). */
  @IsOptional() @IsInt() cuentaPropiaId?: number;
  /** O de otra cuenta, escrita a mano (0215). */
  @IsOptional() @IsString() @MaxLength(80) cuentaAMano?: string;
  /** Turno de caja del que sale el efectivo (genera el egreso). */
  @IsOptional() @IsInt() cajaSesionId?: number;
  @IsOptional() @IsInt() usuarioId?: number;
  /** "Sí, es otro pago": la segunda confirmación ante un pago gemelo del día (409). */
  @IsOptional() @IsBoolean() confirmarDuplicado?: boolean;
}

/** De dónde vino un renglón de flete (0244): ver `fletes.ts`. */
class FleteDeRenglonDto {
  @IsOptional() @IsIn(ORIGENES_FLETE) fleteOrigen?: FleteOrigen | null;
  @IsOptional() @IsInt() fleteProveedorId?: number | null;
  @IsOptional() @IsInt() fleteComprobanteId?: number | null;
  /** El número de la factura o el remito del proveedor, si todavía no está cargado. */
  @IsOptional() @IsString() @MaxLength(40) fleteReferencia?: string;
}

/** Un renglón del gasto: concepto + importe del renglón, como se lee del papel; la cantidad, si va por unidad (0196). */
class GastoItemDto extends FleteDeRenglonDto {
  @IsString() @MaxLength(200) concepto!: string;
  @IsNumber() @Min(0.01) @Max(TOPE_IMPORTE) monto!: number;
  @IsOptional() @IsNumber() @Min(0.001) @Max(1_000_000) cantidad?: number | null;
}

/** Corregir de dónde vino un renglón ya cargado (0244): no toca importes, así que vale con pagos. */
class AsignarFleteDto extends FleteDeRenglonDto {
  @IsInt() itemId!: number;
}
class AsignarFletesDto {
  @IsArray() @ArrayMaxSize(300) @ValidateNested({ each: true }) @Type(() => AsignarFleteDto) renglones!: AsignarFleteDto[];
}

class GastoDto {
  @IsOptional() @Matches(SOLO_FECHA, { message: 'La fecha va como AAAA-MM-DD.' }) fecha?: string;
  @IsOptional() @IsIn(TIPOS_DOC as unknown as string[]) tipoDoc?: string;
  @IsOptional() @IsIn(['A', 'B', 'C', 'X']) letra?: string;
  @IsOptional() @IsString() numero?: string;
  @IsOptional() @IsInt() proveedorId?: number;
  @IsOptional() @IsString() proveedorTexto?: string;
  @IsInt() categoriaId!: number;
  /** Dejar este rubro fijado en el proveedor (0240): la próxima vez se elige solo. Solo en el alta. */
  @IsOptional() @IsBoolean() rubroDelProveedor?: boolean;
  @IsOptional() @IsInt() sucursalId?: number;
  @IsOptional() @IsString() descripcion?: string;
  @IsOptional() @IsIn(['contado', 'cuenta_corriente']) condicionPago?: string;
  /** A qué negocio se imputa: la distribuidora (defecto) o la cafetería. */
  @IsOptional() @IsIn(['distribuidora', 'cafeteria']) negocio?: string;
  @IsOptional() @Matches(SOLO_FECHA, { message: 'El vencimiento va como AAAA-MM-DD.' }) vencimiento?: string;
  /** El mes al que corresponde (0152, devengado). Vacío = el de la fecha. Es imputación: se corrige aunque haya pagos. */
  @IsOptional() @Matches(/^(\d{4}-(0[1-9]|1[0-2]))?$/, { message: 'El mes al que corresponde va como AAAA-MM.' }) periodo?: string | null;
  /* Sin negativos (27/9/2026): se cargaba neto −$500 con IVA $600. La nota de
   * crédito va por su tipo, no con importes negativos. */
  @IsOptional() @IsNumber() @Min(0, { message: 'El neto no puede ser negativo (la nota de crédito va con su tipo).' }) @Max(TOPE_IMPORTE) neto?: number;
  @IsOptional() @IsNumber() @Min(0, { message: 'El IVA no puede ser negativo.' }) @Max(TOPE_IMPORTE) iva?: number;
  /**
   * Lo que suma abajo del IVA y NO se detalló en los tres de abajo. Sin
   * detalle, `otros` es todo (es como venía antes de 0071 y como lo mandan los
   * gastos fijos); con detalle, la columna `gastos.otros` guarda la SUMA de
   * los cuatro y estos tres guardan de qué está hecha.
   */
  @IsOptional() @IsNumber() @Min(-TOPE_IMPORTE) @Max(TOPE_IMPORTE) otros?: number;
  /* El pie abierto (0071): cada uno se computa después contra otro impuesto. */
  @IsOptional() @IsNumber() @Min(0) @Max(TOPE_IMPORTE) impInternos?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(TOPE_IMPORTE) percDgi?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(TOPE_IMPORTE) percDgr?: number;
  /**
   * LOS RENGLONES (0067). Si vienen, mandan: el total es su suma, `iva` pasa a
   * ser el "IVA incluido" informativo de la factura A (neto = total − iva) y
   * la descripción se arma sola con los conceptos. Sin renglones vale el
   * camino de siempre (gastos viejos, fijos generados, API externa).
   */
  @IsOptional() @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true })
  @Type(() => GastoItemDto) items?: GastoItemDto[];
  /**
   * Cómo vienen los montos de los renglones. `false` (defecto): finales, con
   * el IVA adentro. `true`: la factura A — los renglones son NETOS tal como
   * los lista el papel, y el IVA se copia del pie y SE SUMA al total. Sin
   * renglones el flag no significa nada y se ignora.
   */
  @IsOptional() @IsBoolean() ivaAparte?: boolean;
  /** La NC (0115): el gasto del que descuenta. `null` al editar = que no descuente de ninguno. */
  @IsOptional() @IsInt() refGastoId?: number | null;
  @IsOptional() @IsString() observaciones?: string;
  @IsOptional() @IsInt() usuarioId?: number;
  /**
   * Pago en el mismo acto del alta (el caso más común: se paga y se carga).
   * Si viene, se registra como primer pago del gasto — y por eso el alta exige
   * también el permiso de pagar (ver `PERMISOS_PAGO`).
   */
  @IsOptional() @ValidateNested() @Type(() => PagoDto) pagoInmediato?: PagoDto;
}

/**
 * ¿Este patch toca PLATA? Lo usan los dos lados de la edición: reconstruir el
 * pie, y el candado del gasto ya pagado. Está acá y no repetido en cada `if`
 * porque los campos del pie crecieron (0071) y la lista olvidada del candado
 * sería un total editable con pagos atrás — la puerta de atrás clásica.
 */
function tocaImportes(dto: GastoDto) {
  return dto.neto != null || dto.iva != null || dto.otros != null
    || dto.impInternos != null || dto.percDgi != null || dto.percDgr != null;
}

class AplicarPagoDto {
  @IsInt() pagoId!: number;
  @IsNumber() @Min(0.01) @Max(TOPE_IMPORTE) importe!: number;
  @IsOptional() @IsInt() usuarioId?: number;
}

/* El motivo es obligatorio (27/9/2026), igual que al anular un pago. */
class AnularGastoDto {
  @IsString({ message: 'Escribí por qué se anula el gasto.' })
  @Matches(/\S/, { message: 'Escribí por qué se anula el gasto.' })
  motivo!: string; // el largo se recorta al guardar: sin motivo, un solo mensaje claro
}

class GenerarPeriodoDto {
  @Matches(/^\d{4}-\d{2}$/, { message: 'El período va como AAAA-MM (por ejemplo 2026-08).' }) periodo!: string;
  @IsOptional() @IsInt() usuarioId?: number;
  @IsOptional() @IsInt({ each: true }) ids?: number[];
}

class AdjuntoDto {
  @IsOptional() @IsString() nombre?: string;
  @IsString() data!: string;
}

/**
 * Los filtros que aceptan las TRES lecturas (listado, cuentas a pagar y
 * resumen). Uno solo y compartido: con `@Query() q: any` el `whitelist` global
 * no filtraba nada, así que cualquier cosa entraba al armado de condiciones.
 * Cada endpoint usa el subconjunto que le sirve e ignora el resto.
 */
class ConsultaGastosDto {
  @IsOptional() @Matches(SOLO_FECHA, { message: 'La fecha "desde" va como AAAA-MM-DD.' }) desde?: string;
  @IsOptional() @Matches(SOLO_FECHA, { message: 'La fecha "hasta" va como AAAA-MM-DD.' }) hasta?: string;
  @IsOptional() @Type(() => Number) @IsInt() categoriaId?: number;
  @IsOptional() @Type(() => Number) @IsInt() proveedorId?: number;
  @IsOptional() @Type(() => Number) @IsInt() sucursalId?: number;
  @IsOptional() @IsIn(['pendiente', 'pagado', 'anulado']) estado?: string;
  @IsOptional() @IsIn(['distribuidora', 'cafeteria']) negocio?: string;
  @IsOptional() @IsString() q?: string;
  @IsOptional() @Type(() => Number) @IsInt() limit?: number;
}

class CategoriaDto {
  @IsOptional() @IsString() nombre?: string;
  @IsOptional() @IsIn(['fijo', 'variable']) tipo?: string;
  @IsOptional() @IsString() descripcion?: string;
  @IsOptional() activa?: boolean;
  @IsOptional() @IsInt() orden?: number;
}

class RecurrenteDto {
  @IsOptional() @IsString() nombre?: string;
  @IsOptional() @IsInt() categoriaId?: number;
  @IsOptional() @IsInt() proveedorId?: number;
  @IsOptional() @IsInt() sucursalId?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(TOPE_IMPORTE) importeEstimado?: number;
  @IsOptional() @IsIn(['mensual', 'bimestral', 'trimestral', 'semestral', 'anual']) frecuencia?: string;
  @IsOptional() @IsInt() @Min(1) @Max(31) diaVencimiento?: number;
  @IsOptional() activo?: boolean;
  @IsOptional() @IsString() observaciones?: string;
  /** 0216: desde qué mes corre ('AAAA-MM'). */
  @IsOptional() @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: '«Desde» va como AAAA-MM.' }) desde?: string;
  /** 0216: repartido entre locales por %; vacío = sin reparto (manda el local). */
  @IsOptional() @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => RepartoDto) reparto?: RepartoDto[] | null;
}

/** El mes actual, día 1 ('AAAA-MM-01'). */
const mesActual = () => `${hoyAr().slice(0, 7)}-01`;
/** 'AAAA-MM-01' corrido `n` meses. */
const correrMes = (dia: string, n: number) => `${sumarMeses(dia.slice(0, 7), n)}-01`;
/**
 * DAR DE BAJA UN GASTO FIJO (0216): deja de contar desde el mes en que se da de
 * baja, así que su último mes es el anterior (o el anterior a `desde`, si
 * todavía no había empezado: «nunca corrió»).
 */
const hastaAlDarDeBaja = (desde: string) => {
  const anterior = correrMes(mesActual(), -1);
  const antesDeEmpezar = correrMes(desde, -1);
  return anterior > antesDeEmpezar ? anterior : antesDeEmpezar;
};

/* ------------------------------- Servicio ------------------------------- */

@Injectable()
export class GastosService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    /** Los pagos NO son de Gastos: son del proveedor. Acá solo se consultan. */
    private readonly pagos: PagosProveedorService,
  ) {}

  /* ---------------- Catálogos ---------------- */

  /**
   * Todo lo chico que el módulo necesita para operar, en una sola llamada:
   * plan de gastos, proveedores (con su clasificación), sucursales, usuarios y
   * las plantillas de gastos fijos.
   *
   * PROVEEDORES, SUCURSALES Y USUARIOS van proyectados y no con `select()`
   * pelado: esto lo pide todo el que abre el módulo, y un `SELECT *` arrastra
   * cualquier columna que se agregue mañana. Rubros y plantillas sí van
   * enteros, que es lo que las dos pantallas que los administran necesitan.
   *
   * Del padrón viajan SOLO el nombre y las dos banderas, que es lo que usan los
   * selectores. La ficha completa —CUIT, condición de IVA, contacto— la pide la
   * pantalla de Proveedores por su cuenta, así queda detrás de
   * `gastos.proveedores` en vez de bajar con el arranque del módulo.
   *
   * Los gastos fijos solo viajan si el rol tiene su sección: el mismo criterio
   * que el sub-sidebar, pero del lado que manda.
   */
  async bootstrap(sesion: Sesion) {
    const verFijos = tienePermiso(sesion.permisos, [PERMISO_RESULTADOS]);
    const [categorias, provs, sucs, users, recurrentes] = await Promise.all([
      this.db.select().from(gastoCategorias).orderBy(asc(gastoCategorias.orden), asc(gastoCategorias.nombre)),
      this.db.select({
        id: proveedores.id, nombre: proveedores.nombre,
        // Las dos banderas separan, en el selector, quién factura gastos de
        // quién vende mercadería. Ver el comentario de arriba sobre el resto.
        proveeMercaderia: proveedores.proveeMercaderia, proveeGastos: proveedores.proveeGastos,
        // La letra que factura (0067): el formulario de gasto la precarga al
        // elegir el proveedor. Sin ella en ESTE select el modal no la ve —
        // el selector se alimenta del bootstrap, no del padrón completo.
        letraGasto: proveedores.letraGasto,
        // El rubro que factura (0240): el formulario lo elige solo al elegir el proveedor.
        rubroGastoId: proveedores.rubroGastoId,
        // Es un transporte (0244): sus renglones dicen de qué proveedor trajo.
        traeMercaderia: proveedores.traeMercaderia,
      }).from(proveedores).orderBy(asc(proveedores.nombre)),
      this.db.select({ id: sucursales.id, nombre: sucursales.nombre, activa: sucursales.activa })
        .from(sucursales).orderBy(asc(sucursales.id)),
      this.db.select({ id: usuarios.id, nombre: usuarios.nombre, activo: usuarios.activo }).from(usuarios),
      verFijos
        ? this.db.select().from(gastosRecurrentes).orderBy(asc(gastosRecurrentes.nombre))
        : Promise.resolve([]),
    ]);
    /* Activas para elegir; las desactivadas (0143) solo por el nombre en el historial. */
    return {
      categorias, proveedores: provs,
      sucursales: sucs.filter((x) => x.activa).map(({ id, nombre }) => ({ id, nombre })),
      sucursalesInactivas: sucs.filter((x) => !x.activa).map(({ id, nombre }) => ({ id, nombre })),
      usuarios: users, recurrentes,
    };
  }

  listCategorias() {
    return this.db.select().from(gastoCategorias)
      .orderBy(asc(gastoCategorias.orden), asc(gastoCategorias.nombre));
  }

  /**
   * LOS CONCEPTOS YA USADOS (22/10/2026, pedido del dueño: «que me guarde los
   * ítems así no los escribo cada vez que compro»). No hay lista aparte que
   * mantener: sale de los renglones de los gastos cargados (sin los anulados),
   * uno por concepto sin importar mayúsculas ni espacios, escrito como se lo
   * escribió más veces. Primero los de ESE proveedor, después los más usados.
   *
   * Con la cantidad (0196) va también la ÚLTIMA compra por unidad de cada
   * concepto: cuánto salió la unidad, cuándo, y si ese renglón era sin IVA
   * (factura A: neto guardado = suma de los renglones, con IVA). Así al
   * volver a comprar se compara con lo mismo.
   */
  async conceptosUsados(proveedorId: number | null) {
    const r = await this.db.execute(sql`
      WITH por_unidad AS (
        SELECT DISTINCT ON (lower(trim(i.concepto))) lower(trim(i.concepto)) AS clave,
               i.monto / i.cantidad AS unitario, g.fecha,
               (g.iva > 0 AND abs(g.neto - sum(i.monto) OVER (PARTITION BY g.id)) < 0.01) AS sin_iva
          FROM gasto_items i JOIN gastos g ON g.id = i.gasto_id
         WHERE g.estado <> 'anulado' AND i.cantidad > 0
         ORDER BY lower(trim(i.concepto)), g.fecha DESC, i.id DESC),
      escrito AS (
        SELECT lower(trim(i.concepto)) AS clave, trim(i.concepto) AS texto, count(*) AS veces,
               count(*) FILTER (WHERE g.proveedor_id = ${proveedorId}) AS del_proveedor, max(g.fecha) AS ultima
          FROM gasto_items i JOIN gastos g ON g.id = i.gasto_id
         WHERE g.estado <> 'anulado' AND trim(i.concepto) <> ''
         GROUP BY 1, 2)
      SELECT (array_agg(e.texto ORDER BY e.veces DESC, e.ultima DESC))[1] AS concepto,
             max(u.unitario) AS unitario, to_json(max(u.fecha)) #>> '{}' AS fecha, bool_or(u.sin_iva) AS sin_iva
        FROM escrito e LEFT JOIN por_unidad u ON u.clave = e.clave
       GROUP BY e.clave
       ORDER BY sum(e.del_proveedor) DESC, sum(e.veces) DESC, max(e.ultima) DESC
       LIMIT 500`);
    return ((r as any).rows ?? r).map((x: any) => ({
      concepto: String(x.concepto),
      ultimaPorUnidad: x.unitario == null ? null
        : { unitario: money(Number(x.unitario)), fecha: x.fecha, sinIva: Boolean(x.sin_iva) },
    }));
  }

  async crearCategoria(dto: CategoriaDto) {
    const nombre = (dto.nombre ?? '').trim();
    if (!nombre) throw new BadRequestException('Poné el nombre del rubro.');
    const [ya] = await this.db.select().from(gastoCategorias).where(eq(gastoCategorias.nombre, nombre)).limit(1);
    if (ya) throw new BadRequestException(`Ya existe un rubro llamado "${nombre}".`);
    const [c] = await this.db.insert(gastoCategorias).values({
      nombre,
      tipo: (dto.tipo ?? 'variable') as any,
      descripcion: (dto.descripcion ?? '').trim(),
      activa: dto.activa !== false,
      orden: Number(dto.orden) || 500,
    }).returning();
    return c;
  }

  async editarCategoria(id: number, dto: CategoriaDto) {
    const [c] = await this.db.select().from(gastoCategorias).where(eq(gastoCategorias.id, id)).limit(1);
    if (!c) throw new NotFoundException('Rubro inexistente.');
    const patch: any = {};
    if (dto.nombre != null) {
      const n = String(dto.nombre).trim();
      if (!n) throw new BadRequestException('El nombre no puede quedar vacío.');
      const [otro] = await this.db.select().from(gastoCategorias)
        .where(and(eq(gastoCategorias.nombre, n), ne(gastoCategorias.id, id))).limit(1);
      if (otro) throw new BadRequestException(`Ya existe un rubro llamado "${n}".`);
      patch.nombre = n;
    }
    if (dto.tipo != null) patch.tipo = dto.tipo;
    if (dto.descripcion != null) patch.descripcion = String(dto.descripcion).trim();
    if (dto.activa != null) patch.activa = !!dto.activa;
    if (dto.orden != null) patch.orden = Number(dto.orden) || 0;
    if (Object.keys(patch).length) await this.db.update(gastoCategorias).set(patch).where(eq(gastoCategorias.id, id));
    return { ok: true };
  }

  /**
   * El rubro con gastos imputados no se borra: se DA DE BAJA. Borrarlo dejaría
   * gastos históricos apuntando al vacío y el resumen del año pasado sin
   * explicación. La baja lo saca de los selectores y nada más.
   */
  async borrarCategoria(id: number) {
    const [c] = await this.db.select().from(gastoCategorias).where(eq(gastoCategorias.id, id)).limit(1);
    if (!c) throw new NotFoundException('Rubro inexistente.');
    const [uso] = await this.db.select({ n: sql<number>`count(*)::int` }).from(gastos).where(eq(gastos.categoriaId, id));
    const [usoFijo] = await this.db.select({ n: sql<number>`count(*)::int` }).from(gastosRecurrentes)
      .where(eq(gastosRecurrentes.categoriaId, id));
    if (Number(uso?.n) > 0 || Number(usoFijo?.n) > 0) {
      throw new BadRequestException(
        `"${c.nombre}" tiene ${Number(uso?.n) || 0} gasto(s) imputados: no se borra, se da de baja para que deje de aparecer.`,
      );
    }
    await this.db.delete(gastoCategorias).where(eq(gastoCategorias.id, id));
    return { ok: true };
  }

  /* ---------------- Gastos: lectura ---------------- */

  private condiciones(q: any) {
    const conds: any[] = [];
    if (q.desde) conds.push(gte(gastos.fecha, fechaLocal(q.desde)!));
    if (q.hasta) conds.push(lte(gastos.fecha, new Date(`${String(q.hasta).slice(0, 10)}T23:59:59.999`)));
    if (q.categoriaId) conds.push(eq(gastos.categoriaId, Number(q.categoriaId)));
    if (q.proveedorId) conds.push(eq(gastos.proveedorId, Number(q.proveedorId)));
    if (q.sucursalId) conds.push(eq(gastos.sucursalId, Number(q.sucursalId)));
    if (q.estado) conds.push(eq(gastos.estado, q.estado));
    if (q.negocio) conds.push(eq(gastos.negocio, q.negocio));
    if (q.q) {
      const like = `%${String(q.q).trim()}%`;
      conds.push(or(
        sql`${gastos.descripcion} ilike ${like}`,
        sql`${gastos.numero} ilike ${like}`,
        sql`${gastos.proveedorTexto} ilike ${like}`,
        sql`${gastos.observaciones} ilike ${like}`,
      ));
    }
    return conds.length ? and(...conds) : undefined;
  }

  async list(q: any) {
    const limit = Math.min(Math.max(Number(q.limit) || 300, 1), 1000);
    return this.db.select().from(gastos)
      .where(this.condiciones(q))
      .orderBy(desc(gastos.fecha), desc(gastos.id))
      .limit(limit);
  }

  async get(id: number) {
    const [g] = await this.db.select().from(gastos).where(eq(gastos.id, id)).limit(1);
    if (!g) throw new NotFoundException('Gasto inexistente.');
    const [pagos, adjuntos, items] = await Promise.all([
      this.pagos.pagosDe({ gastoId: id }),
      // Sin `data`: los bytes se piden aparte, por su endpoint.
      this.db.select({
        id: gastoAdjuntos.id, nombre: gastoAdjuntos.nombre, mime: gastoAdjuntos.mime,
        subidoEn: gastoAdjuntos.subidoEn,
      }).from(gastoAdjuntos).where(eq(gastoAdjuntos.gastoId, id)).orderBy(asc(gastoAdjuntos.id)),
      // Los renglones (0067). Un gasto viejo no tiene: el array vacío es válido.
      this.db.select().from(gastoItems).where(eq(gastoItems.gastoId, id)).orderBy(asc(gastoItems.id)),
    ]);
    /* Las NC (0115): las que le descuentan a ESTE gasto, y si es una NC, de cuál
     * descuenta. `pagado` incluye lo acreditado; `pagadoEnPlata` es lo que salió. */
    const notasCredito = await this.db.select({
      id: gastos.id, numero: gastos.numero, fecha: gastos.fecha, total: gastos.total,
    }).from(gastos).where(and(
      eq(gastos.refGastoId, id), eq(gastos.tipoDoc, 'nota_credito'), ne(gastos.estado, 'anulado'),
    )).orderBy(asc(gastos.id));
    const acreditado = money(notasCredito.reduce((a, n) => a - n.total, 0));
    /* El papel del proveedor al que quedó vinculado cada renglón de flete (0244). */
    const idsPapel = [...new Set(items.map((i) => i.fleteComprobanteId).filter((x): x is number => !!x))];
    const papelesFlete = idsPapel.length
      ? await this.db.select({
        id: comprobantes.id, tipo: comprobantes.tipo, letra: comprobantes.letra, puntoVenta: comprobantes.puntoVenta,
        numero: comprobantes.numero, fecha: comprobantes.fecha,
      }).from(comprobantes).where(inArray(comprobantes.id, idsPapel))
      : [];
    const [refGasto] = g.refGastoId
      ? await this.db.select({ id: gastos.id, numero: gastos.numero, descripcion: gastos.descripcion })
        .from(gastos).where(eq(gastos.id, g.refGastoId)).limit(1)
      : [null];
    return {
      ...g, saldo: money(g.total - g.pagado), pagos, adjuntos,
      items: items.map((i) => ({ ...i, fletePapel: papelesFlete.find((p) => p.id === i.fleteComprobanteId) ?? null })),
      notasCredito, acreditado, pagadoEnPlata: money(g.pagado - acreditado), refGasto: refGasto ?? null,
    };
  }

  /**
   * Bandeja de vencimientos: lo que falta pagar, ordenado por urgencia. `dias`
   * es negativo cuando ya venció — el frontend pinta con eso sin recalcular
   * fechas (y sin discutir con la zona horaria del navegador).
   */
  async cuentasAPagar(q: any = {}) {
    const conds: any[] = [
      ne(gastos.estado, 'anulado'),
      sql`${gastos.total} - ${gastos.pagado} > 0.009`,
    ];
    if (q.sucursalId) conds.push(eq(gastos.sucursalId, Number(q.sucursalId)));
    if (q.proveedorId) conds.push(eq(gastos.proveedorId, Number(q.proveedorId)));
    const filas = await this.db.select().from(gastos)
      .where(and(...conds))
      .orderBy(asc(sql`coalesce(${gastos.vencimiento}, ${gastos.fecha})`), asc(gastos.id));

    const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
    return filas.map((g) => {
      const ref = g.vencimiento ? new Date(g.vencimiento) : null;
      let dias: number | null = null;
      if (ref) {
        const d = new Date(ref); d.setHours(0, 0, 0, 0);
        dias = Math.round((d.getTime() - hoy.getTime()) / 86400000);
      }
      return { ...g, saldo: money(g.total - g.pagado), dias };
    });
  }

  /**
   * Contador para el badge del sidebar: cuántos gastos están vencidos o vencen
   * hoy. Endpoint chico a propósito — lo pollea el ERP cada 30 segundos.
   */
  async pendientes() {
    const hoy = new Date(); hoy.setHours(23, 59, 59, 999);
    const [r] = await this.db.select({
      vencidos: sql<number>`count(*) filter (where ${gastos.vencimiento} is not null and ${gastos.vencimiento} <= ${hoy.toISOString()})::int`,
      pendientes: sql<number>`count(*)::int`,
      saldo: sql<number>`coalesce(sum(${gastos.total} - ${gastos.pagado}), 0)`,
    }).from(gastos).where(and(
      ne(gastos.estado, 'anulado'),
      sql`${gastos.total} - ${gastos.pagado} > 0.009`,
    ));
    return {
      vencidos: Number(r?.vencidos) || 0,
      pendientes: Number(r?.pendientes) || 0,
      saldo: money(Number(r?.saldo) || 0),
    };
  }

  /**
   * Resumen de gerencia: en qué se va la plata. Todo agregado en la base — el
   * período puede tener miles de filas y no tiene sentido traerlas para sumar
   * en JavaScript.
   */
  /**
   * PROVEEDORES DE GASTOS (19/11/2026, pedido del dueño): por cada proveedor
   * que factura gastos, lo del período (comprobantes y total, como el resumen:
   * sin anulados, las notas de crédito restan), lo que FALTA PAGARLE de
   * siempre, el último gasto y su rubro de siempre. La ficha (CUIT, contacto)
   * la pide la pantalla del padrón aparte, detrás del mismo permiso.
   */
  async porProveedor(q: ConsultaGastosDto) {
    const enPeriodo = sql.join([
      sql`true`,
      ...(q.desde ? [sql`g.fecha >= ${fechaLocal(q.desde)}`] : []),
      ...(q.hasta ? [sql`g.fecha <= ${new Date(`${String(q.hasta).slice(0, 10)}T23:59:59.999`)}`] : []),
      ...(q.negocio ? [sql`g.negocio = ${q.negocio}`] : []),
    ], sql` and `);
    const r: any = await this.db.execute(sql`
      select p.id as "proveedorId",
        count(g.id) filter (where ${enPeriodo})::int as comprobantes,
        coalesce(sum(g.total) filter (where ${enPeriodo}), 0)::float8 as total,
        coalesce(sum(greatest(g.total - g.pagado, 0)), 0)::float8 as "faltaPagar",
        max(g.fecha) as ultimo,
        (select c.nombre from gastos g2 join gasto_categorias c on c.id = g2.categoria_id
          where g2.proveedor_id = p.id and g2.estado <> 'anulado'
          group by c.nombre order by count(*) desc, c.nombre limit 1) as rubro
      from proveedores p
      left join gastos g on g.proveedor_id = p.id and g.estado <> 'anulado'
      where p.provee_gastos
      group by p.id`);
    return (r.rows as any[]).map((x) => ({
      proveedorId: Number(x.proveedorId), comprobantes: Number(x.comprobantes), total: money(Number(x.total)),
      faltaPagar: money(Number(x.faltaPagar)), ultimo: x.ultimo ? new Date(x.ultimo).toISOString() : null, rubro: x.rubro ?? '',
    }));
  }

  async resumen(q: any) {
    const conds: any[] = [ne(gastos.estado, 'anulado')];
    if (q.desde) conds.push(gte(gastos.fecha, fechaLocal(q.desde)!));
    if (q.hasta) conds.push(lte(gastos.fecha, new Date(`${String(q.hasta).slice(0, 10)}T23:59:59.999`)));
    if (q.sucursalId) conds.push(eq(gastos.sucursalId, Number(q.sucursalId)));
    /* El mismo filtro que el listado (0101): sin él, "cuánto gasté" sumaba
     * los dos negocios sin forma de separarlos. */
    if (q.negocio) conds.push(eq(gastos.negocio, q.negocio));
    const where = and(...conds);

    const [[totales], porCategoria, porMes, porProveedor] = await Promise.all([
      this.db.select({
        cantidad: sql<number>`count(*)::int`,
        total: sql<number>`coalesce(sum(${gastos.total}), 0)`,
        neto: sql<number>`coalesce(sum(${gastos.neto}), 0)`,
        iva: sql<number>`coalesce(sum(${gastos.iva}), 0)`,
        // Lo PAGADO en plata: `pagado` incluye lo que acreditan las NC con gasto (0115),
        // y esas NC (en negativo) lo restan acá.
        pagado: sql<number>`coalesce(sum(${gastos.pagado}), 0) + coalesce(sum(${gastos.total}) filter (where ${gastos.tipoDoc} = 'nota_credito' and ${gastos.refGastoId} is not null), 0)`,
        // Falta pagar = lo que deben los gastos con saldo; la NC (negativa) no se paga.
        faltaPagar: sql<number>`coalesce(sum(greatest(${gastos.total} - ${gastos.pagado}, 0)), 0)`,
      }).from(gastos).where(where),

      this.db.select({
        categoriaId: gastos.categoriaId,
        nombre: gastoCategorias.nombre,
        tipo: gastoCategorias.tipo,
        cantidad: sql<number>`count(*)::int`,
        total: sql<number>`coalesce(sum(${gastos.total}), 0)`,
      }).from(gastos)
        .innerJoin(gastoCategorias, eq(gastoCategorias.id, gastos.categoriaId))
        .where(where)
        .groupBy(gastos.categoriaId, gastoCategorias.nombre, gastoCategorias.tipo)
        .orderBy(desc(sql`sum(${gastos.total})`)),

      this.db.select({
        mes: sql<string>`to_char(${gastos.fecha}, 'YYYY-MM')`,
        total: sql<number>`coalesce(sum(${gastos.total}), 0)`,
      }).from(gastos).where(where)
        .groupBy(sql`to_char(${gastos.fecha}, 'YYYY-MM')`)
        .orderBy(asc(sql`to_char(${gastos.fecha}, 'YYYY-MM')`)),

      this.db.select({
        proveedorId: gastos.proveedorId,
        nombre: sql<string>`coalesce(${proveedores.nombre}, nullif(${gastos.proveedorTexto}, ''), 'Sin proveedor')`,
        cantidad: sql<number>`count(*)::int`,
        total: sql<number>`coalesce(sum(${gastos.total}), 0)`,
      }).from(gastos)
        .leftJoin(proveedores, eq(proveedores.id, gastos.proveedorId))
        .where(where)
        .groupBy(gastos.proveedorId, proveedores.nombre, gastos.proveedorTexto)
        .orderBy(desc(sql`sum(${gastos.total})`))
        .limit(15),
    ]);

    const cat = porCategoria.map((c) => ({ ...c, total: money(Number(c.total)) }));
    const fijos = money(cat.filter((c) => c.tipo === 'fijo').reduce((a, c) => a + c.total, 0));
    const variables = money(cat.filter((c) => c.tipo === 'variable').reduce((a, c) => a + c.total, 0));

    return {
      cantidad: Number(totales?.cantidad) || 0,
      total: money(Number(totales?.total) || 0),
      neto: money(Number(totales?.neto) || 0),
      // IVA de los gastos = crédito fiscal (lo que se descuenta del IVA ventas).
      iva: money(Number(totales?.iva) || 0),
      pagado: money(Number(totales?.pagado) || 0),
      saldo: money(Number(totales?.faltaPagar) || 0),
      porCategoria: cat,
      porMes: porMes.map((m) => ({ ...m, total: money(Number(m.total)) })),
      porProveedor: porProveedor.map((p) => ({ ...p, total: money(Number(p.total)) })),
      porTipo: { fijos, variables },
    };
  }

  /* ---------------- Gastos: escritura ---------------- */

  /**
   * EL PIE ABIERTO (0071). Los tres del papel, más lo que se cargó sin
   * detallar; `otros` sale siendo la SUMA de los cuatro porque es la columna
   * que ya leen el resumen y los listados.
   */
  private extrasDe(dto: GastoDto) {
    const impInternos = money(dto.impInternos ?? 0);
    const percDgi = money(dto.percDgi ?? 0);
    const percDgr = money(dto.percDgr ?? 0);
    const sinDetallar = money(dto.otros ?? 0);
    return {
      impInternos, percDgi, percDgr,
      otros: money(sinDetallar + impInternos + percDgi + percDgr),
    };
  }

  private totalesDe(dto: GastoDto) {
    const neto = money(dto.neto ?? 0);
    const iva = money(dto.iva ?? 0);
    const extras = this.extrasDe(dto);
    return { neto, iva, ...extras, total: money(neto + iva + extras.otros) };
  }

  /**
   * LOS IMPORTES DEL GASTO, con o sin renglones (0067).
   *
   * Con renglones, mandan ellos — y `ivaAparte` dice cómo leerlos:
   *
   *  · SIN el flag (defecto): montos FINALES, como se leen de un ticket o una
   *    factura B. El total es la suma, `iva` es el "IVA incluido" informativo
   *    —se acota al total, porque un IVA mayor que el total es un error de
   *    tipeo, no un dato— y el neto se DERIVA (total − IVA).
   *  · CON el flag: la factura A. Los renglones son NETOS tal como los lista
   *    el papel, el IVA se copia del pie y SE SUMA: total = neto + IVA. Acá
   *    neto e IVA dejan de ser derivados: son los del comprobante. Un IVA
   *    mayor que el neto se RECHAZA en vez de acotarse — en este modo el IVA
   *    cambia el total, y corregirlo en silencio le mentiría al que está
   *    mirando el papel.
   *
   * En los dos modos la descripción se escribe sola con los conceptos: es lo
   * que muestran el listado, la búsqueda y el concepto del pago — todo lo que
   * ya existía sigue andando sin enterarse del cambio.
   *
   * Sin renglones vale el camino de siempre: gastos viejos al editarse, los
   * fijos generados y cualquier consumidor externo de la API. Y no hay columna
   * nueva: al editar, el modo se deduce (si el neto guardado coincide con la
   * suma de los renglones y hay IVA, eran netos).
   */
  private importesDe(dto: GastoDto) {
    const renglones = (dto.items ?? [])
      .map((i) => ({
        concepto: (i.concepto ?? '').trim(), monto: money(i.monto), cantidad: i.cantidad || null,
        fleteOrigen: i.fleteOrigen ?? null, fleteProveedorId: i.fleteProveedorId ?? null,
        fleteComprobanteId: i.fleteComprobanteId ?? null, fleteReferencia: (i.fleteReferencia ?? '').trim(),
      }))
      .filter((i) => i.concepto && i.monto > 0);
    if (!renglones.length) return { ...this.totalesDe(dto), items: null, descripcion: null };

    const suma = money(renglones.reduce((a, i) => a + i.monto, 0));
    const descripcion = renglones.map((i) => i.concepto).join(' · ');
    /*
     * El pie SIEMPRE se suma, en los dos modos (0071). Los impuestos internos
     * y las percepciones se liquidan abajo del subtotal, así que están fuera
     * del importe de los renglones vengan netos o finales — hasta un ticket
     * puede traer percepción de Ingresos Brutos.
     */
    const extras = this.extrasDe(dto);

    if (dto.ivaAparte) {
      const iva = money(dto.iva ?? 0);
      if (iva < 0) throw new BadRequestException('El IVA no puede ser negativo.');
      // La alícuota más alta es 27%: un IVA que supera el neto entero no salió
      // de ninguna factura. Se corta acá, antes de que infle el total.
      if (iva > suma) {
        throw new BadRequestException('El IVA supera el neto de los conceptos: revisá el pie de la factura.');
      }
      return {
        total: money(suma + iva + extras.otros), iva, neto: suma, ...extras,
        items: renglones, descripcion,
      };
    }

    const iva = Math.min(money(dto.iva ?? 0), suma);
    return {
      total: money(suma + extras.otros),
      iva,
      neto: money(suma - iva),
      ...extras,
      items: renglones,
      descripcion,
    };
  }

  /* ---------------- Fletes de mercadería (0244, ver `fletes.ts`) ---------------- */

  private faltaOrigen(transporte: string, concepto?: string) {
    return `${transporte} es un transporte: decí de qué proveedor trajo${concepto ? ` «${concepto}»` : ' cada renglón'}, o marcalo como otra cosa.`;
  }

  /**
   * DE DÓNDE VINO CADA RENGLÓN, validado y completado. Con `transporte` (la factura
   * de un transporte, no una NC) cada renglón TIENE que decirlo. El de un proveedor
   * apunta a un proveedor de mercadería; su factura o remito, si se eligió, tiene que
   * ser suyo y estar vigente; si solo se escribió el número y ese papel ya está
   * cargado, se vincula solo. 'otro' y sin origen no llevan nada más.
   */
  private async resolverFletes<T extends { concepto: string } & FleteDeRenglonDto>(
    renglones: T[], transporte: { nombre: string } | null,
  ) {
    if (transporte) {
      const falta = renglones.find((r) => !r.fleteOrigen);
      if (falta) throw new BadRequestException(this.faltaOrigen(transporte.nombre, falta.concepto));
    }
    const deProveedor = renglones.filter((r) => r.fleteOrigen === 'proveedor');
    const sinProveedor = deProveedor.find((r) => !r.fleteProveedorId);
    if (sinProveedor) throw new BadRequestException(`Elegí de qué proveedor trajo «${sinProveedor.concepto}».`);
    const provIds = [...new Set(deProveedor.map((r) => Number(r.fleteProveedorId)))];
    const [provs, papeles] = provIds.length
      ? await Promise.all([
        this.db.select({ id: proveedores.id, nombre: proveedores.nombre, proveeMercaderia: proveedores.proveeMercaderia })
          .from(proveedores).where(inArray(proveedores.id, provIds)),
        this.db.select({
          id: comprobantes.id, proveedorId: comprobantes.proveedorId, puntoVenta: comprobantes.puntoVenta, numero: comprobantes.numero,
        }).from(comprobantes).where(and(
          inArray(comprobantes.proveedorId, provIds), eq(comprobantes.estado, 'confirmado'),
          inArray(comprobantes.tipo, [...TIPOS_CON_FLETE]),
        )),
      ])
      : [[], []];
    return renglones.map((r) => {
      if (r.fleteOrigen !== 'proveedor') {
        return { ...r, fleteOrigen: r.fleteOrigen ?? null, fleteProveedorId: null, fleteComprobanteId: null, fleteReferencia: '' };
      }
      const prov = provs.find((x) => x.id === Number(r.fleteProveedorId));
      if (!prov?.proveeMercaderia) {
        throw new BadRequestException(`El proveedor elegido para «${r.concepto}» no vende mercadería: elegí de quién trajo o marcalo como otra cosa.`);
      }
      const suyos = papeles.filter((c) => c.proveedorId === prov.id);
      const referencia = (r.fleteReferencia ?? '').trim();
      let comprobanteId = r.fleteComprobanteId ?? null;
      if (comprobanteId && !suyos.some((c) => c.id === comprobanteId)) {
        throw new BadRequestException(`La factura o el remito elegido para «${r.concepto}» no es de ${prov.nombre} o está anulado.`);
      }
      if (!comprobanteId && referencia) {
        const iguales = suyos.filter((c) => coincideNumero(referencia, c));
        if (iguales.length === 1) comprobanteId = iguales[0].id;
      }
      return {
        ...r, fleteOrigen: 'proveedor' as const, fleteProveedorId: prov.id,
        fleteComprobanteId: comprobanteId, fleteReferencia: comprobanteId ? '' : referencia,
      };
    });
  }

  /** Corregir o completar de dónde vino cada renglón (el detalle del gasto, o las cargas viejas sin asignar). */
  async asignarFletes(dto: AsignarFletesDto) {
    const ids = [...new Set(dto.renglones.map((r) => r.itemId))];
    if (!ids.length) throw new BadRequestException('No indicaste ningún renglón.');
    const actuales = await this.db.select({ id: gastoItems.id, concepto: gastoItems.concepto, estado: gastos.estado })
      .from(gastoItems).innerJoin(gastos, eq(gastos.id, gastoItems.gastoId)).where(inArray(gastoItems.id, ids));
    const porId = new Map(actuales.map((a) => [a.id, a]));
    for (const r of dto.renglones) {
      const a = porId.get(r.itemId);
      if (!a) throw new NotFoundException('Uno de los renglones ya no existe: actualizá la pantalla.');
      if (a.estado === 'anulado') throw new BadRequestException(`«${a.concepto}» es de un gasto anulado.`);
    }
    const listos = await this.resolverFletes(dto.renglones.map((r) => ({ ...r, concepto: porId.get(r.itemId)!.concepto })), null);
    await this.db.transaction(async (tx) => {
      for (const r of listos) {
        await tx.update(gastoItems).set({
          fleteOrigen: r.fleteOrigen, fleteProveedorId: r.fleteProveedorId,
          fleteComprobanteId: r.fleteComprobanteId, fleteReferencia: r.fleteReferencia,
        }).where(eq(gastoItems.id, r.itemId));
      }
    });
    return { ok: true, asignados: listos.length };
  }

  /** Las facturas y remitos recientes de un proveedor, para elegir de cuál fue el flete. */
  async papelesParaFlete(proveedorId: number) {
    const r: any = await this.db.execute(sql`
      select c.id, c.tipo, c.letra, c.punto_venta, c.numero, c.fecha, c.subtotal_neto,
             (select count(*)::int from gasto_items i join gastos g on g.id = i.gasto_id
               where i.flete_comprobante_id = c.id and g.estado <> 'anulado') as fletes
        from comprobantes c
       where c.proveedor_id = ${proveedorId} and c.estado = 'confirmado'
         and c.tipo in ('factura', 'remito', 'liquidacion') and c.fecha >= now() - interval '180 days'
       order by c.fecha desc, c.id desc
       limit 40`);
    return ((r.rows ?? r) as any[]).map((x) => ({
      id: Number(x.id), tipo: x.tipo, letra: x.letra, puntoVenta: x.punto_venta, numero: x.numero == null ? null : Number(x.numero),
      fecha: x.fecha, neto: money(Number(x.subtotal_neto)), fletes: Number(x.fletes),
    }));
  }

  /**
   * EL FLETE REAL DE CADA PROVEEDOR en el período: lo que se le pagó al transporte por
   * traer su mercadería (sin IVA, por la fecha de la factura del transporte) contra lo
   * que se le compró (neto de sus facturas, remitos y liquidaciones), y al lado el
   * flete % que cargan sus formatos de compra (lo que ya está en el costo). Con el
   * detalle renglón por renglón y las cargas viejas sin asignar, con su sugerencia.
   */
  async reporteFletes(q: ConsultaGastosDto) {
    const hoy = hoyAr();
    const desde = q.desde ?? `${hoy.slice(0, 7)}-01`;
    const hasta = q.hasta ?? hoy;
    const ini = fechaLocal(desde)!;
    const fin = new Date(`${hasta}T23:59:59.999`);
    const filas = async (consulta: any) => { const r: any = await this.db.execute(consulta); return (r.rows ?? r) as any[]; };
    const [renglones, compras, enCosto, viejos, transportes, sinMarcar, padron] = await Promise.all([
      filas(sql`
        select i.id, i.concepto, i.cantidad, i.flete_origen, i.flete_proveedor_id, i.flete_referencia, ${NETO_DEL_RENGLON} as neto,
               o.nombre as proveedor, g.id as gasto_id, g.fecha, g.letra, g.numero, coalesce(t.nombre, g.proveedor_texto) as transporte,
               c.id as papel_id, c.tipo as papel_tipo, c.letra as papel_letra, c.punto_venta as papel_pv, c.numero as papel_numero,
               to_char(c.fecha, 'YYYY-MM-DD') as papel_dia, ${NETO_DE_LA_ENTREGA} as entrega_neto, ${PAPELES_DE_LA_ENTREGA} as entrega_papeles
          from gasto_items i join gastos g on g.id = i.gasto_id
          left join proveedores t on t.id = g.proveedor_id
          left join proveedores o on o.id = i.flete_proveedor_id
          left join comprobantes c on c.id = i.flete_comprobante_id
         where i.flete_origen is not null and g.estado <> 'anulado' and g.fecha >= ${ini} and g.fecha <= ${fin}
         order by g.fecha desc, i.id`),
      filas(sql`
        select c.proveedor_id, sum(c.subtotal_neto) as neto, count(*)::int as papeles
          from comprobantes c
         where c.estado = 'confirmado' and c.tipo in ('factura', 'remito', 'liquidacion') and c.fecha >= ${ini} and c.fecha <= ${fin}
         group by 1`),
      /* El flete % de sus formatos: el que tienen la mayoría de sus productos (y el rango). */
      filas(sql`select proveedor_id, min(flete) as min, max(flete) as max, mode() within group (order by flete) as habitual
                  from producto_proveedores where modo_costo = 'lista' group by 1`),
      filas(sql`
        select i.id, i.concepto, i.cantidad, ${NETO_DEL_RENGLON} as neto, g.id as gasto_id, g.fecha, g.letra, g.numero, t.nombre as transporte
          from gasto_items i join gastos g on g.id = i.gasto_id join proveedores t on t.id = g.proveedor_id
         where t.trae_mercaderia and i.flete_origen is null and g.estado <> 'anulado' and g.tipo_doc <> 'nota_credito'
         order by g.fecha desc, i.id
         limit 300`),
      this.db.select({ id: proveedores.id, nombre: proveedores.nombre }).from(proveedores)
        .where(eq(proveedores.traeMercaderia, true)).orderBy(asc(proveedores.nombre)),
      filas(sql`
        select p.id, p.nombre, count(*)::int as gastos
          from gastos g join proveedores p on p.id = g.proveedor_id join gasto_categorias gc on gc.id = g.categoria_id
         where not p.trae_mercaderia and gc.nombre ilike '%flete%' and g.estado <> 'anulado' and g.fecha >= now() - interval '180 days'
         group by 1, 2 order by 3 desc`),
      this.db.select({ id: proveedores.id, nombre: proveedores.nombre }).from(proveedores)
        .where(and(eq(proveedores.proveeMercaderia, true), eq(proveedores.traeMercaderia, false))),
    ]);
    const pct = (parte: number, todo: number) => (todo > 0 ? Math.round((parte / todo) * 1000) / 10 : null);
    const detalle = renglones.map((x) => {
      const neto = money(Number(x.neto));
      const entregaNeto = money(Number(x.entrega_neto));
      return {
        itemId: Number(x.id), gastoId: Number(x.gasto_id), fecha: x.fecha, transporte: String(x.transporte ?? ''),
        numero: x.numero ? `${x.letra} ${x.numero}` : '', concepto: String(x.concepto), cantidad: x.cantidad == null ? null : Number(x.cantidad),
        neto, origen: x.flete_origen as FleteOrigen,
        proveedorId: x.flete_proveedor_id == null ? null : Number(x.flete_proveedor_id), proveedor: x.proveedor ?? null,
        referencia: String(x.flete_referencia ?? ''),
        papel: x.papel_id == null ? null : {
          id: Number(x.papel_id), tipo: x.papel_tipo, letra: x.papel_letra, puntoVenta: x.papel_pv,
          numero: x.papel_numero == null ? null : Number(x.papel_numero),
          /* La entrega: este papel y los otros del proveedor de ese día (la otra mitad). */
          dia: String(x.papel_dia), netoEntrega: entregaNeto, papelesEntrega: Number(x.entrega_papeles), pct: pct(neto, entregaNeto),
        },
      };
    });
    const comprasDe = new Map(compras.map((c) => [Number(c.proveedor_id), { neto: money(Number(c.neto)), papeles: Number(c.papeles) }]));
    const costoDe = new Map(enCosto.map((c) => [Number(c.proveedor_id), { min: Number(c.min), max: Number(c.max), habitual: Number(c.habitual) }]));
    /*
     * EL % REAL. Con fletes vinculados a su factura o remito, contra ESOS papeles: es lo
     * exacto (el flete de noviembre puede ser de la factura de octubre). Sin ninguno
     * vinculado, contra lo comprado en el período: una aproximación, y se dice cuál fue.
     */
    type Acum = { id: number; nombre: string; flete: number; renglones: number; sinPapel: number; fleteConPapel: number; entregas: Map<string, number> };
    const porProveedor = new Map<number, Acum>();
    for (const d of detalle) {
      if (d.origen !== 'proveedor' || d.proveedorId == null) continue;
      const p = porProveedor.get(d.proveedorId)
        ?? { id: d.proveedorId, nombre: d.proveedor ?? '', flete: 0, renglones: 0, sinPapel: 0, fleteConPapel: 0, entregas: new Map() };
      p.flete = money(p.flete + d.neto);
      p.renglones += 1;
      if (d.papel) { p.fleteConPapel = money(p.fleteConPapel + d.neto); p.entregas.set(d.papel.dia, d.papel.netoEntrega); } else p.sinPapel += 1;
      porProveedor.set(d.proveedorId, p);
    }
    const proveedoresRes = [...porProveedor.values()].map(({ entregas, fleteConPapel, ...p }) => {
      const netoPapeles = money([...entregas.values()].reduce((a, n) => a + n, 0));
      const periodo = comprasDe.get(p.id) ?? { neto: 0, papeles: 0 };
      const conPapeles = netoPapeles > 0;
      return {
        ...p, base: conPapeles ? 'papeles' as const : 'periodo' as const,
        compras: conPapeles ? netoPapeles : periodo.neto, entregas: conPapeles ? entregas.size : periodo.papeles,
        pctReal: conPapeles ? pct(fleteConPapel, netoPapeles) : pct(p.flete, periodo.neto), enCosto: costoDe.get(p.id) ?? null,
      };
    }).sort((a, b) => b.flete - a.flete);
    const otros = detalle.filter((d) => d.origen === 'otro');
    const viejosConSugerido = viejos.map((x) => ({ x, s: sugerirProveedor(String(x.concepto), padron) }));
    /* Un papel se sugiere a UN solo flete de la tanda: si dos fletes caen en el mismo, el segundo se elige a mano. */
    const papelesUsados = new Set<number>();
    const idsSugeridos = [...new Set(viejosConSugerido.filter((v) => v.s).map((v) => v.s!.id))];
    const papelesLibres = idsSugeridos.length ? await filas(sql`
      select c.id, c.proveedor_id, c.tipo, c.letra, c.punto_venta, c.numero, c.fecha
        from comprobantes c
       where c.proveedor_id in (${sql.join(idsSugeridos.map((id) => sql`${id}`), sql`, `)})
         and c.estado = 'confirmado' and c.tipo in ('factura', 'remito', 'liquidacion')
         and not exists (select 1 from gasto_items i join gastos g on g.id = i.gasto_id
                          where i.flete_comprobante_id = c.id and g.estado <> 'anulado')`) : [];
    return {
      desde, hasta,
      proveedores: proveedoresRes,
      otros: { neto: money(otros.reduce((a, d) => a + d.neto, 0)), renglones: otros.length },
      detalle,
      sinAsignar: viejosConSugerido.map(({ x, s }) => {
        const cercano = s ? papelMasCercano(x.fecha, papelesLibres.filter((c) => Number(c.proveedor_id) === s.id)) : null;
        const papel = cercano && !papelesUsados.has(Number(cercano.id)) ? cercano : null;
        if (papel) papelesUsados.add(Number(papel.id));
        return {
          itemId: Number(x.id), gastoId: Number(x.gasto_id), fecha: x.fecha, transporte: String(x.transporte),
          numero: x.numero ? `${x.letra} ${x.numero}` : '', concepto: String(x.concepto),
          cantidad: x.cantidad == null ? null : Number(x.cantidad), neto: money(Number(x.neto)),
          sugerido: s ? { id: s.id, nombre: s.nombre } : null,
          papelSugerido: papel ? {
            id: Number(papel.id), tipo: papel.tipo, letra: papel.letra, puntoVenta: papel.punto_venta,
            numero: papel.numero == null ? null : Number(papel.numero), fecha: papel.fecha,
          } : null,
        };
      }),
      transportes,
      sinMarcar: sinMarcar.map((x) => ({ id: Number(x.id), nombre: String(x.nombre), gastos: Number(x.gastos) })),
    };
  }

  /**
   * Guard de duplicado: cargar dos veces la misma factura es EL error clásico
   * de un módulo de gastos, y se detecta tarde (cuando el resumen del mes da
   * más de lo que da el banco). Con proveedor y número, la combinación tiene
   * que ser única.
   */
  /*
   * EL NÚMERO SE COMPARA NORMALIZADO (27/9/2026): "0001-00000123" y "1-123"
   * son el mismo papel y pasaban los dos. Punto de venta y número se comparan
   * como números; cualquier otro formato, sin espacios ni signos ni mayúsculas.
   * Y el gasto SIN proveedor del padrón (el plomero escrito a mano) también se
   * controla, por el nombre escrito.
   */
  private async chequearDuplicado(
    proveedorId: number | null, letra: string, numero: string, exceptoId?: number, proveedorTexto?: string,
  ) {
    const clave = normalizarNumero(numero);
    const texto = normalizarTexto(proveedorTexto);
    if (!clave || (!proveedorId && !texto)) return;
    const conds: any[] = [
      eq(gastos.letra, letra as any),
      ne(gastos.estado, 'anulado'),
      sql`${gastos.numero} <> ''`,
      proveedorId ? eq(gastos.proveedorId, proveedorId) : sql`${gastos.proveedorId} is null`,
    ];
    if (exceptoId) conds.push(ne(gastos.id, exceptoId));
    const candidatos = await this.db.select({ id: gastos.id, numero: gastos.numero, proveedorTexto: gastos.proveedorTexto })
      .from(gastos).where(and(...conds));
    const ya = candidatos.find((c) => normalizarNumero(c.numero) === clave
      && (proveedorId || normalizarTexto(c.proveedorTexto) === texto));
    if (ya) {
      throw new BadRequestException(
        `Ese comprobante ya está cargado (gasto #${ya.id}). Si es otro, revisá el número o el proveedor.`,
      );
    }
  }

  /**
   * LA SUCURSAL DEL DOCUMENTO NO LA ELIGE EL CLIENTE.
   *
   * Es a la que se le imputa el gasto: define el resumen por sucursal y, sobre
   * todo, define qué pagos lo pueden explicar. Sin esto, un cajero de Express 2
   * le colgaba $200.000 de "reparación" a Fontana y de paso creaba un documento
   * tomable por los pagos a cuenta de Fontana.
   *
   * No usa `sucursalDeOperacion()` a propósito: ahí `null` no significa nada,
   * y acá SÍ — es el gasto de toda la empresa (el alquiler de la oficina, el
   * contador). Esa opción queda para el jefe, que es el único que ve más de un
   * mostrador; el resto graba en la suya y punto.
   */
  private sucursalDelGasto(sesion: Sesion, pedida?: number | null): number | null {
    if (esJefe(sesion)) return pedida ?? null;
    return sesion.sucursalId ?? null;
  }

  /**
   * CONTRA QUÉ GASTO DESCUENTA UNA NC (0115, 28/9/2026). Del mismo proveedor,
   * vivo, que no sea otra NC, y que le quede saldo para absorberla: una NC de
   * $300 contra un gasto que debe $200 dejaría el gasto "pagado de más".
   * `creditoPropio` es lo que ESTA misma NC ya le acredita (al editarla).
   */
  private async validarRefNc(
    refId: number, importeNc: number, proveedorId: number | null, proveedorTexto: string, creditoPropio = 0,
  ) {
    const [t] = await this.db.select().from(gastos).where(eq(gastos.id, refId)).limit(1);
    if (!t) throw new BadRequestException('El gasto del que descuenta la nota de crédito no existe.');
    if (t.estado === 'anulado') throw new BadRequestException(`El gasto #${t.id} está anulado: la nota de crédito no descuenta de él.`);
    if (esNotaCredito(t.tipoDoc) || t.total < 0) throw new BadRequestException('Una nota de crédito descuenta de un gasto, no de otra nota de crédito.');
    const mismo = proveedorId
      ? t.proveedorId === proveedorId
      : !t.proveedorId && normalizarTexto(t.proveedorTexto) === normalizarTexto(proveedorTexto);
    if (!mismo) throw new BadRequestException(`El gasto #${t.id} es de otro proveedor: la nota de crédito descuenta de un gasto del mismo.`);
    const disponible = money(t.total - t.pagado + creditoPropio);
    if (importeNc - disponible > 0.009) {
      throw new BadRequestException(
        `Al gasto #${t.id} le quedan ${disponible.toFixed(2)} por pagar y la nota de crédito es de ${importeNc.toFixed(2)}: `
        + 'no puede descontar más de lo que el gasto debe. Cargala sin gasto (queda como crédito del proveedor) o elegí otro.',
      );
    }
    return t.id;
  }

  async crear(dto: GastoDto, sesion: Sesion) {
    /*
     * El alta con "lo pagué y lo cargo" tildado hace salir plata del cajón, así
     * que exige TAMBIÉN el permiso de pagar. El `@Permiso` del endpoint no puede
     * expresar esto —es un OR fijo, y el pago es opcional—, así que la condición
     * se pregunta acá, que es donde se sabe si el pago viene o no.
     */
    if (dto.pagoInmediato && !tienePermiso(sesion.permisos, PERMISOS_PAGO)) {
      throw new ForbiddenException(
        'Podés cargar el gasto, pero no registrar su pago: eso saca plata de la caja y necesita permiso propio.',
      );
    }
    if (dto.pagoInmediato) {
      this.exigirPagoPropio(sesion, this.sucursalDelGasto(sesion, dto.sucursalId), dto.pagoInmediato);
    }
    const [cat] = await this.db.select().from(gastoCategorias)
      .where(eq(gastoCategorias.id, Number(dto.categoriaId))).limit(1);
    if (!cat) throw new BadRequestException('Elegí el rubro al que se imputa el gasto.');
    if (!cat.activa) throw new BadRequestException(`El rubro "${cat.nombre}" está dado de baja: elegí otro.`);

    let proveedorId: number | null = null;
    let transporte: { nombre: string } | null = null;
    if (dto.proveedorId) {
      const [p] = await this.db.select().from(proveedores).where(eq(proveedores.id, Number(dto.proveedorId))).limit(1);
      if (!p) throw new BadRequestException('Proveedor inválido.');
      proveedorId = p.id;
      if (p.traeMercaderia) transporte = p;
    }

    const calc = this.importesDe(dto);
    if (calc.total <= 0) throw new BadRequestException('El importe del gasto tiene que ser mayor a 0.');
    if (calc.items) calc.items = await this.resolverFletes(calc.items, esNotaCredito(dto.tipoDoc) ? null : transporte);
    else if (transporte && !esNotaCredito(dto.tipoDoc)) throw new BadRequestException(this.faltaOrigen(transporte.nombre));
    exigirFechasGasto(fechaLocal(dto.fecha), fechaLocal(dto.vencimiento));
    if (dto.pagoInmediato) exigirFechaPago(dto.pagoInmediato.fecha);
    const esNc = esNotaCredito(dto.tipoDoc);
    if (esNc && dto.pagoInmediato) {
      throw new BadRequestException('Una nota de crédito no se paga: descuenta lo que se le debe al proveedor.');
    }
    const {
      neto, iva, otros, impInternos, percDgi, percDgr, total, items, descripcion,
    } = conSigno(calc, esNc ? -1 : 1);
    if (dto.refGastoId && !esNc) throw new BadRequestException('Solo una nota de crédito descuenta de otro gasto.');
    const refGastoId = esNc && dto.refGastoId
      ? await this.validarRefNc(dto.refGastoId, calc.total, proveedorId, proveedorId ? '' : (dto.proveedorTexto ?? ''))
      : null;

    await exigirFueraDeConciliado(this.db, proveedorId, fechaLocal(dto.fecha), 'cargar un gasto');
    const numero = (dto.numero ?? '').trim();
    const letra = dto.letra ?? 'B';
    await this.chequearDuplicado(proveedorId, letra, numero, undefined, proveedorId ? '' : dto.proveedorTexto);

    const sucursalId = this.sucursalDelGasto(sesion, dto.sucursalId);

    const [creado] = await this.db.insert(gastos).values({
        fecha: fechaLocal(dto.fecha) ?? undefined,
        tipoDoc: (dto.tipoDoc ?? 'factura') as any,
        letra: letra as any,
        numero,
        proveedorId,
        proveedorTexto: proveedorId ? '' : (dto.proveedorTexto ?? '').trim(),
        categoriaId: cat.id,
        sucursalId,
        descripcion: descripcion ?? (dto.descripcion ?? '').trim(),
        condicionPago: (dto.condicionPago ?? 'contado') as any,
        negocio: (dto.negocio ?? 'distribuidora') as any,
        /* De Coffit y con fecha de un mes ya cerrado en su cuenta: entra hoy. */
        cuentaFecha: dto.negocio === 'cafeteria' ? await fechaDeCuenta(this.db, fechaLocal(dto.fecha) ?? new Date()) : null,
        vencimiento: fechaLocal(dto.vencimiento),
        periodo: periodoDe(dto.periodo, fechaLocal(dto.fecha) ?? new Date()),
        neto, iva, otros, impInternos, percDgi, percDgr, total,
        pagado: 0,
        estado: esNc ? 'pagado' : 'pendiente',
        refGastoId,
        observaciones: (dto.observaciones ?? '').trim(),
        usuarioId: dto.usuarioId ?? null,
    }).returning();
    if (items?.length) {
      await this.db.insert(gastoItems).values(items.map((i) => ({ ...i, gastoId: creado.id })));
    }
    // La NC con gasto (0115): el saldo de ese gasto baja ya.
    await this.pagos.recalcularGastoAhora(refGastoId);

    /*
     * "Lo pagué y lo cargo": el pago se registra como pago al proveedor y se
     * imputa a este gasto en un solo acto. Va DESPUÉS del alta porque el pago
     * maneja su propia transacción (egreso de caja incluido).
     *
     * TODO O NADA (27/9/2026). Antes, si el pago rebotaba (turno cerrado, de
     * otra sucursal…) el gasto quedaba cargado igual, pero la pantalla mostraba
     * el error con el formulario abierto: la persona corregía, volvía a
     * apretar y el gasto se cargaba DOS veces (probado). Ahora, si el pago no
     * entra, el alta se deshace — no salió plata ni quedó nada imputado — y el
     * formulario se reintenta limpio.
     */
    if (dto.pagoInmediato) {
      // El importe viene siempre: `PagoDto.importe` es obligatorio y tiene
      // `@Min(0.01)`, así que el `|| total` que había acá era una rama muerta.
      const importePago = money(dto.pagoInmediato.importe);
      await this.pagos.crear({
        destino: 'gastos',
        proveedorId: proveedorId ?? undefined,
        importe: importePago,
        medio: dto.pagoInmediato.medio,
        fecha: dto.pagoInmediato.fecha,
        referencia: dto.pagoInmediato.referencia,
        cambioPor: dto.pagoInmediato.cambioPor,
        cuentaPropiaId: dto.pagoInmediato.cuentaPropiaId,
        cuentaAMano: dto.pagoInmediato.cuentaAMano,
        concepto: (descripcion ?? dto.descripcion ?? '').trim() || `Gasto #${creado.id}`,
        sucursalId: sucursalId ?? undefined,
        cajaSesionId: dto.pagoInmediato.cajaSesionId,
        // `dto.usuarioId` y NO el del objeto anidado: el interceptor que pone el
        // autor solo pisa el nivel de arriba del body, así que el `usuarioId`
        // de `pagoInmediato` seguiría siendo el que mandó el cliente. El pago
        // del gasto lo firma el mismo que carga el gasto.
        usuarioId: dto.usuarioId,
        imputaciones: [{ gastoId: creado.id, importe: importePago }],
      }, sesion.sucursalId, esJefe(sesion)).catch(async (e) => {
        await this.db.delete(gastoItems).where(eq(gastoItems.gastoId, creado.id));
        await this.db.delete(gastos).where(and(eq(gastos.id, creado.id), sql`${gastos.pagado} = 0`));
        throw e;
      });
    }
    /* El rubro queda fijado en el proveedor (0240), recién cuando el gasto entró entero (con su pago, si lo traía). */
    if (dto.rubroDelProveedor === true && proveedorId) {
      await this.db.update(proveedores).set({ rubroGastoId: cat.id }).where(eq(proveedores.id, proveedorId));
    }
    return this.get(creado.id);
  }

  /**
   * Edición. Con pagos registrados solo se tocan los campos DESCRIPTIVOS: los
   * importes ya se movieron contra la caja o el banco, y cambiarlos por atrás
   * dejaría un pago mayor que su propio gasto.
   */
  async editar(id: number, dto: GastoDto, sesion: Sesion) {
    const [g] = await this.db.select().from(gastos).where(eq(gastos.id, id)).limit(1);
    if (!g) throw new NotFoundException('Gasto inexistente.');
    if (g.estado === 'anulado') throw new BadRequestException('El gasto está anulado: no se edita.');

    const patch: any = {};
    if (dto.categoriaId != null) {
      const [c] = await this.db.select().from(gastoCategorias).where(eq(gastoCategorias.id, Number(dto.categoriaId))).limit(1);
      if (!c) throw new BadRequestException('Rubro inválido.');
      if (!c.activa && c.id !== g.categoriaId) throw new BadRequestException(`El rubro "${c.nombre}" está dado de baja: elegí otro.`);
      patch.categoriaId = c.id;
    }
    if (dto.descripcion != null) patch.descripcion = String(dto.descripcion).trim();
    if (dto.observaciones != null) patch.observaciones = String(dto.observaciones).trim();
    if (dto.vencimiento !== undefined) patch.vencimiento = fechaLocal(dto.vencimiento);
    /*
     * MUDAR UN GASTO DE SUCURSAL ES COSA DEL JEFE — y para el resto el campo se
     * IGNORA, no se clava en la suya.
     *
     * La diferencia importa: clavarlo convertía cualquier edición inocente de un
     * no-jefe (corregir la descripción del alquiler de la oficina) en una
     * re-imputación silenciosa a su propia sucursal. Un gasto de "toda la
     * empresa" pasaba a ser de Express 2 por haberle arreglado una coma, y con
     * eso cambiaba el resumen por sucursal y cambiaba qué pagos lo pueden
     * explicar. En el ALTA sí se clava, porque ahí el documento nace.
     */
    if (dto.sucursalId !== undefined && esJefe(sesion)) {
      patch.sucursalId = dto.sucursalId ?? null;
      /* Elegir un local deja sin efecto el reparto por % que trajo de su gasto fijo (0216). */
      if (patch.sucursalId != null) patch.reparto = null;
    }
    // El negocio es imputación, no importe: se puede corregir aunque haya pagos.
    if (dto.negocio) patch.negocio = dto.negocio;

    const tienePagos = g.pagado > 0.009;
    if (!tienePagos) {
      if (dto.fecha) patch.fecha = fechaLocal(dto.fecha);
      if (dto.tipoDoc) patch.tipoDoc = dto.tipoDoc;
      if (dto.letra) patch.letra = dto.letra;
      if (dto.numero != null) patch.numero = String(dto.numero).trim();
      if (dto.condicionPago) patch.condicionPago = dto.condicionPago;
      if (dto.proveedorId !== undefined) {
        patch.proveedorId = dto.proveedorId ?? null;
        if (dto.proveedorId) patch.proveedorTexto = '';
      }
      if (dto.proveedorTexto != null && !patch.proveedorId) patch.proveedorTexto = String(dto.proveedorTexto).trim();
      /*
       * Con RENGLONES en la edición (0067), mandan ellos — en cualquiera de los
       * dos modos de `importesDe` (finales o netos con `ivaAparte`), mismo
       * criterio que el alta. Se reemplazan enteros (delete + insert): los
       * renglones no tienen identidad propia que valga conservar, son el
       * detalle del papel.
       */
      const conRenglones = this.importesDe(dto);
      if (conRenglones.items) {
        const provFinal = dto.proveedorId !== undefined ? (dto.proveedorId ?? null) : g.proveedorId;
        const [pf] = provFinal ? await this.db.select().from(proveedores).where(eq(proveedores.id, provFinal)).limit(1) : [];
        const esNcFinal = esNotaCredito(dto.tipoDoc ?? g.tipoDoc);
        conRenglones.items = await this.resolverFletes(conRenglones.items, pf?.traeMercaderia && !esNcFinal ? pf : null);
        Object.assign(patch, {
          neto: conRenglones.neto, iva: conRenglones.iva, otros: conRenglones.otros,
          impInternos: conRenglones.impInternos, percDgi: conRenglones.percDgi, percDgr: conRenglones.percDgr,
          total: conRenglones.total, descripcion: conRenglones.descripcion,
        });
        await this.db.delete(gastoItems).where(eq(gastoItems.gastoId, id));
        await this.db.insert(gastoItems).values(conRenglones.items.map((i) => ({ ...i, gastoId: id })));
      } else if (tocaImportes(dto)) {
        /*
         * Sin renglones se parchea campo a campo, y el pie se reconstruye
         * ENTERO: `otros` es la suma de los tres más lo no detallado, así que
         * mandar solo `percDgr` con el resto tomado de la fila guardada sería
         * sumar dos veces lo que ya estaba adentro. Lo no detallado se
         * despeja de la fila vieja.
         */
        // Lo guardado de una NC está en negativo: se lee en positivo, como el papel.
        const gp = conSigno(g, g.total < 0 ? -1 : 1);
        const sinDetallarGuardado = money(gp.otros - gp.impInternos - gp.percDgi - gp.percDgr);
        const t = this.totalesDe({
          neto: dto.neto ?? gp.neto,
          iva: dto.iva ?? gp.iva,
          otros: dto.otros ?? Math.max(0, sinDetallarGuardado),
          impInternos: dto.impInternos ?? gp.impInternos,
          percDgi: dto.percDgi ?? gp.percDgi,
          percDgr: dto.percDgr ?? gp.percDgr,
        } as GastoDto);
        if (t.total <= 0) throw new BadRequestException('El importe del gasto tiene que ser mayor a 0.');
        Object.assign(patch, t);
      }
      /* El signo de la NC (ver `esNotaCredito`): lo recalculado nace positivo;
       * si solo cambió el tipo, se da vuelta lo que ya estaba guardado. */
      const tipoFinal = patch.tipoDoc ?? g.tipoDoc;
      const signoFinal: 1 | -1 = esNotaCredito(tipoFinal) ? -1 : 1;
      if (patch.total != null) Object.assign(patch, conSigno(patch, signoFinal));
      else if (Math.sign(g.total) !== signoFinal) {
        for (const k of CAMPOS_IMPORTE) patch[k] = money(-(g as any)[k]);
      }
      if (esNotaCredito(tipoFinal) !== esNotaCredito(g.tipoDoc)) patch.estado = esNotaCredito(tipoFinal) ? 'pagado' : 'pendiente';
      await this.chequearDuplicado(
        patch.proveedorId !== undefined ? patch.proveedorId : g.proveedorId,
        patch.letra ?? g.letra,
        patch.numero ?? g.numero,
        id,
        patch.proveedorTexto ?? g.proveedorTexto,
      );
    } else if (
      tocaImportes(dto)
      || dto.numero != null || dto.proveedorId !== undefined || dto.items != null
    ) {
      throw new BadRequestException(
        'El gasto ya tiene pagos (o una nota de crédito aplicada): revertilos antes de cambiar importes, número o proveedor.',
      );
    }

    /* La conciliación (28/9/2026): lo que cambia el saldo del proveedor —importe,
     * tipo, proveedor o fecha— no se toca si el gasto (o su fecha nueva) cae
     * antes del día conciliado. Descripción, rubro u observaciones, sí. */
    const cambia = (k: string) => patch[k] !== undefined && (k === 'fecha'
      ? new Date(patch.fecha).getTime() !== new Date(g.fecha).getTime()
      : Math.abs(Number(patch[k] ?? 0) - Number((g as any)[k] ?? 0)) > 0.009 || (typeof patch[k] === 'string' && patch[k] !== (g as any)[k]));
    const cambiaFecha = cambia('fecha');
    const cambiaProv = patch.proveedorId !== undefined && (patch.proveedorId ?? null) !== (g.proveedorId ?? null);
    if (cambiaFecha || cambiaProv || cambia('total') || (patch.tipoDoc !== undefined && patch.tipoDoc !== g.tipoDoc)) {
      await exigirFueraDeConciliado(this.db, g.proveedorId, g.fecha, 'modificar un gasto');
      if (cambiaFecha || cambiaProv) {
        await exigirFueraDeConciliado(
          this.db, cambiaProv ? patch.proveedorId : g.proveedorId, cambiaFecha ? patch.fecha : g.fecha, 'modificar un gasto',
        );
      }
    }
    if (patch.fecha !== undefined || patch.vencimiento !== undefined) {
      if (patch.fecha) exigirFechasGasto(patch.fecha, null);
      const f = patch.fecha ?? g.fecha;
      const v = patch.vencimiento !== undefined ? patch.vencimiento : g.vencimiento;
      if (v && f && new Date(v).getTime() < new Date(new Date(f).setHours(0, 0, 0, 0)).getTime()) {
        throw new BadRequestException('El vencimiento no puede ser anterior a la fecha del gasto.');
      }
    }
    /* La NC y su gasto (0115): contra cuál descuenta se puede cambiar o quitar;
     * si deja de ser NC, pierde la referencia. Se valida con lo que queda. */
    const tipoFin = patch.tipoDoc ?? g.tipoDoc;
    let refFin: number | null = dto.refGastoId !== undefined ? (dto.refGastoId ?? null) : (g.refGastoId ?? null);
    if (!esNotaCredito(tipoFin)) {
      if (dto.refGastoId) throw new BadRequestException('Solo una nota de crédito descuenta de otro gasto.');
      refFin = null;
    }
    const totalFin = patch.total ?? g.total;
    const provFin = patch.proveedorId !== undefined ? patch.proveedorId : g.proveedorId;
    if (refFin && (refFin !== g.refGastoId || totalFin !== g.total || provFin !== g.proveedorId)) {
      await this.validarRefNc(
        refFin, money(-totalFin), provFin ?? null, patch.proveedorTexto ?? g.proveedorTexto,
        refFin === g.refGastoId ? money(-g.total) : 0,
      );
    }
    if (refFin !== (g.refGastoId ?? null)) patch.refGastoId = refFin;
    /* El mes al que corresponde (0152): imputación como el negocio, se corrige
     * aunque haya pagos. Si cambia la fecha y no viene, se revalida el que tenía. */
    if (dto.periodo !== undefined || (patch.fecha && g.periodo)) {
      const pedido = dto.periodo !== undefined ? dto.periodo : String(g.periodo).slice(0, 7);
      patch.periodo = periodoDe(pedido, patch.fecha ?? g.fecha);
    }

    /*
     * LA CUENTA CON COFFIT (0120). Si el gasto es (o pasa a ser) de Coffit y
     * cambia lo que le suma a su cuenta —negocio, importes o fecha—:
     *   · si ya está en un mes cerrado, no se toca: el cierre lo contó. Se
     *     anula y se carga de nuevo (la anulación deja el ajuste sola);
     *   · si la fecha nueva cae en un mes cerrado, entra a la cuenta hoy;
     *   · el cambio de negocio queda en la auditoría: quién y cuándo.
     */
    const negocioFin = patch.negocio ?? g.negocio;
    if (g.negocio === 'cafeteria' || negocioFin === 'cafeteria') {
      const antes = g.negocio === 'cafeteria' ? paraCuentaCoffit(g) : 0;
      const despues = negocioFin === 'cafeteria' ? paraCuentaCoffit({ ...g, ...patch }) : 0;
      const tocaCuenta = Math.abs(antes - despues) > 0.004 || (cambiaFecha && negocioFin === 'cafeteria');
      if (tocaCuenta && g.negocio === 'cafeteria' && await fechaDeCuenta(this.db, g.cuentaFecha ?? g.fecha)) {
        throw new BadRequestException(
          'Este gasto de Coffit ya está en un mes cerrado de su cuenta: no se cambia por atrás. '
          + 'Anulalo y cargalo de nuevo (la anulación deja el ajuste en la cuenta), o cargá un ajuste.',
        );
      }
      if (negocioFin === 'cafeteria' && (tocaCuenta || g.negocio !== 'cafeteria')) {
        patch.cuentaFecha = await fechaDeCuenta(this.db, patch.fecha ? new Date(patch.fecha) : g.fecha);
      }
    }
    if (Object.keys(patch).length) await this.db.update(gastos).set(patch).where(eq(gastos.id, id));
    if (negocioFin !== g.negocio) {
      const nombre = (n: string) => (n === 'cafeteria' ? 'Coffit' : 'Sabor y Aroma');
      await this.db.insert(auditoria).values({
        usuarioId: sesion?.usuarioId ?? null, entidad: 'gasto', entidadId: id, ambito: 'Negocio',
        detalle: `Gasto #${id}`, campo: 'Negocio', antes: nombre(g.negocio), despues: nombre(negocioFin),
      });
    }
    await this.pagos.recalcularGastoAhora(g.refGastoId);
    if (refFin !== g.refGastoId) await this.pagos.recalcularGastoAhora(refFin);
    return this.get(id);
  }

  async anular(id: number, motivo?: string, opts?: OpcionesCashflow & { usuarioId?: number | null }) {
    const [g] = await this.db.select().from(gastos).where(eq(gastos.id, id)).limit(1);
    if (!g) throw new NotFoundException('Gasto inexistente.');
    if (g.estado === 'anulado') throw new BadRequestException('Ya está anulado.');
    /* Cargado desde la caja del dueño: se anula desde el Cash Flow (auditoría 5/10). */
    await exigirFueraDeCashflow(this.db, { gastoId: id }, 'Este gasto', opts);
    await exigirFueraDeConciliado(this.db, g.proveedorId, g.fecha, 'anular un gasto');
    if (g.pagado > 0.009) {
      const [nc] = await this.db.select({ id: gastos.id }).from(gastos).where(and(
        eq(gastos.refGastoId, id), eq(gastos.tipoDoc, 'nota_credito'), ne(gastos.estado, 'anulado'),
      )).limit(1);
      throw new BadRequestException(nc
        ? `Tiene aplicada la nota de crédito #${nc.id}: anulala o sacale la referencia primero.`
        : 'Tiene pagos registrados: revertilos primero — la plata que salió tiene que quedar rastreable.');
    }
    const nota = (motivo ?? '').trim().slice(0, 300);
    await this.db.transaction(async (tx) => {
      await tx.update(gastos).set({
        estado: 'anulado',
        observaciones: nota ? `${g.observaciones ? `${g.observaciones}\n` : ''}Anulado: ${nota}` : g.observaciones,
      }).where(eq(gastos.id, id));
      /* El gasto no guarda quién lo anuló: queda en la auditoría (Gerencia › Auditoría, 0144). */
      await tx.insert(auditoria).values({
        usuarioId: opts?.usuarioId ?? null, entidad: 'gasto', entidadId: id, ambito: 'Anulación',
        detalle: `#${id}${g.numero ? ` ${g.numero}` : ''}${g.proveedorTexto ? ` · ${g.proveedorTexto}` : ''}${g.descripcion ? ` · ${g.descripcion}` : ''}`.slice(0, 200),
        campo: 'Gasto anulado', antes: `$${Number(g.total).toLocaleString('es-AR')}`, despues: nota,
      });
      /* De Coffit y en un mes cerrado de su cuenta: el ajuste contrario (0120). */
      if (g.negocio === 'cafeteria') {
        const fechaCuenta = g.cuentaFecha ?? g.fecha;
        await ajustePorAnulacion(tx, {
          fechaCuenta, efecto: await importeEnCuenta(tx, fechaCuenta, paraCuentaSinIva(g), paraCuentaCoffit(g)),
          documento: `el gasto #${id}${g.numero ? ` (${g.numero})` : ''}`,
        });
      }
    });
    // Una NC anulada deja de descontar: su gasto recupera el saldo (0115).
    await this.pagos.recalcularGastoAhora(g.refGastoId);
    return this.get(id);
  }

  /* ------------- Pagos (delegados en Pagos a proveedores) ------------- */

  /**
   * Pagar este gasto. Crea un PAGO AL PROVEEDOR y lo imputa en el mismo acto:
   * el gasto no tiene pagos propios, tiene imputaciones de pagos que son del
   * proveedor. Ese giro es lo que habilita el circuito inverso — que la cajera
   * pague cuando llega la mercadería, sin que el documento exista todavía.
   */
  async pagar(id: number, dto: PagoDto, sesion: Sesion) {
    const [g] = await this.db.select().from(gastos).where(eq(gastos.id, id)).limit(1);
    if (!g) throw new NotFoundException('Gasto inexistente.');
    if (g.estado === 'anulado') throw new BadRequestException('El gasto está anulado.');
    if (esNotaCredito(g.tipoDoc) || g.total < 0) {
      throw new BadRequestException('Una nota de crédito no se paga: descuenta lo que se le debe al proveedor.');
    }
    exigirFechaPago(dto.fecha);
    this.exigirPagoPropio(sesion, g.sucursalId, dto);
    const importe = money(dto.importe);
    await this.pagos.crear({
      destino: 'gastos',
      proveedorId: g.proveedorId ?? undefined,
      importe,
      medio: dto.medio,
      fecha: dto.fecha,
      referencia: dto.referencia,
      cambioPor: dto.cambioPor,
      cuentaPropiaId: dto.cuentaPropiaId,
      cuentaAMano: dto.cuentaAMano,
      concepto: g.descripcion || `Gasto #${g.id}`,
      sucursalId: g.sucursalId ?? undefined,
      cajaSesionId: dto.cajaSesionId,
      usuarioId: dto.usuarioId,
      imputaciones: [{ gastoId: g.id, importe }],
      confirmarDuplicado: dto.confirmarDuplicado === true,
    }, sesion.sucursalId, esJefe(sesion), false, { controlarDuplicado: true });
    return this.get(id);
  }

  /**
   * QUIÉN PUEDE PAGAR ESTE GASTO (27/9/2026). Administración, cualquiera. El
   * resto (el mostrador, que entra con `ventas.caja`) solo un gasto de SU
   * sucursal y en EFECTIVO de su turno: antes la cajera daba por pagado "por
   * transferencia" el alquiler de otra sucursal, que ni siquiera puede ver, y
   * el gasto desaparecía de Cuentas a pagar sin que saliera un peso.
   */
  private exigirPagoPropio(sesion: Sesion, sucursalGasto: number | null, dto: PagoDto) {
    if (esAdminPagos(sesion)) return;
    if (sucursalGasto == null || sucursalGasto !== sesion.sucursalId) {
      throw new ForbiddenException('Ese gasto no es de tu sucursal: lo paga administración.');
    }
    if ((dto.medio ?? 'efectivo') !== 'efectivo' || !dto.cajaSesionId) {
      throw new ForbiddenException(
        'Desde la sucursal solo se paga en EFECTIVO de tu turno abierto. Las transferencias las registra administración.',
      );
    }
  }

  /**
   * Aplicar a este gasto un pago que YA existe — el que la cajera registró
   * antes de que el comprobante estuviera cargado. No mueve plata: la imputa.
   */
  async aplicarPago(id: number, dto: AplicarPagoDto, sesion: Sesion) {
    await this.pagos.imputar(dto.pagoId, {
      imputaciones: [{ gastoId: id, importe: money(dto.importe) }],
      usuarioId: dto.usuarioId,
    }, esJefe(sesion));
    return this.get(id);
  }

  /* ---------------- Adjuntos (foto del comprobante) ---------------- */

  /**
   * EL MIME SALE DE LOS BYTES, no de lo que dijo el cliente.
   *
   * Este adjunto se sirve de vuelta desde `/api/...`, o sea desde EL MISMO
   * ORIGEN donde el dashboard guarda el token de sesión. Guardar el mime
   * declarado y devolverlo tal cual convertía este endpoint en alojamiento de
   * contenido arbitrario: `data:text/html;base64,<script>…</script>`, se le pasa
   * el link al administrador ("mirá el comprobante"), y el script lee la sesión
   * del `localStorage` y se la manda a otro lado. Con `image/svg+xml` es igual.
   *
   * `common/archivos.ts` ya tenía la tabla de firmas para los otros dos lugares
   * que reciben binarios (Compras y Web); este era el tercero y quedó afuera.
   */
  async subirAdjunto(gastoId: number, dto: AdjuntoDto) {
    const [g] = await this.db.select({ id: gastos.id }).from(gastos).where(eq(gastos.id, gastoId)).limit(1);
    if (!g) throw new NotFoundException('Gasto inexistente.');
    const m = /^data:([^;]+);base64,(.+)$/.exec(String(dto?.data ?? ''));
    if (!m) throw new BadRequestException('El comprobante tiene que llegar como data URL en base64.');

    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > MAX_BYTES_ADJUNTO) {
      const mb = (n: number) => (n / 1024 / 1024).toFixed(1).replace('.', ',');
      throw new BadRequestException(`El archivo pesa ${mb(buf.length)} MB y el máximo es ${mb(MAX_BYTES_ADJUNTO)} MB.`);
    }
    const real = mimeReal(buf);
    if (!real) {
      throw new BadRequestException('Ese archivo no es una foto JPG/PNG/WebP ni un PDF: no se pudo reconocer el contenido.');
    }
    if (real !== m[1]) {
      throw new BadRequestException(`El archivo dice ser ${m[1]} pero su contenido es ${real}.`);
    }

    const [a] = await this.db.insert(gastoAdjuntos).values({
      gastoId,
      nombre: nombreSeguro(String(dto?.nombre ?? ''), 'comprobante'),
      mime: real,
      // Se re-arma el base64 desde los bytes ya validados: lo que se guarda es
      // exactamente lo que se midió, sin los caracteres que el decodificador
      // ignora al leer pero que quedarían en la fila.
      data: buf.toString('base64'),
    }).returning({ id: gastoAdjuntos.id, nombre: gastoAdjuntos.nombre, mime: gastoAdjuntos.mime });
    return a;
  }

  async verAdjunto(id: number, res: Response) {
    const [a] = await this.db.select().from(gastoAdjuntos).where(eq(gastoAdjuntos.id, id)).limit(1);
    if (!a) throw new NotFoundException('Adjunto inexistente.');
    res.setHeader('Content-Type', a.mime);
    // `nosniff` cierra la otra mitad: sin él el navegador puede decidir que el
    // archivo "en realidad" es otra cosa, y el mime verificado al subir deja de
    // servir. `inline` con nombre saneado porque se mira al lado del gasto.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `inline; filename="${nombreSeguro(a.nombre, 'comprobante')}"`);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.end(Buffer.from(a.data, 'base64'));
  }

  /**
   * El adjunto es la PRUEBA de que ese egreso existió. Una vez que hay plata
   * pagada contra el gasto, la foto del comprobante deja de ser un archivo
   * suelto y pasa a ser el respaldo de esa salida: es la misma regla que ya
   * cumplen `anular` (no anula con pagos) y `editar` (no toca importes con
   * pagos). Antes esto era un `delete` pelado que ni siquiera miraba si el
   * adjunto existía.
   */
  async borrarAdjunto(id: number) {
    const [a] = await this.db.select({ id: gastoAdjuntos.id, gastoId: gastoAdjuntos.gastoId })
      .from(gastoAdjuntos).where(eq(gastoAdjuntos.id, id)).limit(1);
    if (!a) throw new NotFoundException('Adjunto inexistente.');
    const [g] = await this.db.select({ pagado: gastos.pagado })
      .from(gastos).where(eq(gastos.id, a.gastoId)).limit(1);
    if (Number(g?.pagado) > 0.009) {
      throw new BadRequestException(
        'El gasto ya tiene pagos registrados: el comprobante es el respaldo de esa salida y no se borra. '
        + 'Revertí el pago primero.',
      );
    }
    await this.db.delete(gastoAdjuntos).where(eq(gastoAdjuntos.id, id));
    return { ok: true };
  }

  /* ---------------- Gastos fijos (recurrentes) ---------------- */

  listRecurrentes() {
    return this.db.select().from(gastosRecurrentes).orderBy(asc(gastosRecurrentes.nombre));
  }

  /**
   * LO QUE APUNTA UN GASTO FIJO TIENE QUE EXISTIR (27/9/2026). Editar a un
   * rubro inexistente daba "Internal server error"; y un fijo sin importe
   * generaba gastos de $0 que no aparecían en ningún lado pero dejaban el mes
   * como "ya generado".
   */
  /* `sucursalActual`: la que ya tiene el gasto fijo. Editar uno de un local que cerró (0143) —por ejemplo,
   * para darlo de baja— no se traba: solo no se puede ELEGIR un local desactivado. */
  private async validarRecurrente(dto: RecurrenteDto, alta: boolean, sucursalActual: number | null = null) {
    if (dto.categoriaId != null || alta) {
      const [c] = await this.db.select().from(gastoCategorias).where(eq(gastoCategorias.id, Number(dto.categoriaId))).limit(1);
      if (!c) throw new BadRequestException('Elegí el rubro del gasto fijo.');
      if (!c.activa) throw new BadRequestException(`El rubro "${c.nombre}" está dado de baja: elegí otro.`);
    }
    if (dto.proveedorId) {
      const [p] = await this.db.select({ id: proveedores.id }).from(proveedores).where(eq(proveedores.id, dto.proveedorId)).limit(1);
      if (!p) throw new BadRequestException('Proveedor inválido.');
    }
    if (dto.sucursalId) {
      const [x] = await this.db.select({ id: sucursales.id, nombre: sucursales.nombre, activa: sucursales.activa }).from(sucursales).where(eq(sucursales.id, dto.sucursalId)).limit(1);
      if (!x) throw new BadRequestException('Sucursal inválida.');
      if (!x.activa && x.id !== sucursalActual) throw new BadRequestException(`${x.nombre} está desactivada: el local cerró.`);
    }
    if ((alta || dto.importeEstimado != null) && !(Number(dto.importeEstimado) > 0)) {
      throw new BadRequestException('Poné el importe estimado: sin él se generan gastos de $0 que no aparecen en ningún lado.');
    }
  }

  async crearRecurrente(dto: RecurrenteDto) {
    const nombre = (dto.nombre ?? '').trim();
    if (!nombre) throw new BadRequestException('Poné un nombre (ej.: "Alquiler del local").');
    await this.validarRecurrente(dto, true);
    const [c] = await this.db.select().from(gastoCategorias).where(eq(gastoCategorias.id, Number(dto.categoriaId))).limit(1);
    if (!c) throw new BadRequestException('Elegí el rubro del gasto fijo.');
    const reparto = await exigirReparto(this.db, dto.reparto);
    const [r] = await this.db.insert(gastosRecurrentes).values({
      nombre,
      categoriaId: c.id,
      proveedorId: dto.proveedorId ?? null,
      sucursalId: reparto ? null : dto.sucursalId ?? null,
      reparto,
      desde: dto.desde ? `${dto.desde}-01` : mesActual(),
      hasta: dto.activo === false ? hastaAlDarDeBaja(dto.desde ? `${dto.desde}-01` : mesActual()) : null,
      importeEstimado: money(dto.importeEstimado ?? 0),
      frecuencia: (dto.frecuencia ?? 'mensual') as any,
      diaVencimiento: Math.min(Math.max(Number(dto.diaVencimiento) || 10, 1), 31),
      activo: dto.activo !== false,
      observaciones: (dto.observaciones ?? '').trim(),
    }).returning();
    return r;
  }

  async editarRecurrente(id: number, dto: RecurrenteDto) {
    const [r] = await this.db.select().from(gastosRecurrentes).where(eq(gastosRecurrentes.id, id)).limit(1);
    if (!r) throw new NotFoundException('Gasto fijo inexistente.');
    await this.validarRecurrente(dto, false, r.sucursalId ?? null);
    const patch: any = {};
    if (dto.nombre != null) {
      const n = String(dto.nombre).trim();
      if (!n) throw new BadRequestException('El nombre no puede quedar vacío.');
      patch.nombre = n;
    }
    if (dto.categoriaId != null) patch.categoriaId = Number(dto.categoriaId);
    if (dto.proveedorId !== undefined) patch.proveedorId = dto.proveedorId ?? null;
    if (dto.sucursalId !== undefined) patch.sucursalId = dto.sucursalId ?? null;
    if (dto.reparto !== undefined) {
      patch.reparto = await exigirReparto(this.db, dto.reparto, r.reparto ?? null);
      if (patch.reparto) patch.sucursalId = null;
    } else if (patch.sucursalId != null) patch.reparto = null;
    if (dto.importeEstimado != null) patch.importeEstimado = money(dto.importeEstimado);
    if (dto.frecuencia != null) patch.frecuencia = dto.frecuencia;
    if (dto.diaVencimiento != null) patch.diaVencimiento = Math.min(Math.max(Number(dto.diaVencimiento) || 10, 1), 31);
    if (dto.activo != null) {
      patch.activo = !!dto.activo;
      /* Dar de baja la corta desde este mes (ver `hastaAlDarDeBaja`); reactivarla la reabre. */
      if (!dto.activo && r.activo) patch.hasta = hastaAlDarDeBaja(dto.desde ? `${dto.desde}-01` : r.desde);
      if (dto.activo) patch.hasta = null;
    }
    if (dto.desde) patch.desde = `${dto.desde}-01`;
    const hasta = patch.hasta !== undefined ? patch.hasta : r.hasta;
    if (hasta && correrMes(patch.desde ?? r.desde, -1) > hasta) {
      throw new BadRequestException('«Desde» no puede ser posterior al último mes en que corrió (está dado de baja).');
    }
    if (dto.observaciones != null) patch.observaciones = String(dto.observaciones).trim();
    if (Object.keys(patch).length) await this.db.update(gastosRecurrentes).set(patch).where(eq(gastosRecurrentes.id, id));
    return { ok: true };
  }

  async borrarRecurrente(id: number) {
    const [r] = await this.db.select().from(gastosRecurrentes).where(eq(gastosRecurrentes.id, id)).limit(1);
    if (!r) throw new NotFoundException('Gasto fijo inexistente.');
    // Los gastos ya generados quedan: `recurrente_id` no tiene FK justamente
    // para que borrar la plantilla no borre la historia.
    await this.db.delete(gastosRecurrentes).where(eq(gastosRecurrentes.id, id));
    return { ok: true };
  }

  /**
   * Qué gastos fijos faltan emitir en un período ('YYYY-MM'), y cuáles ya
   * están. La idempotencia se comprueba contra los GASTOS realmente emitidos
   * por cada plantilla, no contra un flag: así reintentar nunca duplica, y si
   * alguien borra el gasto generado, la plantilla vuelve a ofrecerse.
   */
  previsualizarPeriodo(periodo: string) {
    return this.calcularPeriodo(this.db, periodo, false);
  }

  /**
   * `conCandado` es lo que separa mirar de generar. La idempotencia se apoya en
   * "leo qué falta, después inserto", y esas dos mitades corrían en momentos
   * distintos: dos administradores apretando "Generar agosto" en el mismo
   * segundo leían los dos la misma lista de pendientes y los dos insertaban —
   * dos alquileres, dos internets, dos seguros del mismo mes en Cuentas a
   * Pagar, y el que no lo nota paga dos veces.
   *
   * Con el candado sobre las PLANTILLAS, el segundo pedido espera; cuando entra,
   * su lectura de gastos emitidos ya ve los del primero y no genera nada. No
   * hace falta un único en la base: el cuello es la plantilla, no el gasto.
   */
  private async calcularPeriodo(ex: any, periodo: string, conCandado: boolean) {
    const inicio = this.inicioPeriodo(periodo);
    const consulta = ex.select().from(gastosRecurrentes)
      .where(eq(gastosRecurrentes.activo, true)).orderBy(asc(gastosRecurrentes.nombre));
    const plantillas = conCandado ? await consulta.for('update') : await consulta;
    if (!plantillas.length) return { periodo, inicio, pendientes: [], emitidos: [] };

    const emitidos = await ex.select().from(gastos).where(and(
      inArray(gastos.recurrenteId, plantillas.map((p: any) => p.id)),
      ne(gastos.estado, 'anulado'),
    ));

    const pendientes: any[] = [];
    const yaEstan: any[] = [];
    const mes = `${periodo}-01`;
    for (const p of plantillas) {
      /* Fuera de los meses en que corre (0216), ni se ofrece. */
      if (mes < p.desde || (p.hasta && mes > p.hasta)) continue;
      /*
       * DESDE CUÁNDO UNA EMISIÓN ANTERIOR TODAVÍA CUBRE ESTE PERÍODO. Mensual:
       * solo la de este mismo mes. Bimestral: también la del mes pasado. De ahí
       * el `meses - 1`.
       *
       * Se cuenta desde `inicio` (día 1) y no desde el fin del mes, y eso NO es
       * cosmético: `setMonth` no recorta, DESBORDA. Con el 31 de marzo, restar
       * un mes daba "31 de febrero" → 3 de marzo, o sea un límite POSTERIOR al
       * gasto recién generado (día 1). El gasto no se encontraba, la plantilla
       * volvía a ofrecerse y generar marzo dos veces creaba dos alquileres —
       * sin ninguna concurrencia de por medio, apretando el botón dos veces.
       * Desde el día 1 el desborde no existe: todos los meses tienen un día 1.
       */
      const meses = MESES_FRECUENCIA[p.frecuencia] ?? 1;
      const desde = new Date(inicio);
      desde.setMonth(desde.getMonth() - (meses - 1));
      /*
       * Y LA PUNTA DE ARRIBA, que faltaba: sin ella una emisión POSTERIOR
       * contaba como si cubriera este período. Generado septiembre, pedir julio
       * decía "ya está generado" y apuntaba al gasto de septiembre — o sea que
       * rellenar un mes viejo era imposible y el motivo no se veía por ningún
       * lado. El mes siguiente al período ya es otro período.
       */
      const hasta = new Date(inicio);
      hasta.setMonth(hasta.getMonth() + 1);
      const previo = emitidos.find((g: any) => {
        if (g.recurrenteId !== p.id) return false;
        const f = new Date(g.fecha);
        return f >= desde && f < hasta;
      });
      if (previo) yaEstan.push({ plantilla: p, gastoId: previo.id, fecha: previo.fecha });
      else pendientes.push({ plantilla: p, vencimiento: this.vencimientoDe(inicio, p.diaVencimiento) });
    }
    return { periodo, inicio, pendientes, emitidos: yaEstan };
  }

  async generarPeriodo(periodo: string, usuarioId?: number, soloIds?: number[]) {
    /* Hasta el mes que viene (27/9/2026): generar 2031 dejaba previsiones de
     * gastos fijos en un futuro que nadie mira, y el período ya "emitido". */
    const ini = this.inicioPeriodo(periodo);
    const hoy = new Date();
    const proximo = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 1);
    if (ini.getTime() > proximo.getTime()) {
      throw new BadRequestException('Los gastos fijos se generan hasta el mes que viene, no más adelante.');
    }
    const creados = await this.db.transaction(async (tx) => {
      // La previa va ADENTRO y con candado: ver `calcularPeriodo`.
      const previa = await this.calcularPeriodo(tx, periodo, true);
      const aGenerar = previa.pendientes.filter(
        (x: any) => (!soloIds?.length || soloIds.includes(x.plantilla.id)) && x.plantilla.importeEstimado > 0,
      );
      if (!aGenerar.length) return [];

      const filas = aGenerar.map((x: any) => ({
        fecha: previa.inicio,
        tipoDoc: 'factura' as const,
        letra: 'B' as const,
        numero: '',
        proveedorId: x.plantilla.proveedorId,
        categoriaId: x.plantilla.categoriaId,
        sucursalId: x.plantilla.reparto ? null : x.plantilla.sucursalId,
        /* Copiado (0216): cambiar la plantilla después no reescribe la historia. */
        reparto: x.plantilla.reparto ?? null,
        descripcion: `${x.plantilla.nombre} · ${periodo}`,
        condicionPago: 'cuenta_corriente' as const,
        vencimiento: x.vencimiento,
        // El importe es el ESTIMADO de la plantilla: queda como previsión hasta
        // que llegue la factura real y alguien la corrija.
        neto: money(x.plantilla.importeEstimado),
        iva: 0,
        otros: 0,
        total: money(x.plantilla.importeEstimado),
        estado: 'pendiente' as const,
        recurrenteId: x.plantilla.id,
        observaciones: 'Generado desde Gastos fijos. Corregí el importe cuando llegue el comprobante.',
        usuarioId: usuarioId ?? null,
      }));
      return tx.insert(gastos).values(filas).returning({ id: gastos.id });
    });
    return { creados: creados.length, periodo, gastos: creados.map((g) => g.id) };
  }

  /** 'YYYY-MM' → el primer instante de ese mes. */
  private inicioPeriodo(periodo: string) {
    const m = /^(\d{4})-(\d{2})$/.exec(String(periodo ?? '').trim());
    if (!m) throw new BadRequestException('El período se indica como AAAA-MM (por ejemplo 2026-08).');
    const anio = Number(m[1]);
    const mes = Number(m[2]);
    if (mes < 1 || mes > 12) throw new BadRequestException('Mes inválido.');
    return new Date(anio, mes - 1, 1, 0, 0, 0, 0);
  }

  /** Día de vencimiento dentro del mes, recortado al último día real (31 → 28/30). */
  private vencimientoDe(inicioMes: Date, dia: number) {
    const ultimo = new Date(inicioMes.getFullYear(), inicioMes.getMonth() + 1, 0).getDate();
    return new Date(inicioMes.getFullYear(), inicioMes.getMonth(), Math.min(dia, ultimo), 0, 0, 0, 0);
  }
}

/* ------------------------------- Controller ------------------------------- */

/**
 * El `@Permiso` de la clase es el PISO de lectura (ver `PISO_GASTOS`). Cada
 * método que escribe vuelve a declarar el suyo, y como el de método reemplaza
 * al de clase, cada uno lista todo lo que acepta — no hereda nada.
 */
@Controller('gastos')
@Permiso(...PISO_GASTOS)
export class GastosController {
  constructor(private readonly svc: GastosService) {}

  /* Las rutas fijas van ANTES de `:id`: Nest resuelve por orden de declaración. */
  @Get('bootstrap') bootstrap(@Auth() auth: Sesion) { return this.svc.bootstrap(auth); }
  @Get('pendientes') @Permiso('gastos.gastos', 'gastos.pagos') pendientes() {
    return this.svc.pendientes();
  }
  @Get('cuentas-a-pagar') @Permiso('gastos.pagos') cuentas(@Query() q: ConsultaGastosDto) {
    return this.svc.cuentasAPagar(q ?? {});
  }
  @Get('resumen') @Permiso('gastos.resumen') resumen(@Query() q: ConsultaGastosDto) {
    return this.svc.resumen(q ?? {});
  }
  /* Gastos › Proveedores (19/11/2026): lo gastado y lo que falta pagar por proveedor. */
  @Get('por-proveedor') @Permiso('gastos.proveedores') porProveedor(@Query() q: ConsultaGastosDto) {
    return this.svc.porProveedor(q ?? {});
  }

  // Leer el plan de rubros lo necesita cualquier pantalla del módulo (el
  // selector del formulario); ADMINISTRARLO es su propia sección.
  @Get('categorias') categorias() { return this.svc.listCategorias(); }
  /* Los que carga gastos: para sugerirle lo que ya escribió alguna vez. */
  @Get('conceptos') @Permiso('gastos.gastos') conceptos(@Query('proveedorId') proveedorId?: string) {
    return this.svc.conceptosUsados(Number(proveedorId) > 0 ? Number(proveedorId) : null);
  }
  @Post('categorias') @Permiso('gastos.categorias') crearCategoria(@Body() dto: CategoriaDto) {
    return this.svc.crearCategoria(dto);
  }
  @Patch('categorias/:id') @Permiso('gastos.categorias') editarCategoria(
    @Param('id', ParseIntPipe) id: number, @Body() dto: CategoriaDto,
  ) {
    return this.svc.editarCategoria(id, dto);
  }
  @Delete('categorias/:id') @Permiso('gastos.categorias') borrarCategoria(@Param('id', ParseIntPipe) id: number) {
    return this.svc.borrarCategoria(id);
  }

  @Get('recurrentes') @Permiso(PERMISO_RESULTADOS) recurrentes() { return this.svc.listRecurrentes(); }
  @Post('recurrentes') @Permiso(PERMISO_RESULTADOS) crearRecurrente(@Body() dto: RecurrenteDto) {
    return this.svc.crearRecurrente(dto);
  }
  @Patch('recurrentes/:id') @Permiso(PERMISO_RESULTADOS) editarRecurrente(
    @Param('id', ParseIntPipe) id: number, @Body() dto: RecurrenteDto,
  ) {
    return this.svc.editarRecurrente(id, dto);
  }
  @Delete('recurrentes/:id') @Permiso(PERMISO_RESULTADOS) borrarRecurrente(@Param('id', ParseIntPipe) id: number) {
    return this.svc.borrarRecurrente(id);
  }
  @Get('recurrentes/periodo/:periodo') @Permiso(PERMISO_RESULTADOS) previa(@Param('periodo') periodo: string) {
    return this.svc.previsualizarPeriodo(periodo);
  }
  @Post('recurrentes/generar') @Permiso(PERMISO_RESULTADOS) generar(@Body() dto: GenerarPeriodoDto) {
    return this.svc.generarPeriodo(dto.periodo, dto.usuarioId, dto.ids);
  }

  @Get('adjuntos/:id') @Permiso(...PERMISOS_VER) adjunto(
    @Param('id', ParseIntPipe) id: number, @Res() res: Response,
  ) {
    return this.svc.verAdjunto(id, res);
  }
  @Delete('adjuntos/:id') @Permiso('gastos.gastos') borrarAdjunto(@Param('id', ParseIntPipe) id: number) {
    return this.svc.borrarAdjunto(id);
  }

  /* Los fletes de mercadería (0244). */
  @Get('fletes') @Permiso('gastos.resumen', 'gastos.proveedores') fletes(@Query() q: ConsultaGastosDto) {
    return this.svc.reporteFletes(q ?? {});
  }
  @Get('fletes/papeles/:proveedorId') @Permiso('gastos.gastos') papelesParaFlete(@Param('proveedorId', ParseIntPipe) id: number) {
    return this.svc.papelesParaFlete(id);
  }
  @Put('fletes') @Permiso('gastos.gastos') asignarFletes(@Body() dto: AsignarFletesDto) { return this.svc.asignarFletes(dto); }

  @Get() @Permiso(...PERMISOS_VER) list(@Query() q: ConsultaGastosDto) { return this.svc.list(q ?? {}); }
  /*
   * La SESIÓN entera y no solo su sucursal: acá se decide a qué sucursal se
   * imputa el gasto (jefe elige, el resto graba en la suya) y, si viene con
   * "lo pagué y lo cargo" tildado, si esta persona puede además sacar plata
   * del cajón. Las dos cosas se resuelven adentro, con la sesión a mano.
   */
  @Post() @Permiso('gastos.gastos') crear(@Body() dto: GastoDto, @Auth() auth: Sesion) {
    return this.svc.crear(dto, auth);
  }

  @Get(':id') @Permiso(...PERMISOS_VER) get(@Param('id', ParseIntPipe) id: number) { return this.svc.get(id); }
  @Patch(':id') @Permiso('gastos.gastos') editar(
    @Param('id', ParseIntPipe) id: number, @Body() dto: GastoDto, @Auth() auth: Sesion,
  ) {
    return this.svc.editar(id, dto, auth);
  }
  @Post(':id/anular') @Permiso('gastos_anular') anular(
    @Param('id', ParseIntPipe) id: number, @Body() dto: AnularGastoDto, @Auth() sesion: Sesion,
  ) {
    return this.svc.anular(id, dto?.motivo, { usuarioId: sesion?.usuarioId });
  }
  /** Sale plata del cajón: mismas claves que `PagosProveedorController`. */
  @Post(':id/pagos') @Permiso(...PERMISOS_PAGO) pagar(
    @Param('id', ParseIntPipe) id: number, @Body() dto: PagoDto, @Auth() auth: Sesion,
  ) {
    return this.svc.pagar(id, dto, auth);
  }
  /** Usar un pago a cuenta que ya existe. Quitarlo se hace desde Pagos. */
  @Post(':id/aplicar-pago') @Permiso(...PERMISOS_IMPUTAR) aplicarPago(
    @Param('id', ParseIntPipe) id: number, @Body() dto: AplicarPagoDto, @Auth() auth: Sesion,
  ) {
    return this.svc.aplicarPago(id, dto, auth);
  }
  @Post(':id/adjuntos') @Permiso('gastos.gastos') subir(
    @Param('id', ParseIntPipe) id: number, @Body() dto: AdjuntoDto,
  ) {
    return this.svc.subirAdjunto(id, dto);
  }
}

@Module({
  imports: [PagosModule],
  controllers: [GastosController],
  providers: [GastosService],
  exports: [GastosService],
})
export class GastosModule {}
