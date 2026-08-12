import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';

/**
 * EL AUTOR LO PONE EL SERVIDOR
 * ============================================================================
 * Había **56 lugares** donde el `usuarioId` llegaba en el body y el servicio lo
 * guardaba como autor del movimiento, de la venta, del pago. O sea: el cliente
 * decía quién era. Con eso, cualquiera logueado podía firmar una merma, una
 * corrección de stock o un pago con el nombre de otro — y el login prometía en
 * la pantalla que "todo lo que hagas queda registrado a tu nombre".
 *
 * POR QUÉ UN INTERCEPTOR Y NO 56 EDICIONES. Tocar cada controller para pisar el
 * campo funcionaba, pero deja la regla repartida en 11 archivos y, sobre todo,
 * **el endpoint que se agregue el mes que viene nace confiando en el cliente**.
 * Es el mismo razonamiento del guard: cerrado por defecto, en un solo lugar.
 * Son 15 líneas contra 40 ediciones mecánicas que hay que acordarse de repetir.
 *
 * ORDEN DE EJECUCIÓN, que es lo que hace que esto funcione: en Nest los
 * interceptores corren DESPUÉS de los guards (así que `req.auth` ya está) y
 * ANTES de los pipes de validación (así que el DTO se valida con el valor ya
 * puesto, no con el que mandó el cliente).
 *
 * QUÉ NO TOCA, a propósito:
 *
 *   * el QUERY STRING. Ahí `usuarioId` es un FILTRO de lectura —"mostrame las
 *     ventas de Marta"— y pisarlo rompería el listado, que es justo para
 *     mirar el trabajo de otro. Los dos lugares donde el query sí significaba
 *     "quién soy" eran los del chat, y se arreglaron a mano.
 *   * los campos que significan OTRO usuario. Delegar una venta a un compañero
 *     manda un id que no es el propio; ese campo se llama `paraUsuarioId`
 *     justamente para no confundirse con el autor.
 *   * los objetos anidados. Solo el nivel de arriba: bajar recursivamente
 *     pisaría datos legítimos.
 */
@Injectable()
export class AutorInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<any> {
    const req = ctx.switchToHttp().getRequest();
    const auth = req?.auth;
    // Sin sesión es un endpoint público (login, tienda): no hay autor que poner.
    if (auth?.usuarioId && req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
      req.body.usuarioId = auth.usuarioId;
    }
    return next.handle();
  }
}
