/**
 * DE DÓNDE LLEGA CADA VISITANTE (0194, 22/10/2026, pedido del dueño)
 * ============================================================================
 * El sitio manda, una vez por sesión, el SITIO que lo trajo (solo el dominio
 * del `document.referrer`, nunca la dirección completa), los `utm_*` de la
 * dirección de entrada y si vino de un clic de anuncio (gclid, ttclid) o de
 * Meta (fbclid: Instagram y Facebook lo agregan a TODO link, pago o no). Acá,
 * y solo acá, eso se vuelve un CANAL. Función pura: se prueba sin base.
 *
 * Orden de prioridad (el dato más explícito gana):
 *   1. clic de anuncio o utm_medium pago     → campaña paga
 *   2. utm_source (el link armado a propósito) → la red o el canal que dice
 *   3. el sitio que lo trajo                   → buscador, red, otro sitio
 *   4. nada                                    → directo
 * OJO, «directo» también es WhatsApp o la bio de Instagram cuando el link no
 * lleva `?utm_source=…`: esas apps casi nunca dicen de dónde viene la visita.
 */
export const CANALES = {
  campana: 'Campaña paga',
  buscadores: 'Buscadores',
  instagram: 'Instagram',
  facebook: 'Facebook',
  meta: 'Instagram o Facebook',
  whatsapp: 'WhatsApp',
  tiktok: 'TikTok',
  otras_redes: 'Otras redes',
  email: 'Correo',
  otros_sitios: 'Otros sitios',
  directo: 'Directo',
  interno: 'Otra pestaña de la tienda',
} as const;
export type Canal = keyof typeof CANALES;

export interface DatosLlegada {
  /** El dominio que lo trajo (sin www), vacío si no vino de ningún sitio. */
  referente?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  /** Vino de un clic de anuncio: 'google' (gclid) o 'tiktok' (ttclid). */
  clic?: string;
  /** El link traía `fbclid`: vino de Instagram o Facebook (no dice cuál ni si fue pago). */
  meta?: boolean;
  /** El dominio de la tienda: un referente propio es otra pestaña, no un origen. */
  propio?: string;
}

const limpio = (v: unknown, max = 80) => String(v ?? '').trim().toLowerCase().slice(0, max);
/** El host tal cual (sin protocolo, camino, puerto ni «www.»). */
const host = (v: unknown) => limpio(v, 120).replace(/^https?:\/\//, '').split(/[/?#:]/)[0].replace(/^www\./, '');
/** Solo el dominio; lo que no parece un dominio se descarta. */
export const dominio = (v: unknown) => {
  const s = host(v);
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s) ? s : '';
};
const es = (host: string, ...dominios: string[]) => dominios.some((d) => host === d || host.endsWith(`.${d}`));

const PAGOS = new Set(['cpc', 'ppc', 'paid', 'paid_social', 'paidsocial', 'ads', 'ad', 'display', 'cpm']);
const BUSCADORES = ['google.com', 'google.com.ar', 'bing.com', 'yahoo.com', 'duckduckgo.com', 'ecosia.org', 'search.brave.com', 'yandex.com'];

/** El canal de una fuente nombrada (utm_source o el host). */
function canalDeNombre(n: string): Canal | null {
  if (/instagram|^ig$/.test(n)) return 'instagram';
  if (/facebook|^fb$|messenger/.test(n)) return 'facebook';
  if (/whatsapp|^wa$|^wsp$|^wpp$|^wa\.me$/.test(n)) return 'whatsapp';
  if (/tiktok/.test(n)) return 'tiktok';
  if (/twitter|^x$|^t\.co$|linkedin|youtube|pinterest|threads|telegram/.test(n)) return 'otras_redes';
  if (/google|bing|yahoo|duckduckgo|ecosia/.test(n)) return 'buscadores';
  if (/mail|newsletter/.test(n)) return 'email';
  return null;
}

/** El canal y el detalle (sitio o campaña) que se guardan con la llegada. */
export function clasificarLlegada(d: DatosLlegada): { origen: Canal; detalle: string } {
  /* La propia tienda (también en un host sin dominio, como localhost): otra pestaña, no un origen. */
  const crudo = host(d.referente);
  if (crudo && crudo === host(d.propio)) return { origen: 'interno', detalle: '' };
  const sitio = dominio(d.referente);
  const propio = dominio(d.propio);
  const fuente = limpio(d.utmSource, 60);
  const medio = limpio(d.utmMedium, 60);
  const campana = limpio(d.utmCampaign, 60);
  const clic = limpio(d.clic, 20);
  const detalleDe = (...partes: string[]) => partes.filter(Boolean).join(' · ').slice(0, 120);

  if (clic || PAGOS.has(medio)) return { origen: 'campana', detalle: detalleDe(fuente || clic || sitio, campana) };
  if (fuente) {
    const canal = canalDeNombre(fuente) ?? (medio === 'email' ? 'email' : 'otros_sitios');
    return { origen: canal, detalle: detalleDe(fuente, campana) };
  }
  if (medio === 'email') return { origen: 'email', detalle: detalleDe(sitio, campana) };
  if (!sitio) return d.meta ? { origen: 'meta', detalle: '' } : { origen: 'directo', detalle: '' };
  if (propio && (sitio === propio || sitio.endsWith(`.${propio}`) || propio.endsWith(`.${sitio}`))) return { origen: 'interno', detalle: '' };
  if (es(sitio, ...BUSCADORES) || /^google\./.test(sitio)) return { origen: 'buscadores', detalle: sitio };
  if (es(sitio, 'instagram.com')) return { origen: 'instagram', detalle: sitio };
  if (es(sitio, 'facebook.com', 'fb.com', 'messenger.com')) return { origen: 'facebook', detalle: sitio };
  if (es(sitio, 'whatsapp.com', 'wa.me')) return { origen: 'whatsapp', detalle: sitio };
  if (es(sitio, 'tiktok.com')) return { origen: 'tiktok', detalle: sitio };
  if (es(sitio, 't.co', 'twitter.com', 'x.com', 'linkedin.com', 'lnkd.in', 'youtube.com', 'pinterest.com', 'threads.net', 'telegram.org', 't.me')) return { origen: 'otras_redes', detalle: sitio };
  if (/mail\./.test(sitio) || es(sitio, 'outlook.live.com')) return { origen: 'email', detalle: sitio };
  return { origen: 'otros_sitios', detalle: sitio };
}
