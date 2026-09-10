import {
  CallHandler, ExecutionContext, Injectable, ConsoleLogger, NestInterceptor,
} from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';

/**
 * QUÉ DEJA ESCRITO LA API, Y POR QUÉ ANTES NO ALCANZABA
 * ============================================================================
 * El día que las cajas empezaron a ver "no se pudo conectar", se fue a buscar
 * la causa al log del servidor y ahí no había NADA: 383 líneas, de las cuales
 * 380 eran el listado de rutas del arranque y 3 el "ya estoy escuchando". Ni
 * una sola línea sobre las miles de peticiones atendidas en tres días.
 *
 * O sea que el sistema tenía los dos problemas a la vez:
 *
 *   · ESCRIBÍA DE MÁS lo que no sirve — 300 líneas anunciando cada ruta que
 *     existe, en cada arranque. En desarrollo son útiles; en el servidor solo
 *     entierran lo importante.
 *   · NO ESCRIBÍA NADA de lo que sí sirve — ninguna petición lenta, ningún
 *     error, ninguna pista.
 *
 * Este archivo resuelve las dos mitades.
 */

/**
 * Los contextos que Nest usa para narrar su propio arranque. Son valiosos
 * mientras se programa y puro ruido en el servidor: no cambian nunca y ocupan
 * el 98% del archivo de log.
 */
const CONTEXTOS_DE_ARRANQUE = ['RouterExplorer', 'RoutesResolver', 'InstanceLoader'];

/**
 * El logger de siempre, pero callando el inventario de rutas cuando corre en
 * producción. Lo demás —el "Nest application successfully started", los avisos
 * y los errores— sigue saliendo igual.
 */
export class LoggerApi extends ConsoleLogger {
  private readonly silenciarArranque = process.env.NODE_ENV === 'production';

  log(mensaje: any, contexto?: string) {
    if (this.silenciarArranque && CONTEXTOS_DE_ARRANQUE.includes(contexto ?? '')) return;
    super.log(mensaje, contexto as any);
  }
}

/**
 * A PARTIR DE CUÁNTO UNA PETICIÓN MERECE QUEDAR ESCRITA.
 *
 * No se registran todas a propósito: con ~23 llamadas por minuto y por caja,
 * anotarlas todas sería volver al problema de enterrar lo importante (y llenar
 * el disco del VPS). Solo interesa lo que se sale de lo normal.
 *
 * 2 segundos es el umbral porque una pantalla que tarda más que eso ya se
 * siente lenta, y porque las peticiones normales de este sistema andan por
 * debajo de los 300 ms: lo que pase de 2 segundos es una anomalía real.
 */
const LENTA_MS = 2_000;

/**
 * Deja constancia de las peticiones LENTAS y de las que FALLAN. Nada más.
 *
 * Es lo que convierte "los cajeros dicen que a veces no anda" en una línea con
 * la ruta, los milisegundos y el error — que es la diferencia entre corregir y
 * adivinar.
 */
@Injectable()
export class RegistroInterceptor implements NestInterceptor {
  private readonly logger = new ConsoleLogger('HTTP');

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<any> {
    const req = ctx.switchToHttp().getRequest();
    const inicio = Date.now();
    const donde = `${req?.method} ${req?.originalUrl ?? req?.url}`;

    return next.handle().pipe(
      tap(() => {
        const ms = Date.now() - inicio;
        if (ms >= LENTA_MS) {
          this.logger.warn(`LENTA ${ms}ms · ${donde}`);
        }
      }),
      catchError((err) => {
        const ms = Date.now() - inicio;
        const status = Number(err?.status) || 500;
        /*
         * Los 4xx NO se registran: son parte del funcionamiento normal (una
         * contraseña equivocada, un stock que no alcanza, un permiso que
         * falta). El sistema ya se los explica a quien los provocó. Anotarlos
         * llenaría el log de nuevo con lo que no es un problema.
         *
         * Los 5xx sí: esos son fallas del servidor, y son las que hay que ver.
         */
        if (status >= 500) {
          this.logger.error(`FALLA ${status} · ${ms}ms · ${donde} · ${err?.message ?? err}`);
        }
        return throwError(() => err);
      }),
    );
  }
}
