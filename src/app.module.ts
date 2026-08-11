import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DbModule } from './db/db.module';
import { AuthModule } from './auth/auth.module';
import { HealthController } from './health.controller';
import { InventarioModule } from './inventario/inventario.module';
import { ComprobantesModule } from './comprobantes/comprobantes.module';
import { FacturasModule } from './facturas/facturas.module';
import { ProductosModule } from './productos/productos.module';
import { CatalogosModule } from './catalogos/catalogos.module';
import { ProveedoresModule } from './proveedores/proveedores.module';
import { PreciosModule } from './precios/precios.module';
import { ListasModule } from './listas/listas.module';
import { SucursalesModule } from './sucursales/sucursales.module';
import { UsuariosModule } from './usuarios/usuarios.module';
import { CajaModule } from './caja/caja.module';
import { ClientesModule } from './clientes/clientes.module';
import { CobranzasModule } from './cobranzas/cobranzas.module';
import { ConfiguracionModule } from './configuracion/configuracion.module';
import { VentasModule } from './ventas/ventas.module';
import { OfertasModule } from './ofertas/ofertas.module';
import { PresupuestosModule } from './presupuestos/presupuestos.module';
import { TiendaModule } from './tienda/tienda.module';
import { WebModule } from './web/web.module';
import { GastosModule } from './gastos/gastos.module';
import { PagosModule } from './pagos/pagos.module';
import { CafeteriaModule } from './cafeteria/cafeteria.module';
import { VencimientosModule } from './vencimientos/vencimientos.module';
import { ChatModule } from './chat/chat.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DbModule,
    // Antes que todo lo demás: registra el guard global, que es la puerta de
    // los 224 endpoints. Cerrado por defecto; lo público se marca a mano.
    AuthModule,
    InventarioModule,
    ComprobantesModule,
    FacturasModule,
    ProductosModule,
    CatalogosModule,
    ProveedoresModule,
    PreciosModule,
    ListasModule,
    SucursalesModule,
    UsuariosModule,
    // Ventas
    ConfiguracionModule,
    ClientesModule,
    CajaModule,
    OfertasModule,
    VentasModule,
    CobranzasModule,
    PresupuestosModule,
    TiendaModule,
    WebModule,
    // Administración
    PagosModule,
    GastosModule,
    CafeteriaModule,
    VencimientosModule,
    ChatModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
