/**
 * ASESOR COMERCIAL · LAS FECHAS COMERCIALES (0193)
 * ============================================================================
 * Las fechas que mueven la venta en Argentina, calculadas para cualquier año
 * (las que se corren, como el tercer domingo de octubre, también). Las que no
 * tienen regla fija (Hot Sale, CyberMonday, vuelta a clases, vacaciones de
 * invierno) van como «aprox»: la fecha real la confirma el dueño (y puede
 * cargar la suya en «Tus fechas»). Los feriados oficiales salen de la tabla
 * de feriados; las fechas propias, de `asesor_fechas`.
 * Funciones puras: se prueban sin base (calendario.test.ts).
 */
export interface FechaComercial { fecha: string; nombre: string; aprox: boolean; nota: string }

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** El n-ésimo `dow` (0 = domingo … 6 = sábado) de un mes. */
export function nesimo(y: number, mes: number, dow: number, n: number): string {
  const primero = new Date(Date.UTC(y, mes - 1, 1)).getUTCDay();
  return iso(y, mes, 1 + ((dow - primero + 7) % 7) + (n - 1) * 7);
}

/** El último `dow` de un mes. */
export function ultimo(y: number, mes: number, dow: number): string {
  const fin = new Date(Date.UTC(y, mes, 0));
  const d = fin.getUTCDate() - ((fin.getUTCDay() - dow + 7) % 7);
  return iso(y, mes, d);
}

/** Domingo de Pascua (algoritmo anónimo gregoriano). */
export function pascua(y: number): string {
  const a = y % 19; const b = Math.floor(y / 100); const c = y % 100;
  const d = Math.floor(b / 4); const e = b % 4; const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3); const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4); const k = c % 4; const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31); const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(y, mes, dia);
}

const sumarDias = (d: string, n: number) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

export function fechasComerciales(y: number): FechaComercial[] {
  const pas = pascua(y);
  /* Black Friday: el día después del cuarto jueves de noviembre (Acción de Gracias). */
  const blackFriday = sumarDias(nesimo(y, 11, 4, 4), 1);
  const f = (fecha: string, nombre: string, nota: string, aprox = false): FechaComercial => ({ fecha, nombre, aprox, nota });
  return [
    f(iso(y, 2, 14), 'San Valentín', 'Regalos, chocolates, desayunos.'),
    f(iso(y, 3, 1), 'Vuelta a clases', 'Meriendas, colaciones, viandas. La fecha real depende del calendario escolar de Formosa.', true),
    f(iso(y, 3, 8), 'Día de la Mujer', 'Regalos chicos, flores, chocolates.'),
    f(pas, 'Pascuas', 'Huevos y roscas de Pascua; la semana anterior es la fuerte (Semana Santa: pescado, frutos secos).'),
    f(nesimo(y, 5, 1, 2), 'Hot Sale', 'Tres días de descuentos online (lunes a miércoles). Confirmá la fecha oficial.', true),
    f(nesimo(y, 6, 0, 3), 'Día del Padre', 'Regalos, picadas, bebidas, frutos secos.'),
    f(iso(y, 6, 30), 'Cobro de aguinaldo (junio)', 'Más plata en la calle los días siguientes.', true),
    f(iso(y, 7, 15), 'Vacaciones de invierno', 'Dos semanas: chicos en casa, meriendas. Confirmá el calendario escolar.', true),
    f(iso(y, 7, 20), 'Día del Amigo', 'Juntadas: picadas, bebidas, snacks.'),
    f(nesimo(y, 8, 0, 3), 'Día de las Infancias', 'Golosinas, chocolates, regalos chicos.'),
    f(iso(y, 9, 21), 'Día de la Primavera y del Estudiante', 'Picnics, bebidas, snacks.'),
    f(nesimo(y, 10, 0, 3), 'Día de la Madre', 'La fecha de regalos más fuerte después de Navidad.'),
    f(nesimo(y, 11, 1, 1), 'CyberMonday', 'Tres días de descuentos online (lunes a miércoles). Confirmá la fecha oficial.', true),
    f(blackFriday, 'Black Friday', 'Descuentos fuertes, sobre todo online.'),
    f(iso(y, 12, 18), 'Cobro de aguinaldo (diciembre)', 'Arranca el consumo de las fiestas.', true),
    f(iso(y, 12, 24), 'Nochebuena y Navidad', 'Frutos secos, pan dulce, budines, sidras, canastas navideñas: la más fuerte del año.'),
    f(iso(y, 12, 31), 'Fin de año', 'Brindis, picadas, frutos secos.'),
  ];
}

/** Las fechas comerciales de hoy a `dias` adelante (cruza el año), con cuántos días faltan. */
export function proximasFechas(hoy: string, dias: number): (FechaComercial & { faltan: number })[] {
  const y = Number(hoy.slice(0, 4));
  const hasta = sumarDias(hoy, dias);
  const faltan = (d: string) => Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${hoy}T00:00:00Z`)) / 86_400_000);
  return [...fechasComerciales(y), ...fechasComerciales(y + 1)]
    .filter((x) => x.fecha >= hoy && x.fecha <= hasta)
    .map((x) => ({ ...x, faltan: faltan(x.fecha) }));
}

/** La misma fecha comercial el año anterior (por nombre): para ver cómo se vendió. */
export function mismaFechaAnioAnterior(nombre: string, anio: number): string | null {
  return fechasComerciales(anio - 1).find((x) => x.nombre === nombre)?.fecha ?? null;
}
