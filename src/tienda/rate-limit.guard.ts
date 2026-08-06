/**
 * RATE LIMIT de los endpoints públicos de la tienda
 * ============================================================================
 * Ventana deslizante por IP, EN MEMORIA: la API es un solo proceso, así que no
 * hace falta nada externo, y si se reinicia los contadores arrancan de cero
 * sin consecuencias. Es reducción de molestia contra bots tontos — NO
 * reemplaza la autenticación pre-deploy, que sigue siendo el bloqueante real
 * (el respaldo fuerte en producción es el limit_req de nginx).
 *
 * Los cupos NO son todos iguales, y esa asimetría es la lógica:
 *  - `pedidos` es ESTRICTO: nadie legítimo manda 5 pedidos en 10 minutos, y es
 *    lo que protege la bandeja de órdenes.
 *  - Lo que es MIRAR (catálogo, imágenes) es holgado a propósito: en Argentina
 *    muchos clientes móviles comparten IP (CGNAT) — un cupo agresivo de
 *    lectura bloquearía a dos clientas reales detrás de la misma antena.
 *
 * Las IPs PRIVADAS y loopback están exentas: el SSR de Next y el CRM viven en
 * la misma máquina/red y todo su tráfico sale de ahí — limitarlos sería
 * limitar a la propia infraestructura. Los visitantes reales llegan por el
 * proxy con su IP pública en X-Forwarded-For (ver `trust proxy` en main.ts).
 */
import {
  CanActivate, ExecutionContext, HttpException, Injectable, SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

const RATE_LIMIT_KEY = 'tienda:rate-limit';

/** Marca una ruta con su regla de cupo. Sin marca = sin límite. */
export const RateLimit = (regla: keyof typeof REGLAS) => SetMetadata(RATE_LIMIT_KEY, regla);

export const REGLAS = {
  /** Alta de pedidos: lo único que de verdad duele si lo spamean. */
  pedidos: { max: 5, ventanaMs: 10 * 60_000, aviso: 'Demasiados pedidos seguidos: esperá unos minutos y probá de nuevo.' },
  /** Telemetría: el navegador manda un lote cada 15 s como máximo — 40 sobra. */
  eventos: { max: 40, ventanaMs: 10 * 60_000, aviso: 'Demasiadas peticiones.' },
  /** Navegación normal + freno al scraping grosero. */
  catalogo: { max: 60, ventanaMs: 60_000, aviso: 'Demasiadas peticiones: esperá un momento.' },
  /** Una portada carga 20+ imágenes de un saque: muy holgado. */
  imagenes: { max: 200, ventanaMs: 60_000, aviso: 'Demasiadas peticiones: esperá un momento.' },
} as const;

/** Loopback y rangos privados (RFC 1918): la infraestructura propia no se limita. */
function esIpExenta(ip: string): boolean {
  const v = ip.replace(/^::ffff:/, '');
  return v === '::1' || v === 'localhost'
    || v.startsWith('127.') || v.startsWith('10.') || v.startsWith('192.168.')
    || /^172\.(1[6-9]|2\d|3[01])\./.test(v);
}

@Injectable()
export class TiendaRateLimitGuard implements CanActivate {
  /** `regla:ip` → timestamps de las últimas requests dentro de la ventana. */
  private readonly ventanas = new Map<string, number[]>();

  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const regla = this.reflector.get<keyof typeof REGLAS>(RATE_LIMIT_KEY, ctx.getHandler());
    if (!regla) return true;

    const req = ctx.switchToHttp().getRequest();
    const ip = String(req.ip ?? req.socket?.remoteAddress ?? '');
    if (!ip || esIpExenta(ip)) return true;

    const { max, ventanaMs, aviso } = REGLAS[regla];
    const ahora = Date.now();
    const clave = `${regla}:${ip}`;

    const previos = (this.ventanas.get(clave) ?? []).filter((t) => ahora - t < ventanaMs);
    if (previos.length >= max) {
      const esperaSeg = Math.ceil((previos[0] + ventanaMs - ahora) / 1000);
      throw new HttpException({ statusCode: 429, message: aviso, retryAfter: esperaSeg }, 429);
    }
    previos.push(ahora);
    this.ventanas.set(clave, previos);

    // Limpieza perezosa: si el mapa junta demasiadas IPs de paso, se barren
    // las ventanas ya vencidas. Sin timers: se paga recién cuando hace falta.
    if (this.ventanas.size > 5000) {
      for (const [k, ts] of this.ventanas) {
        if (ts.every((t) => ahora - t > 10 * 60_000)) this.ventanas.delete(k);
      }
    }
    return true;
  }
}
