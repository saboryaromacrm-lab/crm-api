/**
 * FRENO DE INTENTOS DEL LOGIN
 * ============================================================================
 * La contraseña puede ser un PIN de 4 dígitos (`MIN_PASSWORD` en
 * usuarios.module.ts, decisión del dueño del 16/9: se tipea en el mostrador).
 * Son 10.000 combinaciones, así que **acá está la defensa de verdad**: sin
 * freno, probarlas todas contra un login publicado en internet es cuestión de
 * horas, y toda la autenticación que construimos no protege nada.
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
 * LA ESPERA CRECE EN CADA TANDA, y es lo que hace que un PIN corto aguante.
 * Con una espera fija de 5 minutos, el que tiene paciencia prueba 1.440 claves
 * por día desde una sola IP y las 10.000 caen en menos de una semana — o sea
 * que el freno viejo alcanzaba para una contraseña de 8 caracteres y no para un
 * PIN. Triplicando el castigo en cada tanda (5 min, 15, 45, y de ahí en más una
 * hora) esa misma IP baja a unos 120 intentos por día: el mismo ataque pasa de
 * días a meses. El cajero que se equivocó dos veces y entró a la tercera no se
 * entera de que esto existe.
 *
 * Y LA MEMORIA DURA MÁS QUE EL CASTIGO (`MEMORIA_MS`). Si el registro se
 * borrara al vencer el bloqueo, esperar cinco minutos devolvería el contador a
 * cero y la escalera no escalaría NUNCA: el atacante volvería a tener sus cinco
 * intentos cada cinco minutos, para siempre. Recordar la escalera es la mitad
 * que la hace funcionar.
 *
 * LO QUE SE PAGA A CAMBIO, dicho en voz alta: un atacante con muchas IPs
 * arranca de cero en cada una. Contra eso no hay contador que alcance —siempre
 * se puede rotar de IP—, así que un PIN de 4 dígitos es una decisión de
 * comodidad con un riesgo real que se aceptó a sabiendas. Para una cuenta que
 * puede TODO (el superadmin) sigue conviniendo una contraseña larga: esa no se
 * tipea en el mostrador.
 *
 * Solo cuentan los intentos FALLIDOS, y el login exitoso limpia el del usuario
 * —con su escalera—: el que se equivocó dos veces y entró no arranca el turno
 * con dos estrellas en contra.
 *
 * En memoria y no en la base: un reinicio del servicio borra los contadores, y
 * está bien — reiniciar la API no es algo que un atacante pueda provocar, y
 * mantener una tabla para esto sería una pieza más que respaldar y limpiar.
 */
import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

/** Intentos fallidos tolerados POR TANDA, por usuario Y origen. */
const TOPE_USUARIO = 5;
/** Ídem por IP: más alto porque una sucursal entera sale por la misma IP. */
const TOPE_IP = 20;
/** Cuánto tiempo siguen sumando a la MISMA tanda los fallos sueltos. */
const VENTANA_MS = 5 * 60_000;
/** La espera después de la primera tanda; cada tanda siguiente la triplica. */
const ESPERA_BASE_MS = 5 * 60_000;
/**
 * Techo de la espera. Más que una hora no frena más a nadie —el atacante
 * igual está esperando— y sí convierte un olvido del cajero en un problema del
 * turno: a partir de acá la escalera deja de crecer.
 */
const ESPERA_TOPE_MS = 60 * 60_000;
/** Cuánto se recuerda la escalera después de que venció el último castigo. */
const MEMORIA_MS = 6 * 60 * 60_000;
/**
 * Cada cuánto, como mucho, se barren los registros vencidos. Antes el barrido
 * corría en CADA intento de login y recorría los dos mapas enteros; con seis
 * horas de memoria esos mapas son más grandes, así que el barrido se espacia y
 * el camino del login queda sin trabajo extra.
 */
const BARRIDO_CADA_MS = 60_000;
/**
 * Techo de registros por mapa. Un atacante que rota IPs crea uno por origen y,
 * con seis horas de memoria, eso podría crecer sin límite hasta comerse la RAM
 * del proceso. Pasado el techo se tiran los más viejos: perder la escalera
 * acumulada de un origen que ya no insiste no abre ninguna puerta.
 */
const TOPE_REGISTROS = 20_000;

