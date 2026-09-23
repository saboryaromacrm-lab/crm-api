import { Module } from '@nestjs/common';
import { ConfiguracionModule } from '../configuracion/configuracion.module';
import { ListasModule } from '../listas/listas.module';
import { InventarioService } from './inventario.service';
import { FraccionamientosController, FraccionamientosService } from './fraccionamientos';
import {
  StockController, BootstrapController, MovimientosController, OperacionesController,
  TransferenciasController, IncidenciasController, ConteosController,
} from './inventario.controllers';

@Module({
  imports: [ConfiguracionModule, ListasModule],
  controllers: [
    StockController, BootstrapController, MovimientosController, OperacionesController,
    TransferenciasController, IncidenciasController, ConteosController, FraccionamientosController,
  ],
  providers: [InventarioService, FraccionamientosService],
  exports: [InventarioService],
})
export class InventarioModule {}
