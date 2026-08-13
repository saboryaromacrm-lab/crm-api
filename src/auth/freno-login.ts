/**
 * FRENO DE INTENTOS DEL LOGIN
 * ============================================================================
 * El mínimo de contraseña es de **8 caracteres** (`MIN_PASSWORD` en
 * usuarios.module.ts), pero las que ya están guardadas de antes pueden ser de 4
 * y las que reparte la semilla arrancan en `1234`. Sin freno, las 10.000
 * combinaciones de 4 dígitos se prueban en minutos, y ahí toda la autenticación
 * que construimos no protege nada.
 *
 * DOS CONTADORES, porque son dos ataques distintos:
 *
 *   * por USUARIO **Y ORIGEN** — alguien machacando la cuenta de Lucas.
 *   * por IP — alguien probando `1234` contra los 7 usuarios, uno por uno.
 *     Frenar por usuario no lo detiene, porque nunca insiste con el mismo.
 *
 * POR QUÉ EL PRIMERO LLEVA LA IP EN LA CLAVE, y no es un detalle.
 *
 * Cuando el contador del usuario era global, el castigo lo manejaba el atacante:
 * cinco intentos fallidos contra el id del dueño lo dejaban afuera, y repitiendo
 * el ciclo se lo podía mantener bloqueado indefinidamente **desde internet, sin
 * sesión y sin costo** — un lunes a la mañana con la caja sin abrir eso no es
 * una molestia teórica. Al llevar la IP en la clave, los intentos de un extraño
 * ya no cuentan contra la cajera que entra desde el local: cada origen gasta su
 * propio cupo.
 *
 * LO QUE SE PAGA A CAMBIO, dicho en voz alta: un atacante con muchas IPs
 * distintas consigue 5 intentos por IP contra el mismo usuario, en vez de 5 en
 * total. La defensa contra eso no es el contador —siempre se puede rotar de IP—
 * sino que la contraseña no sea adivinable: por eso el mínimo subió de 4 a 8
 * caracteres en el mismo cambio. Las dos piezas van juntas.
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

/** Intentos fallidos tolerados antes de la espera, por usuario Y origen. */
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

  /** La cuenta de una persona VISTA DESDE UN ORIGEN: el cupo es de esa dupla. */
  private static claveUsuario(usuarioId: unknown, ip: string) { return `u:${usuarioId}@${ip}`; }

  /** Antes de verificar la contraseña. Lanza 429 si está frenado. */
  revisar(usuarioId: unknown, ip: string) {
    const ahora = Date.now();
    this.vencer(ahora);
    for (const [mapa, clave, tope] of [
      [this.porUsuario, FrenoLogin.claveUsuario(usuarioId, ip), TOPE_USUARIO],
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
      [this.porUsuario, FrenoLogin.claveUsuario(usuarioId, ip)],
      [this.porIp, `i:${ip}`],
    ] as [Map<string, Contador>, string][]) {
      const c = mapa.get(clave);
      // La ventana se corre en cada fallo: probar uno cada 4 minutos para
      // siempre no puede ser una forma de esquivar el tope.
      mapa.set(clave, { fallos: (c && c.hasta > ahora ? c.fallos : 0) + 1, hasta: ahora + ESPERA_MS });
    }
  }

  /** Entró bien: la dupla usuario+origen queda limpia (la IP no, por las dudas). */
  exito(usuarioId: unknown, ip: string) {
    this.porUsuario.delete(FrenoLogin.claveUsuario(usuarioId, ip));
  }

  /** Barrido de contadores viejos, para que los mapas no crezcan sin techo. */
  private vencer(ahora: number) {
    for (const mapa of [this.porUsuario, this.porIp]) {
      for (const [k, c] of mapa) if (c.hasta <= ahora) mapa.delete(k);
    }
  }
}
