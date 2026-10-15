import { Module } from '@nestjs/common';
import { ConfiguracionModule } from '../configuracion/configuracion.module';
import { ListasModule } from '../listas/listas.module';
import { InventarioService } from './inventario.service';
import { FraccionamientosController, FraccionamientosService } from './fraccionamientos';
import { PedidosFraccionController, PedidosFraccionService } from './pedidos-fraccion';
import {
  StockController, BootstrapController, MovimientosController, OperacionesController,
  TransferenciasController, IncidenciasController, ConteosController, SinMovimientoController, BajosStockController,
  OrdenPedidoController,
} from './inventario.controllers';

@Module({
  imports: [ConfiguracionModule, ListasModule],
  controllers: [
    StockController, BootstrapController, MovimientosController, OperacionesController,
    TransferenciasController, IncidenciasController, ConteosController, FraccionamientosController,
    SinMovimientoController, BajosStockController, OrdenPedidoController, PedidosFraccionController,
  ],
  providers: [InventarioService, FraccionamientosService, PedidosFraccionService],
  exports: [InventarioService],
})
export class InventarioModule {}
