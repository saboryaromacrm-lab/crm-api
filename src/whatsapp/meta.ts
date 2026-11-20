/**
 * EL BOT DE WHATSAPP · LA API DE META (0237, 19/11/2026)
 * ============================================================================
 * La API oficial de WhatsApp (Cloud API). Todo lo de Meta vive en variables de
 * entorno del servidor (Dokploy), nunca en la base ni en la pantalla:
 *   · WHATSAPP_TOKEN            el token permanente del usuario del sistema
 *   · WHATSAPP_PHONE_NUMBER_ID  el id del número (no el número)
 *   · WHATSAPP_APP_SECRET       el secreto de la app: firma los avisos
 *   · WHATSAPP_VERIFY_TOKEN     lo que se escribe al suscribir el webhook
 *   · WHATSAPP_GRAPH_VERSION    opcional (v23.0)
 * Sin ellas el bot no recibe ni manda nada real; el chat de prueba anda igual.
 */

export const META = {
  get token() { return (process.env.WHATSAPP_TOKEN || '').trim(); },
  get numeroId() { return (process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim(); },
  get secreto() { return (process.env.WHATSAPP_APP_SECRET || '').trim(); },
  get verificacion() { return (process.env.WHATSAPP_VERIFY_TOKEN || '').trim(); },
  get version() { return (process.env.WHATSAPP_GRAPH_VERSION || 'v23.0').trim(); },
  /** Puede mandar y recibir: las cuatro obligatorias cargadas. */
  get configurado() { return !!(this.token && this.numeroId && this.secreto && this.verificacion); },
};

async function llamar(cuerpo: Record<string, unknown>): Promise<any> {
  const r = await fetch(`https://graph.facebook.com/${META.version}/${META.numeroId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${META.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...cuerpo }),
    signal: AbortSignal.timeout(20_000),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Meta respondió ${r.status}${j?.error?.message ? `: ${String(j.error.message).slice(0, 200)}` : ''}`);
  return j;
}

/** Manda un texto; devuelve el id de Meta del mensaje. */
export async function enviarTexto(waId: string, texto: string): Promise<string> {
  const j = await llamar({ recipient_type: 'individual', to: waId, type: 'text', text: { body: texto, preview_url: true } });
  return String(j?.messages?.[0]?.id ?? '');
}

/** Lo marca leído y muestra «escribiendo…» mientras la IA piensa (si falla, no importa). */
export async function leidoYEscribiendo(metaId: string): Promise<void> {
  await llamar({ status: 'read', message_id: metaId, typing_indicator: { type: 'text' } }).catch(() => undefined);
}
