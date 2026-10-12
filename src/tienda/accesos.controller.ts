/**
 * La bandeja del ERP de los pedidos de ingreso a la tienda (0155): Ventas ›
 * Accesos a la tienda. Llave `ventas.accesos_tienda` (admin por migración;
 * superadmin por el comodín).
 */
import { Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { Auth, Permiso, type Sesion } from '../auth/auth.decoradores';
import { AccesosTiendaService } from './accesos';

@Controller('tienda-accesos')
@Permiso('ventas.accesos_tienda')
export class AccesosTiendaController {
  constructor(private readonly svc: AccesosTiendaService) {}

  @Get()
  listar(@Query('estado') estado?: string) { return this.svc.listar(estado); }

  /** El contador del globito y del cartel de arriba. */
  @Get('pendientes')
  pendientes() { return this.svc.pendientes(); }

  @Post(':id/habilitar')
  habilitar(@Param('id', ParseIntPipe) id: number, @Auth() s: Sesion) { return this.svc.habilitar(id, s.usuarioId); }

  /** Rechazar (pendiente) o deshabilitar (habilitado): el DNI queda bloqueado. */
  @Post(':id/bloquear')
  bloquear(@Param('id', ParseIntPipe) id: number, @Auth() s: Sesion) { return this.svc.bloquear(id, s.usuarioId); }

  @Post(':id/avisado-recibida')
  avisadoRecibida(@Param('id', ParseIntPipe) id: number) { return this.svc.avisadoRecibida(id); }
}
