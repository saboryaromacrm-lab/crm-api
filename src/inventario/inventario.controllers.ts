/**
 * LOS CONTROLLERS DEL ALMACÉN — permisos, sucursal y validación
 * ============================================================================
 * Hasta acá estos 26 endpoints eran la puerta más abierta del sistema: **cero
 * `@Permiso`, cero `@Auth()` y `@Body() any` en los ocho POST**. El catálogo de
 * permisos que los describe existe desde siempre (`usuarios.module.ts`) y lo
 * miraba **únicamente el navegador**: el rol Cafetería —que ve una sola
 * pantalla— copiaba su token y con un POST daba de baja 300 kg como merma, o
 * los inventaba.
 *
 * Tres reglas, y las tres estaban escritas en otro lado:
 *
 *  1. LA LLAVE. Sección (`almacen.*`) para mirar, acción para operar. Cuando la
 *     acción es más fuerte que la pantalla —dar de baja mercadería, fraccionar,
 *     preparar un pedido— va sola en el método: las claves de un mismo
 *     `@Permiso` se evalúan con O, así que ponerla al lado de la sección sería
 *     lo mismo que no ponerla.
 *
 *  2. LA SUCURSAL sale de la sesión. `sucursalDeOperacion` para lo que se
 *     GRABA, `soloSuSucursal` para lo que se TOCA. Esto no era un ataque de
 *     consola: el desplegable del panel listaba todas las sucursales sin mirar
 *     el rol, así que el repositor de Fontana elegía "Express 2" y le bajaba el
 *     stock a un local donde no pisa.
 *
 *  3. LOS NÚMEROS. `@Body() any` deja pasar `cantidad: 1e999`, que es
 *     `Infinity`, que es `> 0` y por lo tanto pasa el guard del servicio. La
 *     fila de stock queda en `Infinity` PARA SIEMPRE —`Infinity − 300` sigue
 *     siendo `Infinity`— y solo se arregla con un UPDATE a mano.
 *
 * LAS TRANSFERENCIAS tienen su propia regla, decidida por el dueño (13/8): cada
 * sucursal PREPARA lo que sale de ella (`origenId`) y PIDE y RECIBE lo que
 * llega a ella (`destinoId`). El único pedido que prepara alguien que no es su
 * dueño es el de la Cafetería, y ese va por otro circuito (`cafeteria/`).
 */
import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Param,
  ParseIntPipe, Patch, Post, Put, Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString,
  Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { Auth, Permiso, Sesion } from '../auth/auth.decoradores';
import { soloSuSucursal, sucursalDeOperacion } from '../auth/auth.guard';
import { InventarioService } from './inventario.service';

/*
 * TOPES. Cien mil unidades es más de lo que entra en cualquier depósito de este
 * negocio, y ese es el punto: lo que hay que impedir no es la carga grande sino
 * la imposible. `@Max` además rechaza `Infinity` (class-validator lo compara), y
 * `@IsNumber()` por sí solo ya rechaza `NaN` — que es lo que dejaba 200 kg
 * varados en `en_transito` sin salida cuando llegaba `cantidadRecibida: "x"`.
 */
const MAX_CANT = 100_000;
const MAX_ITEMS = 300;

/**
 * QUÉ MOVIMIENTOS SE PUEDEN CARGAR A MANO.
 *
 * `TIPOS_MOV` del servicio tiene once y el endpoint los aceptaba todos, pero
 * seis de ellos son la firma de un documento: `compra` la pone la factura,
 * `venta_granel` y `venta_fraccionada` el ticket, `transferencia` el remito,
 * `fraccionamiento` su propia operación y `envio_cafeteria` el envío. Cargarlos
 * a mano es inventar un documento que no existe — con `venta_granel` se
 * descuenta stock sin ticket ni caja, que es la forma prolija de tapar un
 * faltante, y el arqueo no lo ve nunca.
 *
 * Quedan los cinco que SON del almacén: los que corrigen la realidad contra el
 * papel, y que por eso mismo cada uno pide su propia llave.
 */
const TIPOS_MANUALES = ['devolucion', 'ajuste', 'merma', 'vencido', 'defectuoso'] as const;

