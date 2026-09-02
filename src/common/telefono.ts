/**
 * Teléfono argentino normalizado a área + abonado (10 dígitos), o '' si no
 * llega. Misma regla que el checkout del sitio (`saboryaroma-web/src/lib/format.ts`)
 * y que el link de WhatsApp del CRM (`telefonoWa`): tolera cómo escribe la
 * gente — `+54`, el `9` de celular, el `0` de larga distancia y el viejo `15`
 * (0370 15 4123456). Está duplicada en los tres proyectos a propósito: son
 * procesos distintos; si cambia una, tienen que cambiar las tres.
 */
export function telefonoArgentino(tel: string): string {
  let d = String(tel ?? '').replace(/\D/g, '');
  if (d.startsWith('54')) d = d.slice(2);
  if (d.startsWith('0')) d = d.slice(1);
  if (d.startsWith('9')) d = d.slice(1);
  d = d.replace(/^(\d{2,4})15(\d{6,8})$/, '$1$2');
  return d.length === 10 ? d : '';
}
