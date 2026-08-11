import { Controller, Get } from '@nestjs/common';
import { Publico } from './auth/auth.decoradores';

@Controller('health')
export class HealthController {
  /**
   * Público: es lo que consulta el deploy para saber si el servicio quedó
   * andando, y en ese momento todavía no hay ninguna sesión. No dice nada del
   * negocio — solo que el proceso está vivo.
   */
  @Publico()
  @Get()
  check() {
    return { status: 'ok', service: 'crm-api', ts: new Date().toISOString() };
  }
}