type Contador = {
  /** Fallos de la tanda EN CURSO (se reinicia cuando la tanda se completa). */
  fallos: number;
  /** Hasta cuándo un fallo nuevo suma a la tanda en curso y no empieza otra. */
  ventana: number;
  /** Instante hasta el que está frenado. 0 = no lo está. */
  bloqueoHasta: number;
  /** Tandas completadas: es lo único que hace crecer la espera. */
  rondas: number;
  /** Cuándo se puede olvidar el registro entero (ver `MEMORIA_MS`). */
  olvidar: number;
};

@Injectable()
export class FrenoLogin {
  private readonly porUsuario = new Map<string, Contador>();
  private readonly porIp = new Map<string, Contador>();
  private ultimoBarrido = 0;

  /** La cuenta de una persona VISTA DESDE UN ORIGEN: el cupo es de esa dupla. */
  private static claveUsuario(usuarioId: unknown, ip: string) { return `u:${usuarioId}@${ip}`; }

  /** Cuánto espera quien acaba de completar su tanda número `rondas`. */
  private static espera(rondas: number) {
    return Math.min(ESPERA_BASE_MS * 3 ** Math.max(0, rondas - 1), ESPERA_TOPE_MS);
  }

  /** Antes de verificar la contraseña. Lanza 429 si está frenado. */
  revisar(usuarioId: unknown, ip: string) {
    const ahora = Date.now();
    this.barrer(ahora);
    for (const [mapa, clave] of [
      [this.porUsuario, FrenoLogin.claveUsuario(usuarioId, ip)],
      [this.porIp, `i:${ip}`],
    ] as [Map<string, Contador>, string][]) {
      const c = mapa.get(clave);
      if (c && c.bloqueoHasta > ahora) {
        const min = Math.ceil((c.bloqueoHasta - ahora) / 60_000);
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
    for (const [mapa, clave, tope] of [
      [this.porUsuario, FrenoLogin.claveUsuario(usuarioId, ip), TOPE_USUARIO],
      [this.porIp, `i:${ip}`, TOPE_IP],
    ] as [Map<string, Contador>, string, number][]) {
      const previo = mapa.get(clave);
      // Vivo = todavía se recuerda su escalera, aunque el castigo haya vencido.
      const vivo = previo && previo.olvidar > ahora ? previo : null;
      // La ventana se corre en cada fallo: probar uno cada 4 minutos para
      // siempre no puede ser una forma de esquivar el tope.
      const fallos = (vivo && vivo.ventana > ahora ? vivo.fallos : 0) + 1;
      let rondas = vivo ? vivo.rondas : 0;
      let bloqueoHasta = vivo ? vivo.bloqueoHasta : 0;
      let enCurso = fallos;
      if (fallos >= tope) {
        // Tanda completa: se cobra la espera de ESTA ronda y la próxima arranca
        // de cero, con el castigo ya un escalón más arriba.
        rondas += 1;
        bloqueoHasta = ahora + FrenoLogin.espera(rondas);
        enCurso = 0;
      }
      const ventana = ahora + VENTANA_MS;
      mapa.set(clave, {
        fallos: enCurso,
        ventana,
        bloqueoHasta,
        rondas,
        olvidar: Math.max(bloqueoHasta, ventana) + MEMORIA_MS,
      });
      this.podar(mapa, ahora);
    }
  }

  /** Entró bien: la dupla usuario+origen queda limpia (la IP no, por las dudas). */
  exito(usuarioId: unknown, ip: string) {
    this.porUsuario.delete(FrenoLogin.claveUsuario(usuarioId, ip));
  }

  /** Barrido de registros olvidables, espaciado (ver `BARRIDO_CADA_MS`). */
  private barrer(ahora: number) {
    if (ahora - this.ultimoBarrido < BARRIDO_CADA_MS) return;
    this.ultimoBarrido = ahora;
    for (const mapa of [this.porUsuario, this.porIp]) {
      for (const [k, c] of mapa) if (c.olvidar <= ahora) mapa.delete(k);
    }
  }

  /** Techo duro de memoria: primero lo vencido, y si no alcanza, lo más viejo. */
  private podar(mapa: Map<string, Contador>, ahora: number) {
    if (mapa.size <= TOPE_REGISTROS) return;
    for (const [k, c] of mapa) if (c.olvidar <= ahora) mapa.delete(k);
    if (mapa.size <= TOPE_REGISTROS) return;
    const porEdad = [...mapa.entries()].sort((a, b) => a[1].olvidar - b[1].olvidar);
    for (const [k] of porEdad.slice(0, mapa.size - TOPE_REGISTROS)) mapa.delete(k);
  }
}
