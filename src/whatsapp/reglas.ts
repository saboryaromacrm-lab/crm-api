/**
 * EL BOT DE WHATSAPP · LAS REGLAS (0237, 19/11/2026)
 * ============================================================================
 * Lo que no toca la base ni la red: la configuración y su saneo, leer el aviso
 * de Meta, la firma, la búsqueda en el catálogo y el formato de WhatsApp. Puro,
 * para probarlo sin nada alrededor.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { telefonoArgentino } from '../common/telefono';

/* ============================== LA CONFIGURACIÓN ============================== */

export const MODELOS_BOT = ['claude-haiku-5-5', 'claude-sonnet-5-5'] as const;
export type ModeloBot = (typeof MODELOS_BOT)[number];

export const INSTRUCCIONES_INICIALES = `Atendés el WhatsApp de ventas de Sabor y Aroma: dietética y almacén natural, con venta minorista en los locales y por la tienda online, y venta mayorista a comercios.

Cómo atender:
- Trato cercano y de vos, como un vendedor del local que conoce la mercadería. Sin vueltas.
- Si preguntan por un producto, buscalo y decí precio, presentaciones y si hay. Si no lo tenemos, ofrecé lo más parecido que sí haya.
- Sugerí con criterio: una oferta vigente relacionada o el tamaño que conviene (el de mejor precio por kilo), sin insistir.
- Para comprar: pueden hacer el pedido en la tienda online (pasá el link del producto) o acercarse a un local.
- Si alguien quiere comprar por mayor y no está verificado, pedile el DNI con el que se registró en la tienda mayorista; si no se registró, que pida el ingreso en la tienda.`;

export type NumeroSinIa = { numero: string; nombre: string };

export const BOT_DEFAULTS = {
  /** Contesta los WhatsApp reales (el chat de prueba anda siempre). */
  activo: false,
  modelo: 'claude-haiku-5-5' as ModeloBot,
  /** Lo que escribe el dueño: el tono, cómo vender, lo que hay que saber. */
  instrucciones: INSTRUCCIONES_INICIALES,
  /** El personal, proveedores…: la IA no les contesta nunca. */
  numerosSinIa: [] as NumeroSinIa[],
  /** Cuando contesta una persona (o el bot deriva), la IA se calla en esa charla estas horas. */
  horasPausaHumano: 12,
  /** Tope de gasto de IA del mes (dólares): llegado ahí, deriva todo a una persona. */
  topeGastoMesUsd: 30,
  linkTienda: 'https://tiendaonline.saboryaroma.com',
};
export type ConfigBot = typeof BOT_DEFAULTS;

const MAX_INSTRUCCIONES = 12_000;
const MAX_NUMEROS = 300;

/** El número para comparar: 10 dígitos si es argentino; si no, solo sus dígitos (8 a 15), o ''. */
export function numeroDe(v: unknown): string {
  const ar = telefonoArgentino(String(v ?? ''));
  if (ar) return ar;
  const d = String(v ?? '').replace(/\D/g, '');
  return d.length >= 8 && d.length <= 15 ? d : '';
}

