import { Module } from '@nestjs/common';
import { ConfiguracionModule } from '../configuracion/configuracion.module';
import { InventarioService } from './inventario.service';
import {
  StockController, BootstrapController, MovimientosController, OperacionesController,
  TransferenciasController, IncidenciasController,
} from './inventario.controllers';

@Module({
  imports: [ConfiguracionModule],
  controllers: [
    StockController, BootstrapController, MovimientosController, OperacionesController,
    TransferenciasController, IncidenciasController,
  ],
  providers: [InventarioService],
  exports: [InventarioService],
})
export class InventarioModule {}
