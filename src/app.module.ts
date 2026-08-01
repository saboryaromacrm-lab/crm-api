import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DbModule } from './db/db.module';
import { HealthController } from './health.controller';
import { InventarioModule } from './inventario/inventario.module';
import { ComprobantesModule } from './comprobantes/comprobantes.module';
import { ProductosModule } from './productos/productos.module';
import { ProveedoresModule } from './proveedores/proveedores.module';
import { PreciosModule } from './precios/precios.module';
import { SucursalesModule } from './sucursales/sucursales.module';
import { UsuariosModule } from './usuarios/usuarios.module';
import { CajaModule } from './caja/caja.module';
import { ClientesModule } from './clientes/clientes.module';
import { CobranzasModule } from './cobranzas/cobranzas.module';
import { ConfiguracionModule } from './configuracion/configuracion.module';
import { VentasModule } from './ventas/ventas.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DbModule,
    InventarioModule,
    ComprobantesModule,
    ProductosModule,
    ProveedoresModule,
    PreciosModule,
    SucursalesModule,
    UsuariosModule,
    // Ventas
    ConfiguracionModule,
    ClientesModule,
    CajaModule,
    VentasModule,
    CobranzasModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