/** Las bajas por pérdida tienen llave propia; el resto va con `inventario`. */
const LLAVE_DE_TIPO: Record<string, string> = {
  merma: 'merma',
  vencido: 'merma',
  defectuoso: 'defectuoso',
};

/*
 * SIN CompraDto: el ingreso de mercadería a mano se cerró el 18/8/2026 (pedido
 * del dueño). La mercadería entra por la FACTURA de Compras, que es la que trae
 * el costo, el proveedor y la deuda; el motor (`inv.opCompra`) sigue existiendo
 * porque lo usan la factura y los seeds, pero ya no hay puerta HTTP propia.
 */

class VentaDto {
  @IsInt() productoId!: number;
  @IsOptional() @IsInt() sucursalId?: number;
  @IsOptional() @IsInt() presId?: number | null;
  @IsNumber() @Min(0.001) @Max(MAX_CANT) cantidad!: number;
}

class AsignacionDto {
  @IsInt() presId!: number;
  @IsNumber() @Min(0) @Max(MAX_CANT) cant!: number;
}

class FraccionarDto {
  @IsInt() productoId!: number;
  @IsOptional() @IsInt() sucursalId?: number;
  @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => AsignacionDto)
  asignaciones!: AsignacionDto[];
}

class CorregirFraccionadoDto {
  @IsInt() productoId!: number;
  @IsOptional() @IsInt() sucursalId?: number;
  @IsInt() presId!: number;
  /*
   * CUÁNTOS PAQUETES HAY DE VERDAD, no la diferencia contra lo cargado.
   *
   * El DTO decía `diferencia` y el servicio lee `cantidadReal` — el modal manda
   * `cantidadReal`. Con `whitelist: true` el pipe borra lo que el DTO no
   * declara, así que al servicio le llegaba `undefined`, `Math.round(Number(
   * undefined))` daba NaN y la pantalla contestaba "La cantidad real no puede
   * ser negativa" hiciera lo que hiciera: la corrección de fraccionado no se
   * podía usar. El nombre lo manda el servicio, que es el que decide la cuenta.
   */
  @IsNumber() @Min(0) @Max(MAX_CANT) cantidadReal!: number;
  @IsOptional() @IsString() @MaxLength(300) motivo?: string;
}

class MovimientoDto {
  @IsInt() productoId!: number;
  @IsOptional() @IsInt() sucursalId?: number;
  @IsOptional() @IsInt() presId?: number | null;
  @IsIn(TIPOS_MANUALES as unknown as string[]) tipo!: string;
  @IsNumber() @Min(0.001) @Max(MAX_CANT) cantidad!: number;
  /** Solo lo miran los tipos de dirección 0 (`ajuste`): +1 suma, cualquier otro resta. */
  @IsOptional() @IsInt() signo?: number;
  @IsOptional() @IsString() @MaxLength(300) motivo?: string;
}

/* Los `usuarioId` de los DTOs de este archivo se fueron el 25/8/2026: el autor
 * de cada operación sale de la SESIÓN (como en Ventas y Cobranzas), no de lo
 * que mande el cliente — una traza que elige el cliente no prueba nada. Los
 * frontends viejos que todavía lo manden no rompen: `whitelist` lo descarta. */
class AbrirBorradorDto {
  @IsInt() origenId!: number;
  @IsOptional() @IsInt() destinoId?: number;
}

class ItemBorradorDto {
  @IsInt() productoId!: number;
  @IsOptional() @IsInt() presId?: number | null;
  @IsNumber() @Min(0) @Max(MAX_CANT) cantidad!: number;
}

class GuardarBorradorDto {
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_ITEMS) @ValidateNested({ each: true }) @Type(() => ItemBorradorDto)
  items?: ItemBorradorDto[];
  @IsOptional() @IsString() @MaxLength(500) observaciones?: string;
}

class AvanzarDto {
  @IsOptional() @IsString() desde?: string;
}

class EditarItemDto {
  @IsOptional() @IsNumber() @Min(0) @Max(MAX_CANT) cantidadPreparada?: number;
  @IsOptional() @IsString() @MaxLength(300) motivo?: string;
}

class AgregarItemDto {
  @IsInt() productoId!: number;
  @IsOptional() @IsInt() presId?: number | null;
  @IsNumber() @Min(0.001) @Max(MAX_CANT) cantidad!: number;
  @IsOptional() @IsString() @MaxLength(300) motivo?: string;
}