const entre = (v: unknown, min: number, max: number, def: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

/** Normaliza (no rechaza): corre también al leer, un valor viejo no puede tirar la pantalla. */
export function sanitizarConfig(crudo: any): ConfigBot {
  const c = crudo && typeof crudo === 'object' ? crudo : {};
  const vistos = new Set<string>();
  const numerosSinIa: NumeroSinIa[] = [];
  for (const x of Array.isArray(c.numerosSinIa) ? c.numerosSinIa : []) {
    const numero = numeroDe(x?.numero);
    if (!numero || vistos.has(numero) || numerosSinIa.length >= MAX_NUMEROS) continue;
    vistos.add(numero);
    numerosSinIa.push({ numero, nombre: String(x?.nombre ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) });
  }
  const link = String(c.linkTienda ?? BOT_DEFAULTS.linkTienda).trim().replace(/\/+$/, '');
  return {
    activo: c.activo === true,
    modelo: (MODELOS_BOT as readonly string[]).includes(c.modelo) ? c.modelo : BOT_DEFAULTS.modelo,
    instrucciones: typeof c.instrucciones === 'string' ? c.instrucciones.slice(0, MAX_INSTRUCCIONES) : BOT_DEFAULTS.instrucciones,
    numerosSinIa,
    horasPausaHumano: Math.round(entre(c.horasPausaHumano, 1, 72, BOT_DEFAULTS.horasPausaHumano)),
    topeGastoMesUsd: Math.round(entre(c.topeGastoMesUsd, 1, 1000, BOT_DEFAULTS.topeGastoMesUsd)),
    linkTienda: /^https?:\/\/[^\s]+$/.test(link) ? link : BOT_DEFAULTS.linkTienda,
  };
}

/* ============================== EL AVISO DE META ============================== */

/**
 * LA FIRMA: Meta firma el cuerpo CRUDO con el secreto de la app
 * (`X-Hub-Signature-256: sha256=<hex>`). Sin firma válida, el aviso no existe.
 */
export function firmaMetaValida(crudo: Buffer | undefined, cabecera: unknown, secreto: string): boolean {
  if (!crudo || !secreto) return false;
  const m = /^sha256=([a-f0-9]{64})$/i.exec(String(cabecera ?? ''));
  if (!m) return false;
  const esperado = createHmac('sha256', secreto).update(crudo).digest();
  const recibido = Buffer.from(m[1], 'hex');
  return recibido.length === esperado.length && timingSafeEqual(recibido, esperado);
}

export type Entrante = { waId: string; nombre: string; metaId: string; texto: string };
export type Eco = { waId: string; metaId: string; texto: string };

const LO_QUE_NO_SE_LEE: Record<string, string> = {
  audio: '[mandó un audio]', voice: '[mandó un audio]', image: '[mandó una foto]', video: '[mandó un video]',
  document: '[mandó un archivo]', sticker: '[mandó un sticker]', location: '[mandó una ubicación]', contacts: '[mandó un contacto]',
};

/** El texto de un mensaje de WhatsApp: lo escrito, el botón tocado, o qué mandó si no es texto. */
export function textoDeMensaje(m: any): string {
  const t = String(m?.type ?? '');
  if (t === 'text') return String(m?.text?.body ?? '').trim();
  if (t === 'button') return String(m?.button?.text ?? '').trim();
  if (t === 'interactive') {
    const i = m?.interactive ?? {};
    return String(i.button_reply?.title ?? i.list_reply?.title ?? '').trim();
  }
  const pie = String(m?.[t]?.caption ?? '').trim();
  return `${LO_QUE_NO_SE_LEE[t] ?? '[mandó algo que no es texto]'}${pie ? ` ${pie}` : ''}`;
}

/**
 * Lo que trae un aviso: los mensajes de clientes y los ECOS (lo que alguien del
 * local mandó desde la app del celular, con la «coexistencia»). Los estados
 * (enviado, leído) no interesan. Lo que no tiene forma esperada se descarta.
 */
export function leerAviso(cuerpo: any): { entrantes: Entrante[]; ecos: Eco[] } {
  const entrantes: Entrante[] = [];
  const ecos: Eco[] = [];
  for (const entrada of Array.isArray(cuerpo?.entry) ? cuerpo.entry : []) {
    for (const cambio of Array.isArray(entrada?.changes) ? entrada.changes : []) {
      const v = cambio?.value ?? {};
      const nombres = new Map<string, string>(
        (Array.isArray(v.contacts) ? v.contacts : []).map((c: any) => [String(c?.wa_id ?? ''), String(c?.profile?.name ?? '')]),
      );
      for (const m of Array.isArray(v.messages) ? v.messages : []) {
        const waId = String(m?.from ?? '').replace(/\D/g, '');
        const metaId = String(m?.id ?? '');
        if (!waId || !metaId) continue;
        entrantes.push({ waId, nombre: (nombres.get(waId) ?? '').slice(0, 80), metaId, texto: textoDeMensaje(m).slice(0, 4000) });
      }
      for (const m of Array.isArray(v.message_echoes) ? v.message_echoes : []) {
        const waId = String(m?.to ?? '').replace(/\D/g, '');
        const metaId = String(m?.id ?? '');
        if (!waId || !metaId) continue;
        ecos.push({ waId, metaId, texto: textoDeMensaje(m).slice(0, 4000) });
      }
    }
  }
  return { entrantes, ecos };
}

/* ============================== LA CHARLA ============================== */

/** Tras estas horas sin hablar, la conversación con la IA arranca de nuevo (no arrastra el pedido de ayer). */
export const HORAS_SESION = 12;
export const sesionVencida = (ultimo: Date | null, ahora: Date) =>
  !ultimo || ahora.getTime() - ultimo.getTime() > HORAS_SESION * 3_600_000;

/**
 * DE MARKDOWN A WHATSAPP: la IA a veces escribe **negrita** o títulos con #;
 * WhatsApp usa *negrita* y no tiene títulos. Las tablas no existen: no se piden.
 */
export function aWhatsapp(t: string): string {
  return t
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '_$1_')
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1: $2')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** WhatsApp corta en 4096: lo largo se parte en párrafos (casi nunca pasa: se pide corto). */
export function partir(t: string, max = 4000): string[] {
  const partes: string[] = [];
  let resto = t.trim();
  while (resto.length > max) {
    const corte = Math.max(resto.lastIndexOf('\n', max), resto.lastIndexOf(' ', max));
    const i = corte > max / 2 ? corte : max;
    partes.push(resto.slice(0, i).trim());
    resto = resto.slice(i).trim();
  }
  if (resto) partes.push(resto);
  return partes;
}

/* ============================== LA BÚSQUEDA ============================== */

/** Minúsculas y sin acentos: «Maní» = «mani». */
export const normalizar = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** «Maní tostado 1 kg» → «mani-tostado-1-kg»: la misma regla que el sitio (`saboryaroma-web/src/lib/rutas.ts`). */
export const slug = (s: string) => normalizar(s).replace(/[^a-z0-9]+/g, '-').slice(0, 80).replace(/^-+|-+$/g, '');

/** Las palabras que cuentan para buscar (sin las de una letra y sin «de», «con»…). */
const VACIAS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'con', 'sin', 'y', 'en', 'x', 'por', 'para', 'un', 'una']);
export const palabras = (t: string) => normalizar(t).split(/[^a-z0-9ñ]+/).filter((p) => p.length > 1 && !VACIAS.has(p));

