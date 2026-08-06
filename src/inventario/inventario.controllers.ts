import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { InventarioService } from './inventario.service';

@Controller('stock')
export class StockController {
  constructor(private readonly inv: InventarioService) {}

  @Get()
  existencias() {
    return this.inv.existencias();
  }
}

@Controller('bootstrap')
export class BootstrapController {
  constructor(private readonly inv: InventarioService) {}

  /** Snapshot completo del estado del inventario (una sola llamada). */
  @Get()
  bootstrap() {
    return this.inv.bootstrap();
  }
}

@Controller('movimientos')
export class MovimientosController {
  constructor(private readonly inv: InventarioService) {}

  @Get()
  list(
    @Query('productoId') productoId?: string,
    @Query('sucursalId') sucursalId?: string,
    @Query('tipo') tipo?: string,
    @Query('limit') limit?: string,
  ) {
    return this.inv.listMovimientos({
      productoId: productoId ? Number(productoId) : undefined,
      sucursalId: sucursalId ? Number(sucursalId) : undefined,
      tipo,
      limit: limit ? Number(limit) : undefined,
    });
  }
}

@Controller('operaciones')
export class OperacionesController {
  constructor(private readonly inv: InventarioService) {}

  /** El libro del almacén: una fila por documento, valuada a costo. */
  @Get('almacen')
  almacen(
    @Query('sucursalId') sucursalId?: string,
    @Query('desde') desde?: string,
    @Query('hasta') hasta?: string,
  ) {
    return this.inv.operacionesAlmacen({ sucursalId: Number(sucursalId), desde, hasta });
  }

  @Post('compra')
  compra(@Body() body: any) {
    return this.inv.opCompra(body);
  }

  @Post('venta')
  venta(@Body() body: any) {
    return this.inv.opVenta(body);
  }

  @Post('fraccionar')
  fraccionar(@Body() body: any) {
    return this.inv.opFraccionar(body);
  }

  @Post('movimiento')
  movimiento(@Body() body: any) {
    return this.inv.opSimple(body);
  }
}

@Controller('transferencias')
export class TransferenciasController {
  constructor(private readonly inv: InventarioService) {}

  @Get()
  list() {
    return this.inv.listTransferencias();
  }

  @Post()
  crear(@Body() body: any) {
    return this.inv.crearTransferencia(body);
  }

  @Post(':id/avanzar')
  avanzar(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.inv.avanzarTransferencia(id, body?.usuarioId, body?.desde);
  }

  /* --- Preparación en dos listas (fase "preparada") --- */

  /** Edita cantidad preparada / motivo de un renglón (lista sin confirmar). */
  @Patch(':id/items/:itemId')
  editarItem(
    @Param('id', ParseIntPipe) id: number,
    @Param('itemId', ParseIntPipe) itemId: number,
    @Body() body: any,
  ) {
    return this.inv.editarItemTransferencia(id, itemId, body ?? {});
  }

  /** Agrega un renglón durante la preparación (mercadería que llegó a último momento). */
  @Post(':id/items')
  agregarItem(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.inv.agregarItemTransferencia(id, body ?? {});
  }

  /** Quita un renglón AGREGADO (los pedidos por el destino se ponen en 0, no se borran). */
  @Delete(':id/items/:itemId')
  quitarItem(@Param('id', ParseIntPipe) id: number, @Param('itemId', ParseIntPipe) itemId: number) {
    return this.inv.quitarItemTransferencia(id, itemId);
  }

  /** Confirma o desconfirma una lista (enteros | granel). Confirmar = reservar stock. */
  @Post(':id/lista')
  confirmarLista(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.inv.confirmarListaTransferencia(id, body ?? {});
  }

  /** Recepción CONTADA: cantidades por renglón; la diferencia va a incidencia. */
  @Post(':id/recibir')
  recibir(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.inv.recibirTransferencia(id, body ?? {});
  }

  @Post(':id/cancelar')
  cancelar(@Param('id', ParseIntPipe) id: number) {
    return this.inv.cancelarTransferencia(id);
  }
}

@Controller('incidencias')
export class IncidenciasController {
  constructor(private readonly inv: InventarioService) {}

  @Get()
  list() {
    return this.inv.listIncidencias();
  }

  @Post()
  crear(@Body() body: any) {
    return this.inv.crearIncidencia(body);
  }

  @Post(':id/avanzar')
  avanzar(@Param('id', ParseIntPipe) id: number) {
    return this.inv.avanzarIncidencia(id);
  }

  @Post(':id/resolver')
  resolver(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.inv.resolverIncidencia(id, body?.resolucion);
  }
}