class ConfirmarListaDto {
  @IsIn(['enteros', 'granel']) tipo!: 'enteros' | 'granel';
  @IsBoolean() listo!: boolean;
}

class ItemRecibidoDto {
  @IsInt() itemId!: number;
  /* `@IsNumber()` rechaza NaN: con `cantidadRecibida: "x"` los dos `if` de la
   * recepción daban falso y la mercadería no entraba al destino, no volvía al
   * origen y no generaba incidencia — quedaba en `en_transito` con el remito ya
   * cerrado, y no hay ningún camino en el código que la saque de ahí. */
  @IsNumber() @Min(0) @Max(MAX_CANT) cantidadRecibida!: number;
}

class RecibirDto {
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_ITEMS) @ValidateNested({ each: true }) @Type(() => ItemRecibidoDto)
  items?: ItemRecibidoDto[];
  @IsOptional() @IsString() @MaxLength(500) observaciones?: string;
}

class CrearIncidenciaDto {
  @IsInt() productoId!: number;
  @IsOptional() @IsInt() sucursalId?: number;
  @IsOptional() @IsInt() presId?: number | null;
  @IsString() @MaxLength(40) tipo!: string;
  @IsNumber() @Min(0.001) @Max(MAX_CANT) cantidad!: number;
  /** A quién se le ATRIBUYE el faltante. NO es el autor: ese sale de la sesión. */
  @IsOptional() @IsInt() responsableId?: number;
  @IsOptional() @IsString() @MaxLength(300) motivo?: string;
}

class ResolverIncidenciaDto {
  @IsString() @MaxLength(40) resolucion!: string;
}

/* ------------------------------ Lecturas ------------------------------ */

@Controller('stock')
export class StockController {
  constructor(private readonly inv: InventarioService) {}

  @Get()
  @Permiso('almacen.existencias', 'compras.productos')
  existencias(@Auth() sesion: Sesion) {
    return this.inv.existencias(soloSuSucursal(sesion));
  }
}

@Controller('bootstrap')
export class BootstrapController {
  constructor(private readonly inv: InventarioService) {}

  /**
   * Snapshot completo del inventario. QUEDA ABIERTO a cualquier sesión válida, y
   * es una decisión, no un olvido: lo llama el sidebar de **todos** los módulos
   * para los contadores del menú, así que un `@Permiso` acá le deja el menú roto
   * a quien solo tiene Ventas. Lo que sí hay que recortar es su CONTENIDO —hoy
   * viaja el catálogo con costos y márgenes—, y eso queda anotado en /info
   * porque toca lo que consumen cuatro pantallas.
   */
  @Get()
  bootstrap() {
    return this.inv.bootstrap();
  }
}

@Controller('movimientos')
export class MovimientosController {
  constructor(private readonly inv: InventarioService) {}

  /** El historial completo del stock: solo quien tiene el libro del almacén. */
  @Get()
  @Permiso('almacen.operaciones', 'compras.historial')
  list(
    @Auth() sesion: Sesion,
    @Query('productoId') productoId?: string,
    @Query('sucursalId') sucursalId?: string,
    @Query('tipo') tipo?: string,
    @Query('desde') desde?: string,
    @Query('hasta') hasta?: string,
    @Query('limit') limit?: string,
  ) {
    const mia = soloSuSucursal(sesion);
    return this.inv.listMovimientos({
      productoId: productoId ? Number(productoId) : undefined,
      // El que no es jefe ve el movimiento de SU local: con el filtro libre se
      // reconstruía la operación completa de todas las sucursales.
      sucursalId: mia ?? (sucursalId ? Number(sucursalId) : undefined),
      tipo,
      desde,
      hasta,
      limit: limit ? Number(limit) : undefined,
    });
  }
}

/* ------------------------------ Operaciones ------------------------------ */

@Controller('operaciones')
@Permiso('almacen.existencias')
export class OperacionesController {
  constructor(private readonly inv: InventarioService) {}

  /** El libro del almacén: una fila por documento, valuada a costo. */
  @Get('almacen')
  @Permiso('almacen.operaciones')
  almacen(
    @Auth() sesion: Sesion,
    @Query('sucursalId') sucursalId?: string,
    @Query('desde') desde?: string,
    @Query('hasta') hasta?: string,
  ) {
    const mia = soloSuSucursal(sesion);
    return this.inv.operacionesAlmacen({ sucursalId: mia ?? Number(sucursalId), desde, hasta });
  }