type Buscable = { nombre: string; marca?: string; categoria?: string; subcategoria?: string; etiquetas?: { nombre: string }[] };

/**
 * Qué tan bien coincide un producto: cuántas palabras buscadas aparecen y un
 * puntaje (el nombre pesa más que la marca o la categoría). Tolera el plural
 * simple («almendras» encuentra «almendra»).
 */
export function coincidencia(it: Buscable, buscadas: string[]): { aciertos: number; puntos: number } {
  const nombre = normalizar(it.nombre);
  const resto = normalizar([it.marca, it.categoria, it.subcategoria, ...(it.etiquetas ?? []).map((e) => e.nombre)].join(' '));
  let aciertos = 0;
  let puntos = 0;
  for (const p of buscadas) {
    const raiz = p.length > 4 ? p.replace(/(es|s)$/, '') : p;
    if (nombre.includes(raiz)) { aciertos += 1; puntos += 2; } else if (resto.includes(raiz)) { aciertos += 1; puntos += 1; }
  }
  return { aciertos, puntos };
}

/**
 * Los que mejor coinciden: primero los que tienen TODAS las palabras; si no
 * hay ninguno, los que tienen más (así «yerba suave sin palo» igual encuentra
 * yerbas). Los que hay antes que los agotados.
 */
export function buscarEn<T extends Buscable & { enStock?: boolean }>(items: T[], texto: string, limite: number): T[] {
  const buscadas = palabras(texto);
  if (!buscadas.length) return [];
  const conPuntaje = items.map((it) => ({ it, ...coincidencia(it, buscadas) })).filter((x) => x.aciertos > 0);
  const todas = conPuntaje.filter((x) => x.aciertos === buscadas.length);
  return (todas.length ? todas : conPuntaje)
    .sort((a, b) => b.aciertos - a.aciertos || b.puntos - a.puntos || Number(!!b.it.enStock) - Number(!!a.it.enStock)
      || a.it.nombre.length - b.it.nombre.length)
    .slice(0, limite)
    .map((x) => x.it);
}
