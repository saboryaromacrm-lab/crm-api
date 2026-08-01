import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
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
  avanzar(@Param('id', ParseIntPipe) id: number) {
    return this.inv.avanzarTransferencia(id);
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