  /*
   * Sin `POST /operaciones/compra`: el ingreso a mano quedó cerrado. La entrada
   * de mercadería es la factura (Compras › Facturación); el faltante o sobrante
   * que aparece contando la góndola se resuelve en Control de stock.
   */

  @Post('venta')
  @Permiso('inventario')
  venta(@Body() dto: VentaDto, @Auth() sesion: Sesion) {
    return this.inv.opVenta({ ...dto, usuarioId: sesion.usuarioId, sucursalId: sucursalDeOperacion(sesion, dto.sucursalId) });
  }

  @Post('fraccionar')
  @Permiso('fraccionar')
  fraccionar(@Body() dto: FraccionarDto, @Auth() sesion: Sesion) {
    return this.inv.opFraccionar({ ...dto, usuarioId: sesion.usuarioId, sucursalId: sucursalDeOperacion(sesion, dto.sucursalId) });
  }

  /** "Puse 20 paquetes y son 19": ajusta los paquetes Y el granel de una vez. */
  @Post('corregir-fraccionado')
  @Permiso('fraccionar')
  corregirFraccionado(@Body() dto: CorregirFraccionadoDto, @Auth() sesion: Sesion) {
    return this.inv.opCorregirFraccionado({ ...dto, usuarioId: sesion.usuarioId, sucursalId: sucursalDeOperacion(sesion, dto.sucursalId) });
  }

  /**
   * El movimiento manual. La llave DEPENDE DEL TIPO: dar de baja por merma o
   * por vencimiento pide `merma`, por defectuoso pide `defectuoso`, y el ajuste
   * o la devolución piden `inventario`. Es la única forma de que el permiso
   * signifique lo que dice el catálogo — con una sola llave para los cinco,
   * quien puede corregir un conteo podría asentar pérdidas.
   */
  @Post('movimiento')
  @Permiso('inventario', 'merma', 'defectuoso')
  movimiento(@Body() dto: MovimientoDto, @Auth() sesion: Sesion) {
    const llave = LLAVE_DE_TIPO[dto.tipo] ?? 'inventario';
    if (!sesion.permisos.includes('*') && !sesion.permisos.includes(llave)) {
      throw new ForbiddenException(`Tu rol no puede cargar un movimiento de tipo "${dto.tipo}".`);
    }
    /* El AJUSTE exige el motivo (19/8/2026): es la corrección a mano de un
     * número, y en el historial "Ajuste −1" sin porqué es el movimiento que
     * nadie puede explicar después. Los demás tipos ya se explican solos
     * (una merma ES el motivo); el ajuste no. */
    if (dto.tipo === 'ajuste' && !dto.motivo?.trim()) {
      throw new BadRequestException('Un ajuste necesita su motivo: es lo que queda en el historial.');
    }
    return this.inv.opSimple({ ...dto, usuarioId: sesion.usuarioId, sucursalId: sucursalDeOperacion(sesion, dto.sucursalId) });
  }
}

/* ---------------------------- Transferencias ---------------------------- */

@Controller('transferencias')
@Permiso('almacen.transferencias')
export class TransferenciasController {
  constructor(private readonly inv: InventarioService) {}

  @Get()
  list(@Auth() sesion: Sesion) {
    return this.inv.listTransferencias(soloSuSucursal(sesion));
  }

