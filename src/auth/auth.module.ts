import { Global, Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AuthGuard } from './auth.guard';
import { AutorInterceptor } from './autor.interceptor';
import { FrenoLogin } from './freno-login';
import { SesionesService } from './sesiones.service';

/**
 * Global a propósito: el guard vive acá y `SesionesService` lo necesitan el
 * login (para crear la sesión) y Gerencia (para cortarlas). Importarlo en cada
 * módulo sería ruido sin ninguna ganancia.
 *
 * `APP_GUARD` es lo que lo vuelve la puerta de TODA la API en vez de un guard
 * que hay que acordarse de poner endpoint por endpoint.
 */
@Global()
@Module({
  providers: [
    SesionesService,
    FrenoLogin,
    { provide: APP_GUARD, useClass: AuthGuard },
    // Corre después del guard y antes de los pipes: el `usuarioId` del body ya
    // es el de la sesión cuando el DTO se valida.
    { provide: APP_INTERCEPTOR, useClass: AutorInterceptor },
  ],
  exports: [SesionesService, FrenoLogin],
})
export class AuthModule {}
