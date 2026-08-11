/**
 * FRENO DE INTENTOS DEL LOGIN
 * ============================================================================
 * Las contraseñas de este sistema pueden ser de **4 caracteres** (el mínimo que
 * valida el alta, y las que se reparten arrancan en `1234`). Sin freno, las
 * 10.000 combinaciones de 4 dígitos se prueban en minutos, y ahí toda la
 * autenticación que acabamos de construir no protege nada.
 *
 * DOS CONTADORES, porque son dos ataques distintos:
 *
 *   * por USUARIO — alguien machacando la cuenta de Lucas. Frenar por IP no lo
 *     detiene si rota de IP, y frenar por usuario sí.
 *   * por IP — alguien probando `1234` contra los 7 usuarios, uno por uno.
 *     Frenar por usuario no lo detiene, porque nunca insiste con el mismo.
 *
 * Solo cuentan los intentos FALLIDOS y el login exitoso limpia el del usuario:
 * el cajero que se equivocó dos veces y entró a la tercera no arranca el turno
 * con dos estrellas en contra.
 *
 * En memoria y no en la base: un reinicio del servicio borra los contadores, y
 * está bien — reiniciar la API no es algo que un atacante pueda provocar, y
 * mantener una tabla para esto sería una pieza más que respaldar y limpiar.
 */
import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

/** Intentos fallidos tolerados antes de la espera, por usuario. */
const TOPE_USUARIO = 5;
/** Ídem por IP: más alto porque una sucursal entera sale por la misma IP. */
const TOPE_IP = 20;
/** Cuánto dura el castigo, y también la ventana en que se acumulan. */
const ESPERA_MS = 5 * 60_000;

type Contador = { fallos: number; hasta: number };

@Injectable()
export class FrenoLogin {
  private readonly porUsuario = new Map<string, Contador>();
  private readonly porIp = new Map<string, Contador>();

  /** Antes de verificar la contraseña. Lanza 429 si está frenado. */
  revisar(usuarioId: unknown, ip: string) {
    const ahora = Date.now();
    this.vencer(ahora);
    for (const [mapa, clave, tope] of [
      [this.porUsuario, `u:${usuarioId}`, TOPE_USUARIO],
      [this.porIp, `i:${ip}`, TOPE_IP],
    ] as [Map<string, Contador>, string, number][]) {
      const c = mapa.get(clave);
      if (c && c.fallos >= tope && c.hasta > ahora) {
        const min = Math.ceil((c.hasta - ahora) / 60_000);
        throw new HttpException(
          `Demasiados intentos fallidos. Probá de nuevo en ${min} minuto${min === 1 ? '' : 's'}.`,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
  }

  /** Contraseña incorrecta (o usuario inexistente): suma y estira la espera. */
  fallo(usuarioId: unknown, ip: string) {
    const ahora = Date.now();
    for (const [mapa, clave] of [
      [this.porUsuario, `u:${usuarioId}`],
      [this.porIp, `i:${ip}`],
    ] as [Map<string, Contador>, string][]) {
      const c = mapa.get(clave);
      // La ventana se corre en cada fallo: probar uno cada 4 minutos para
      // siempre no puede ser una forma de esquivar el tope.
      mapa.set(clave, { fallos: (c && c.hasta > ahora ? c.fallos : 0) + 1, hasta: ahora + ESPERA_MS });
    }
  }

  /** Entró bien: el usuario queda limpio (la IP no, por las dudas). */
  exito(usuarioId: unknown) {
    this.porUsuario.delete(`u:${usuarioId}`);
  }

  /** Barrido de contadores viejos, para que los mapas no crezcan sin techo. */
  private vencer(ahora: number) {
    for (const mapa of [this.porUsuario, this.porIp]) {
      for (const [k, c] of mapa) if (c.hasta <= ahora) mapa.delete(k);
    }
  }
}