  /*
   * EL BORRADOR: el pedido que se arma durante el día (0055). `POST borrador`
   * abre o retoma el de esa ruta, `PUT` guarda la lista completa (lo llama el
   * guardado automático), `enviar` lo convierte en demanda y `DELETE` lo
   * descarta. Uno por ruta, no por cajero.
   *
   * Los cuatro se comparan contra `destinoId`, que es QUIEN PIDE. Sin eso, un
   * `PUT` con `items: []` sobre el id de otra ruta borraba el pedido que esa
   * sucursal venía armando desde la mañana — y el borrador no tiene historial,
   * así que el trabajo del día desaparecía sin dejar rastro.
   */
  /**
   * QUÉ LLEGÓ QUE ESTE LOCAL NO SABE (0083). Lo consume el armado del pedido.
   *
   * `destinoId` pasa por `sucursalDeOperacion` igual que el borrador: para el
   * cajero es SU sucursal y no la que mande, porque el cálculo es relativo al
   * local —"nunca lo tuviste", "desde tu último pedido"— y pedirlo con el id de
   * otro sería leer el historial ajeno. El jefe sí puede mirar el de cualquiera,
   * que es lo mismo que ya puede hacer con el pedido.
   */
  @Get('novedades')
  @Permiso('pedidos')
  novedades(@Query('origenId') origenId: string, @Query('destinoId') destinoId: string, @Auth() sesion: Sesion) {
    return this.inv.novedadesPedido({
      origenId: Number(origenId),
      destinoId: Number(sucursalDeOperacion(sesion, Number(destinoId))),
    });
  }

  @Post('borrador')
  @Permiso('pedidos')
  borrador(@Body() dto: AbrirBorradorDto, @Auth() sesion: Sesion) {
    const destinoId = sucursalDeOperacion(sesion, dto.destinoId);
    return this.inv.borradorTransferencia({
      origenId: Number(dto.origenId), destinoId: Number(destinoId), usuarioId: sesion.usuarioId,
    });
  }

  @Put(':id/borrador')
  @Permiso('pedidos')
  guardarBorrador(@Param('id', ParseIntPipe) id: number, @Body() dto: GuardarBorradorDto, @Auth() sesion: Sesion) {
    return this.inv.guardarBorrador(id, { ...(dto ?? {}), usuarioId: sesion.usuarioId }, soloSuSucursal(sesion));
  }

  @Post(':id/enviar')
  @Permiso('pedidos')
  enviarBorrador(@Param('id', ParseIntPipe) id: number, @Auth() sesion: Sesion) {
    return this.inv.enviarBorrador(id, { usuarioId: sesion.usuarioId }, soloSuSucursal(sesion));
  }

  @Delete(':id/borrador')
  @Permiso('pedidos')
  descartarBorrador(@Param('id', ParseIntPipe) id: number, @Auth() sesion: Sesion) {
    return this.inv.descartarBorrador(id, soloSuSucursal(sesion));
  }

  /** Avanza el estado. Es la preparación: se compara contra el ORIGEN. */
  @Post(':id/avanzar')
  @Permiso('preparar')
  avanzar(@Param('id', ParseIntPipe) id: number, @Body() dto: AvanzarDto, @Auth() sesion: Sesion) {
    return this.inv.avanzarTransferencia(id, sesion.usuarioId, dto?.desde, soloSuSucursal(sesion));
  }

  /* --- Preparación en dos listas (fase "preparada"): siempre contra el ORIGEN --- */

  /** Edita cantidad preparada / motivo de un renglón (lista sin confirmar). */
  @Patch(':id/items/:itemId')
  @Permiso('preparar')
  editarItem(
    @Param('id', ParseIntPipe) id: number,
    @Param('itemId', ParseIntPipe) itemId: number,
    @Body() dto: EditarItemDto,
    @Auth() sesion: Sesion,
  ) {
    return this.inv.editarItemTransferencia(id, itemId, dto ?? {}, soloSuSucursal(sesion));
  }

  /** Agrega un renglón durante la preparación (mercadería que llegó a último momento). */
  @Post(':id/items')
  @Permiso('preparar')
  agregarItem(@Param('id', ParseIntPipe) id: number, @Body() dto: AgregarItemDto, @Auth() sesion: Sesion) {
    return this.inv.agregarItemTransferencia(id, dto ?? ({} as AgregarItemDto), soloSuSucursal(sesion));
  }

  /** Quita un renglón AGREGADO (los pedidos por el destino se ponen en 0, no se borran). */
  @Delete(':id/items/:itemId')
  @Permiso('preparar')
  quitarItem(
    @Param('id', ParseIntPipe) id: number,
    @Param('itemId', ParseIntPipe) itemId: number,
    @Auth() sesion: Sesion,
  ) {
    return this.inv.quitarItemTransferencia(id, itemId, soloSuSucursal(sesion));
  }

