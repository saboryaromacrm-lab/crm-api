import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth.guard';
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
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [SesionesService],
})
export class AuthModule {}
