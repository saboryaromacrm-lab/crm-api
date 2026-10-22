/**
 * LOS ASESORES (0193, 21/10/2026, pedidos del dueño)
 * ============================================================================
 *   Gerencia › Asesor            /asesor             llave `gerencia.asesor` (fuera del
 *                                                    catálogo: solo superadmin).
 *   Ventas › Asesor comercial    /asesor-comercial   llave `ventas.asesor` (en el catálogo:
 *                                                    superadmin y administradores).
 *
 * Cómo está hecho (ver cada archivo):
 *   nucleo/          qué es un especialista y la llamada a Claude.
 *   asesor.service   lo común: tope, ficha, aprendizajes, análisis en segundo
 *                    plano, opiniones y conversaciones (todo por especialidad).
 *   datos.ts         las cuentas que miran (solo lectura, tablas resumen).
 *   herramientas.ts  lo que la IA puede consultar al responder (un registro).
 *   negocio/         rentabilidad, granel y fraccionado, stock, cajas, gastos.
 *   comercial/       ofertas, combos, fechas comerciales, tienda online,
 *                    vencimientos; sus propuestas se crean como oferta DESACTIVADA.
 *
 * Las rutas son las mismas para los dos: viven en `RutasAsesor` y cada
 * controlador las hereda con su especialista y su llave.
 */
import { Body, Controller, Delete, Get, Inject, Module, Param, ParseIntPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { Auth, Permiso, type Sesion } from '../auth/auth.decoradores';
import { DRIZZLE, type Database } from '../db/drizzle';
import { MetricasModule, MetricasService } from '../metricas/metricas.module';
import { ResultadosModule, ResultadosService } from '../resultados/resultados.module';
import { GastosModule, GastosService } from '../gastos/gastos.module';
import { CuponesModule, CuponesService } from '../cupones/cupones.module';
import { WebModule } from '../web/web.module';
import { MetricasTiendaService } from '../web/metricas-tienda';
import { VencimientosModule } from '../vencimientos/vencimientos.module';
import { ReglasVencimientoService } from '../vencimientos/reglas.service';
import { OfertasModule, OfertasService } from '../ofertas/ofertas.module';
import { FUENTES, type Fuentes } from './datos';
import type { Especialidad } from './nucleo/especialidad';
import { AnalizarDto, AprendizajeDto, AprendizajeEditarDto, AsesorService, ConfigDto, OpinionDto, PreguntaDto } from './asesor.service';
import { NEGOCIO } from './negocio/especialidad';
import { COMERCIAL } from './comercial/especialidad';
import { FechaDto, agregarFecha, borrarFecha, crearOfertaDePropuesta, listarFechas } from './comercial/acciones';

export const PERMISO_ASESOR = 'gerencia.asesor';
export const PERMISO_ASESOR_COMERCIAL = 'ventas.asesor';

/** Las rutas de cualquier especialista: cada controlador las hereda con el suyo. */
abstract class RutasAsesor {
  constructor(protected readonly svc: AsesorService, protected readonly esp: Especialidad) {}

  @Get('estado') estado() { return this.svc.estado(this.esp); }
  @Patch('config') config(@Body() dto: ConfigDto) { return this.svc.guardarConfig(this.esp, dto); }

  @Get('foto') foto() { return this.svc.foto(this.esp); }
  @Post('analizar') analizar(@Body() dto: AnalizarDto, @Auth() s: Sesion) { return this.svc.analizar(this.esp, dto ?? {}, s?.usuarioId ?? null); }
  @Get('informes') informes(@Query('limite') limite?: string) { return this.svc.informes(this.esp, Number(limite) || 30); }
  @Get('informes/:id') informe(@Param('id', ParseIntPipe) id: number, @Query('foto') foto?: string) { return this.svc.informe(this.esp, id, foto === '1'); }
  @Put('informes/:id/opinion') opinar(@Param('id', ParseIntPipe) id: number, @Body() dto: OpinionDto, @Auth() s: Sesion) {
    return this.svc.opinar(this.esp, id, dto, s?.usuarioId ?? null);
  }

  @Post('aprendizajes') agregar(@Body() dto: AprendizajeDto, @Auth() s: Sesion) { return this.svc.agregarAprendizaje(this.esp, dto, s?.usuarioId ?? null); }
  @Patch('aprendizajes/:id') editar(@Param('id', ParseIntPipe) id: number, @Body() dto: AprendizajeEditarDto) { return this.svc.editarAprendizaje(this.esp, id, dto); }
  @Delete('aprendizajes/:id') borrar(@Param('id', ParseIntPipe) id: number) { return this.svc.borrarAprendizaje(this.esp, id); }

  @Get('conversaciones') conversaciones() { return this.svc.conversaciones(this.esp); }
  @Get('conversaciones/:id') conversacion(@Param('id', ParseIntPipe) id: number) { return this.svc.conversacion(this.esp, id); }
  @Delete('conversaciones/:id') borrarConversacion(@Param('id', ParseIntPipe) id: number) { return this.svc.borrarConversacion(this.esp, id); }
  @Post('preguntar') preguntar(@Body() dto: PreguntaDto, @Auth() s: Sesion) { return this.svc.preguntar(this.esp, dto, s?.usuarioId ?? null); }
}

@Controller('asesor')
@Permiso(PERMISO_ASESOR)
export class AsesorController extends RutasAsesor {
  constructor(svc: AsesorService) { super(svc, NEGOCIO); }
}

@Controller('asesor-comercial')
@Permiso(PERMISO_ASESOR_COMERCIAL)
export class AsesorComercialController extends RutasAsesor {
  constructor(svc: AsesorService, @Inject(DRIZZLE) private readonly db: Database, private readonly ofertas: OfertasService) { super(svc, COMERCIAL); }

  /** La propuesta del informe como oferta DESACTIVADA (pide además el permiso de Ofertas). */
  @Post('informes/:id/propuestas/:indice/crear')
  crear(@Param('id', ParseIntPipe) id: number, @Param('indice', ParseIntPipe) indice: number, @Auth() s: Sesion) {
    return crearOfertaDePropuesta(this.db, this.ofertas, id, indice, s);
  }

  @Get('fechas') fechas() { return listarFechas(this.db); }
  @Post('fechas') agregarFecha(@Body() dto: FechaDto, @Auth() s: Sesion) { return agregarFecha(this.db, dto, s?.usuarioId ?? null); }
  @Delete('fechas/:id') borrarFecha(@Param('id', ParseIntPipe) id: number) { return borrarFecha(this.db, id); }
}

@Module({
  imports: [MetricasModule, ResultadosModule, GastosModule, CuponesModule, WebModule, VencimientosModule, OfertasModule],
  controllers: [AsesorController, AsesorComercialController],
  providers: [
    AsesorService,
    {
      provide: FUENTES,
      inject: [MetricasService, ResultadosService, GastosService, CuponesService, MetricasTiendaService, ReglasVencimientoService],
      useFactory: (metricas: MetricasService, resultados: ResultadosService, gastos: GastosService, cupones: CuponesService,
        tienda: MetricasTiendaService, precios: ReglasVencimientoService): Fuentes => ({ metricas, resultados, gastos, cupones, tienda, precios }),
    },
  ],
})
export class AsesorModule {}