  /** Confirma o desconfirma una lista (enteros | granel). Confirmar = reservar stock. */
  @Post(':id/lista')
  @Permiso('preparar')
  confirmarLista(@Param('id', ParseIntPipe) id: number, @Body() dto: ConfirmarListaDto, @Auth() sesion: Sesion) {
    return this.inv.confirmarListaTransferencia(id, { ...dto, usuarioId: sesion.usuarioId }, soloSuSucursal(sesion));
  }

  /**
   * Recepción CONTADA: cantidades por renglón; la diferencia va a incidencia.
   * Contra el DESTINO — sin esto, cualquiera cerraba el remito de otra sucursal
   * declarando 0 recibido, y los 200 kg quedaban en el limbo del origen.
   */
  @Post(':id/recibir')
  @Permiso('pedidos')
  recibir(@Param('id', ParseIntPipe) id: number, @Body() dto: RecibirDto, @Auth() sesion: Sesion) {
    return this.inv.recibirTransferencia(id, { ...(dto ?? {}), usuarioId: sesion.usuarioId }, soloSuSucursal(sesion));
  }

  /** Cancelar libera la reserva del ORIGEN, así que es de quien la preparó. */
  @Post(':id/cancelar')
  @Permiso('preparar')
  cancelar(@Param('id', ParseIntPipe) id: number, @Auth() sesion: Sesion) {
    return this.inv.cancelarTransferencia(id, sesion.usuarioId, soloSuSucursal(sesion));
  }
}

/* ------------------------------ Incidencias ------------------------------ */

@Controller('incidencias')
@Permiso('almacen.incidencias')
export class IncidenciasController {
  constructor(private readonly inv: InventarioService) {}

  @Get()
  list(@Auth() sesion: Sesion) {
    return this.inv.listIncidencias(soloSuSucursal(sesion));
  }

  @Post()
  @Permiso('incidencia_crear')
  crear(@Body() dto: CrearIncidenciaDto, @Auth() sesion: Sesion) {
    return this.inv.crearIncidencia(
      { ...dto, sucursalId: sucursalDeOperacion(sesion, dto.sucursalId) },
      sesion.usuarioId,
    );
  }

  @Post(':id/avanzar')
  @Permiso('incidencia_crear')
  avanzar(@Param('id', ParseIntPipe) id: number, @Auth() sesion: Sesion) {
    return this.inv.avanzarIncidencia(id, soloSuSucursal(sesion));
  }

  /**
   * RESOLVER es la acción fuerte: según la resolución, la mercadería vuelve a
   * disponible o se da de baja como pérdida real. Por eso pide `inventario` y
   * no la llave de crear — cualquiera puede reportar un faltante; cerrarlo
   * contra el stock es otra cosa.
   */
  @Post(':id/resolver')
  @Permiso('inventario')
  resolver(@Param('id', ParseIntPipe) id: number, @Body() dto: ResolverIncidenciaDto, @Auth() sesion: Sesion) {
    return this.inv.resolverIncidencia(id, dto.resolucion, sesion.usuarioId, soloSuSucursal(sesion));
  }
}

/* ==================================================================== *
 * Control de stock (0066)
 * ==================================================================== */

class CrearConteoDto {
  @IsOptional() @IsString() @MaxLength(120) nombre?: string;
  /** Solo el jefe puede apagarlo: ciego por defecto es decisión del dueño. */
  @IsOptional() @IsBoolean() ciego?: boolean;
  @IsOptional() @IsInt() sucursalId?: number;
  @IsOptional() @IsInt() marcaId?: number;
  @IsOptional() @IsInt() categoriaId?: number;
  @IsOptional() @IsInt() proveedorId?: number;
  @IsOptional() @IsIn(['entero', 'granel']) tipo?: 'entero' | 'granel';
  @IsOptional() @IsBoolean() soloConStock?: boolean;
  @IsOptional() @IsBoolean() incluirArchivados?: boolean;
}

class ContarItemDto {
  /**
   * `null` devuelve el renglón a pendiente ("me equivoqué de renglón").
   * `@IsOptional()` saltea null a propósito — el reset es un valor legal.
   */
  @IsOptional() @IsNumber() @Min(0) @Max(MAX_CANT) contado?: number | null;
}

class RecontarDto {
  @IsBoolean() recontar!: boolean;
}

