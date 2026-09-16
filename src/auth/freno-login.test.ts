/**
 * EL FRENO DEL LOGIN, QUE ES LO ÚNICO QUE PROTEGE UN PIN DE 4 DÍGITOS.
 *
 * Desde el 16/9 la contraseña puede ser un PIN (`MIN_PASSWORD = 4`), o sea
 * 10.000 combinaciones: el largo dejó de ser la defensa y pasó a serlo esta
 * clase. Por eso sus reglas están acá escritas como pruebas y no solo como
 * comentarios — un cambio que rompa la escalera de esperas deja el sistema
 * abierto a fuerza bruta sin que nada se vea roto en pantalla.
 *
 * El reloj se controla a mano: la escalera se mide en decenas de minutos y una
 * prueba no puede esperarlos.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { FrenoLogin } from './freno-login';

const MIN = 60_000;
const relojReal = Date.now;
let ahora = 1_700_000_000_000;
Date.now = () => ahora;
after(() => { Date.now = relojReal; });

const avanzar = (ms: number) => { ahora += ms; };

/** ¿Está frenado ahora mismo? (`revisar` lanza 429 cuando lo está). */
function frenado(f: FrenoLogin, usuarioId: number, ip: string) {
  try {
    f.revisar(usuarioId, ip);
    return false;
  } catch {
    return true;
  }
}

/** Gasta una tanda entera de fallos contra la misma dupla usuario+origen. */
function tanda(f: FrenoLogin, usuarioId: number, ip: string, cuantos = 5) {
  for (let i = 0; i < cuantos; i += 1) f.fallo(usuarioId, ip);
}

/** Cuántos minutos faltan para que se libere, probando el reloj hacia adelante. */
function minutosDeCastigo(f: FrenoLogin, usuarioId: number, ip: string, techo = 180) {
  for (let m = 1; m <= techo; m += 1) {
    avanzar(MIN);
    if (!frenado(f, usuarioId, ip)) return m;
  }
  return Infinity;
}

test('cinco fallos frenan la dupla usuario+origen', () => {
  const f = new FrenoLogin();
  assert.equal(frenado(f, 1, '1.1.1.1'), false, 'no tendría que arrancar frenado');
  tanda(f, 1, '1.1.1.1', 4);
  assert.equal(frenado(f, 1, '1.1.1.1'), false, 'con 4 fallos todavía puede intentar');
  f.fallo(1, '1.1.1.1');
  assert.equal(frenado(f, 1, '1.1.1.1'), true, 'el quinto fallo tiene que frenar');
});

test('la espera CRECE en cada tanda: 5, 15, 45 y topa en 60 minutos', () => {
  const f = new FrenoLogin();
  tanda(f, 1, '9.9.9.9');
  assert.equal(minutosDeCastigo(f, 1, '9.9.9.9'), 5, 'la primera tanda son 5 minutos');
  tanda(f, 1, '9.9.9.9');
  assert.equal(minutosDeCastigo(f, 1, '9.9.9.9'), 15, 'la segunda tiene que triplicar');
  tanda(f, 1, '9.9.9.9');
  assert.equal(minutosDeCastigo(f, 1, '9.9.9.9'), 45, 'la tercera vuelve a triplicar');
  tanda(f, 1, '9.9.9.9');
  assert.equal(minutosDeCastigo(f, 1, '9.9.9.9'), 60, 'la cuarta topa en una hora');
  tanda(f, 1, '9.9.9.9');
  assert.equal(minutosDeCastigo(f, 1, '9.9.9.9'), 60, 'y de ahí en más se queda en el techo');
});

test('esperar a que venza el castigo NO devuelve el contador a cero', () => {
  /*
   * La mitad que hace funcionar a la otra. Si la escalera se olvidara al
   * vencer el bloqueo, el atacante tendría cinco intentos cada cinco minutos
   * PARA SIEMPRE: 1.440 por día, y las 10.000 del PIN caen en menos de una
   * semana. Es exactamente el agujero que tenía el freno viejo.
   */
  const f = new FrenoLogin();
  tanda(f, 1, '9.9.9.9');
  avanzar(6 * MIN);
  assert.equal(frenado(f, 1, '9.9.9.9'), false, 'pasados los 5 minutos puede volver a intentar');
  tanda(f, 1, '9.9.9.9');
  assert.equal(minutosDeCastigo(f, 1, '9.9.9.9'), 15, 'la segunda tanda ya cuesta 15, no 5');
});

test('entrar bien borra la escalera del que se equivocó', () => {
  const f = new FrenoLogin();
  tanda(f, 3, '1.1.1.1');            // la cajera se equivocó cinco veces
  avanzar(6 * MIN);
  f.exito(3, '1.1.1.1');             // y a la sexta entró
  tanda(f, 3, '1.1.1.1');            // otro día se vuelve a equivocar
  assert.equal(minutosDeCastigo(f, 3, '1.1.1.1'), 5, 'tiene que arrancar de cero otra vez');
});

test('el castigo es del ORIGEN: un extraño no puede dejar afuera a la cajera', () => {
  /*
   * La razón de que la clave lleve la IP. Con el contador global, machacar el
   * id del dueño desde internet lo dejaba bloqueado un lunes a la mañana con
   * la caja sin abrir, gratis y sin sesión.
   */
  const f = new FrenoLogin();
  tanda(f, 1, '200.200.200.200');
  assert.equal(frenado(f, 1, '200.200.200.200'), true, 'el atacante sí queda frenado');
  assert.equal(frenado(f, 1, '1.1.1.1'), false, 'el mismo usuario desde el local tiene que poder entrar');
});

test('la IP también se frena aunque pruebe contra usuarios distintos', () => {
  // El otro ataque: `1234` contra los siete usuarios, uno por uno. Frenar por
  // usuario no lo detendría, porque nunca insiste con el mismo.
  const f = new FrenoLogin();
  for (let u = 1; u <= 20; u += 1) f.fallo(u, '8.8.8.8');
  assert.equal(frenado(f, 99, '8.8.8.8'), true, 'a los 20 fallos la IP queda frenada');
  assert.equal(frenado(f, 99, '7.7.7.7'), false, 'y solo esa IP');
});

test('después de horas sin insistir, el registro se olvida y se arranca de cero', () => {
  const f = new FrenoLogin();
  tanda(f, 1, '9.9.9.9');
  tanda(f, 1, '9.9.9.9');            // dos tandas: la próxima costaría 45
  avanzar(24 * 60 * MIN);            // un día entero sin intentar
  assert.equal(frenado(f, 1, '9.9.9.9'), false, 'el castigo ya venció');
  tanda(f, 1, '9.9.9.9');
  assert.equal(minutosDeCastigo(f, 1, '9.9.9.9'), 5, 'con la memoria vencida vuelve al primer escalón');
});