/**
 * La doble llave del conteo, calcada del resto del sistema: la SECCIÓN
 * (`almacen.conteos`) deja abrir, contar y cerrar — registrar la realidad no
 * mueve stock. La ACCIÓN (`conteos_aplicar`) es la que ajusta mercadería y
 * plata, y arranca solo en admin: el dueño se la da a su encargado desde
 * Usuarios y roles.
 *
 * `puedeAplicar` también decide QUÉ SE VE: el ciego lo impone el servicio y
 * la llave del reporte es la misma que la del botón de aplicar — el que no
 * puede tocar el stock tampoco ve las diferencias de una sesión ciega.
 */
@Controller('conteos')
@Permiso('almacen.conteos')
export class ConteosController {
  constructor(private readonly inv: InventarioService) {}

  private puedeAplicar(sesion: Sesion) {
    const p = sesion.permisos ?? [];
    return p.includes('*') || p.includes('conteos_aplicar');
  }

  @Get()
  list(@Auth() sesion: Sesion, @Query('sucursalId') sucursalId?: string) {
    /* El jefe puede mirar cualquier sucursal; el resto, la suya. */
    const pedida = sucursalId ? parseInt(sucursalId, 10) : undefined;
    return this.inv.listarConteos(soloSuSucursal(sesion) ?? pedida ?? null);
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number, @Auth() sesion: Sesion) {
    return this.inv.getConteo(id, {
      puedeVerVirtual: this.puedeAplicar(sesion),
      soloSuc: soloSuSucursal(sesion),
    });
  }

  @Post()
  crear(@Body() dto: CrearConteoDto, @Auth() sesion: Sesion) {
    return this.inv.crearConteo({
      ...dto,
      sucursalId: sucursalDeOperacion(sesion, dto.sucursalId)!,
      /* Abrir un conteo NO ciego es decisión del que revisa, no del que
       * cuenta: sin la llave de aplicar, el pedido de `ciego: false` se
       * ignora y la sesión nace ciega igual. */
      ciego: this.puedeAplicar(sesion) ? (dto.ciego ?? true) : true,
      usuarioId: sesion.usuarioId,
    });
  }

  @Put(':id/items/:itemId')
  contar(
    @Param('id', ParseIntPipe) id: number,
    @Param('itemId', ParseIntPipe) itemId: number,
    @Body() dto: ContarItemDto,
    @Auth() sesion: Sesion,
  ) {
    return this.inv.contarItem(id, itemId, {
      contado: dto.contado ?? null,
      usuarioId: sesion.usuarioId,
    }, soloSuSucursal(sesion));
  }

  @Post(':id/cerrar')
  cerrar(@Param('id', ParseIntPipe) id: number, @Auth() sesion: Sesion) {
    return this.inv.cerrarConteo(id, soloSuSucursal(sesion));
  }

  @Post(':id/reabrir')
  reabrir(@Param('id', ParseIntPipe) id: number, @Auth() sesion: Sesion) {
    return this.inv.reabrirConteo(id, soloSuSucursal(sesion));
  }

  /** La marca "volvé a la góndola" la pone el que revisa el reporte. */
  @Post(':id/items/:itemId/recontar')
  @Permiso('conteos_aplicar')
  recontar(
    @Param('id', ParseIntPipe) id: number,
    @Param('itemId', ParseIntPipe) itemId: number,
    @Body() dto: RecontarDto,
    @Auth() sesion: Sesion,
  ) {
    return this.inv.marcarRecontar(id, itemId, dto.recontar, soloSuSucursal(sesion));
  }

  @Post(':id/aplicar')
  @Permiso('conteos_aplicar')
  aplicar(@Param('id', ParseIntPipe) id: number, @Auth() sesion: Sesion) {
    return this.inv.aplicarConteo(id, sesion.usuarioId, soloSuSucursal(sesion));
  }

  /* Sin @Permiso extra a propósito: la cajera descarta SU sesión mal abierta
   * mientras esté virgen; el servicio exige la llave de aplicar en cuanto hay
   * renglones contados adentro — tirar trabajo lo decide el que revisa. */
  @Delete(':id')
  descartar(@Param('id', ParseIntPipe) id: number, @Auth() sesion: Sesion) {
    return this.inv.descartarConteo(id, {
      puedeAplicar: this.puedeAplicar(sesion),
      soloSuc: soloSuSucursal(sesion),
    });
  }
}
