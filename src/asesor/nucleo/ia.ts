/**
 * LOS ASESORES · LA IA (0193)
 * ============================================================================
 * Con la librería oficial de Anthropic. La clave es la misma de la lectura de
 * facturas (`ANTHROPIC_API_KEY`, solo en el servidor). El modelo: Claude Opus
 * 5.5, o el de `ANTHROPIC_MODELO_ASESOR`. Si Claude declina una consulta, la API
 * la reintenta sola con otro modelo (respaldo del servidor, `fallbacks`).
 *
 *   · analizar: UNA llamada con la foto entera; la respuesta sale con FORMATO
 *     FIJO (el JSON Schema del especialista), así la pantalla sabe qué mostrar.
 *   · responder: la conversación; la IA llama a las herramientas del
 *     especialista (solo lectura) hasta tener los números, y contesta. Cada
 *     turno se guarda TAL CUAL lo devolvió la API y se reenvía sin tocar.
 */
import Anthropic from '@anthropic-ai/sdk';
import { IA } from '../../facturas/ia/anthropic';
import { costoUsd } from '../../facturas/ia/precios';
import type { Especialidad } from './especialidad';

export const MODELO_ASESOR = () => (process.env.ANTHROPIC_MODELO_ASESOR || 'claude-opus-5-5').trim();
/** El respaldo del servidor cuando Claude declina (elige el modelo según el motivo). */
const RESPALDO = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const };

export type Uso = { entrada: number; salida: number; cacheEscritura: number; cacheLectura: number };
export type Llamada = { modelo: string; uso: Uso; costo: number };

export class ErrorAsesor extends Error {
  constructor(mensaje: string, readonly llamada: Llamada | null = null) { super(mensaje); }
}

let cliente: Anthropic | null = null;
function ia(): Anthropic {
  if (!IA.configurado) throw new ErrorAsesor('El asesor no está configurado: falta la clave de la IA (ANTHROPIC_API_KEY) en el servidor.');
  cliente ??= new Anthropic({ apiKey: IA.clave, baseURL: IA.base, maxRetries: 2, timeout: 10 * 60 * 1000 });
  return cliente;
}

/** Los errores de la API, dichos para el dueño (por tipo, nunca por el texto). */
function explicar(e: unknown): ErrorAsesor {
  if (e instanceof ErrorAsesor) return e;
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return new ErrorAsesor('La clave de la IA no es válida o está dada de baja. Revisá ANTHROPIC_API_KEY en Dokploy.');
  if (e instanceof Anthropic.RateLimitError) return new ErrorAsesor('La IA está recibiendo demasiados pedidos: probá de nuevo en un rato.');
  if (e instanceof Anthropic.APIConnectionError) return new ErrorAsesor('No se pudo conectar con la IA (¿sin internet en el servidor?). Probá de nuevo en un rato.');
  if (e instanceof Anthropic.InternalServerError) return new ErrorAsesor('La IA está saturada o caída en este momento: probá de nuevo en un rato.');
  if (e instanceof Anthropic.BadRequestError) {
    const msg = String((e.error as any)?.error?.message ?? '');
    if (/billing|credit/i.test(msg)) return new ErrorAsesor('La cuenta de Anthropic se quedó sin saldo: cargá crédito en platform.claude.com.');
    /* El motivo técnico va al final, recortado: sin él no hay cómo saber qué arreglar. */
    return new ErrorAsesor(`La IA rechazó el pedido${msg ? ` (${msg.slice(0, 200)})` : ''}.`);
  }
  if (e instanceof Anthropic.APIError) return new ErrorAsesor(`La IA devolvió un error (${e.status ?? 'sin estado'}).`);
  return new ErrorAsesor(String((e as Error)?.message ?? e).slice(0, 300));
}

function llamada(r: Anthropic.Beta.BetaMessage): Llamada {
  const u = r.usage;
  const uso: Uso = {
    entrada: u.input_tokens ?? 0, salida: u.output_tokens ?? 0,
    cacheEscritura: u.cache_creation_input_tokens ?? 0, cacheLectura: u.cache_read_input_tokens ?? 0,
  };
  return { modelo: r.model, uso, costo: costoUsd(r.model, uso) };
}

/* ============================== LO QUE EL DUEÑO YA DIJO ============================== */

export interface Contexto {
  /** La ficha de este especialista. */
  ficha: string;
  /** La ficha general del negocio (la del asesor de negocio), si este especialista es otro. */
  fichaNegocio?: string;
  aprendizajes: string[];
  opiniones: { titulo: string; area: string; valor: string; nota: string; fecha: string }[];
}

const bloqueContexto = (x: Contexto) => [
  ...(x.fichaNegocio?.trim() ? [`<ficha_general_del_negocio>\n${x.fichaNegocio.trim()}\n</ficha_general_del_negocio>`] : []),
  `<ficha_del_duenio>\n${x.ficha.trim() || '(El dueño todavía no escribió nada para vos.)'}\n</ficha_del_duenio>`,
  `<lo_que_ya_sabes>\n${x.aprendizajes.length ? x.aprendizajes.map((a) => `- ${a}`).join('\n') : '(Nada todavía.)'}\n</lo_que_ya_sabes>`,
  `<opiniones_del_duenio_sobre_alertas_anteriores>\n${x.opiniones.length ? JSON.stringify(x.opiniones) : '(Ninguna todavía.)'}\n</opiniones_del_duenio_sobre_alertas_anteriores>`,
].join('\n\n');

/* ============================== EL INFORME ============================== */

export async function analizar(esp: Especialidad, o: { foto: unknown; senales: unknown; contexto: Contexto; enfoque: string }): Promise<{ informe: any; llamada: Llamada }> {
  const mensaje = [
    bloqueContexto(o.contexto),
    `<senales_del_sistema>\n${JSON.stringify(o.senales)}\n</senales_del_sistema>`,
    `<foto_del_negocio>\n${JSON.stringify(o.foto)}\n</foto_del_negocio>`,
    o.enfoque.trim()
      ? `El dueño pidió que mires especialmente: «${o.enfoque.trim()}». Respondé eso primero, sin dejar afuera lo urgente.`
      : 'Hacé el análisis completo.',
    esp.pedidoInforme,
  ].join('\n\n');
  let r: Anthropic.Beta.BetaMessage;
  try {
    r = await ia().beta.messages.stream({
      model: MODELO_ASESOR(),
      max_tokens: 32000,
      system: esp.quienEs,
      messages: [{ role: 'user', content: mensaje }],
      output_config: { effort: 'high', format: { type: 'json_schema', schema: esp.esquemaInforme } },
      ...RESPALDO,
    }).finalMessage();
  } catch (e) { throw explicar(e); }
  const ll = llamada(r);
  if (r.stop_reason === 'refusal') throw new ErrorAsesor('La IA no quiso hacer este análisis.', ll);
  if (r.stop_reason === 'max_tokens') throw new ErrorAsesor('El informe salió tan largo que no entró entero. Probá de nuevo con un enfoque más acotado.', ll);
  const texto = r.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('');
  try {
    return { informe: JSON.parse(texto), llamada: ll };
  } catch {
    throw new ErrorAsesor('La IA devolvió algo que no se pudo leer.', ll);
  }
}

/* ============================== LAS PREGUNTAS ============================== */

/**
 * El sistema de las preguntas. `analisis`: la conversación nació desde un
 * análisis (0198) y la IA lo recibe ENTERO; si no, solo el resumen del último.
 */
export function sistemaPreguntas(esp: Especialidad, x: Contexto & {
  hoy: string; sucursales: { id: number; nombre: string }[]; ultimoInforme: string; analisis?: string;
}) {
  return `${esp.quienEs}

Ahora el dueño te hace preguntas. Para responder con números usás las herramientas: consultan el sistema en el momento y son de solo lectura. Nunca supongas un número que podés consultar; si una herramienta no tiene el dato, decilo. Si la pregunta es ambigua (qué período, qué local), elegí lo razonable, decí qué elegiste y respondé. Respuestas cortas y al grano: primero la respuesta, después el detalle que la sostiene; tablas chicas en markdown solo si ayudan. ${esp.enPreguntas}

Hoy es ${x.hoy}. Sucursales activas (id: nombre): ${x.sucursales.map((s) => `${s.id}: ${s.nombre}`).join(', ')}.

${bloqueContexto(x)}

${x.analisis
    ? `<analisis_sobre_el_que_te_pregunta>
${x.analisis}
</analisis_sobre_el_que_te_pregunta>

El dueño te repregunta sobre ESE análisis (lo escribiste vos con los números de ese día). Respondé desde ahí: explicá de dónde sale lo que dijiste, profundizá o corregite si te equivocaste. Si hace falta un número que no está en el análisis o uno de hoy, consultalo y aclarás de qué fecha es.`
    : `<ultimo_informe>
${x.ultimoInforme || '(Todavía no hay un análisis.)'}
</ultimo_informe>`}`;
}

/** Hasta cuántas vueltas de herramientas por pregunta: si no alcanza, contesta con lo que tiene. */
const MAX_VUELTAS = 8;
/** Lo que vuelve de una herramienta, como máximo (en caracteres): lo que pase se recorta con aviso. */
const MAX_RESULTADO = 40_000;

export interface Turno { rol: 'user' | 'assistant'; contenido: Anthropic.Beta.BetaContentBlockParam[] | string; texto: string; herramientas: string[]; llamada: Llamada | null }

/**
 * Una pregunta: corre la conversación con herramientas hasta la respuesta.
 * Devuelve los turnos NUEVOS (incluidos los de herramientas), en orden, para
 * guardarlos tal cual. `puedeGastar` se pregunta antes de cada llamada (tope).
 */
export async function responder(o: {
  sistema: string; herramientas: Anthropic.Beta.BetaTool[]; historial: Anthropic.Beta.BetaMessageParam[]; pregunta: string;
  ejecutar: (nombre: string, input: unknown) => Promise<unknown>;
  puedeGastar: () => Promise<boolean>;
  alLlamar: (l: Llamada, ok: boolean, error?: string) => Promise<void>;
}): Promise<Turno[]> {
  const nuevos: Turno[] = [{ rol: 'user', contenido: o.pregunta, texto: o.pregunta, herramientas: [], llamada: null }];
  const mensajes: Anthropic.Beta.BetaMessageParam[] = [...o.historial, { role: 'user', content: o.pregunta }];
  for (let vuelta = 0; vuelta < MAX_VUELTAS; vuelta++) {
    if (!(await o.puedeGastar())) throw new ErrorAsesor('Se llegó al tope de gasto del mes de este asesor. Subilo en «Configuración» si querés seguir.');
    const ultima = vuelta === MAX_VUELTAS - 1;
    let r: Anthropic.Beta.BetaMessage;
    try {
      r = await ia().beta.messages.create({
        model: MODELO_ASESOR(),
        max_tokens: 16000,
        system: o.sistema,
        tools: o.herramientas,
        /* En la última vuelta no hay más herramientas: contesta con lo que juntó. */
        ...(ultima ? { tool_choice: { type: 'none' as const } } : {}),
        messages: mensajes,
        cache_control: { type: 'ephemeral' },
        output_config: { effort: 'medium' },
        ...RESPALDO,
      });
    } catch (e) { throw explicar(e); }
    const ll = llamada(r);
    await o.alLlamar(ll, r.stop_reason !== 'refusal');
    if (r.stop_reason === 'refusal') throw new ErrorAsesor('La IA no quiso responder esta pregunta.', ll);
    const usos = r.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    const texto = r.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('\n').trim();
    const contenido = r.content as unknown as Anthropic.Beta.BetaContentBlockParam[];
    mensajes.push({ role: 'assistant', content: contenido });
    nuevos.push({ rol: 'assistant', contenido, texto: usos.length ? '' : texto, herramientas: usos.map((u) => u.name), llamada: ll });
    if (r.stop_reason !== 'tool_use' || !usos.length) {
      if (r.stop_reason === 'max_tokens' && !texto) throw new ErrorAsesor('La respuesta salió tan larga que no entró. Preguntá algo más acotado.', ll);
      return nuevos;
    }
    /* Todas las herramientas de la vuelta, y sus resultados juntos en UN mensaje. */
    const resultados: Anthropic.Beta.BetaToolResultBlockParam[] = await Promise.all(usos.map(async (u) => {
      try {
        let salida = JSON.stringify(await o.ejecutar(u.name, u.input));
        if (salida.length > MAX_RESULTADO) salida = `${salida.slice(0, MAX_RESULTADO)}… [RECORTADO: pedí menos filas o un período más corto]`;
        return { type: 'tool_result', tool_use_id: u.id, content: salida };
      } catch (e) {
        return { type: 'tool_result', tool_use_id: u.id, is_error: true, content: String((e as Error)?.message ?? e).slice(0, 500) };
      }
    }));
    mensajes.push({ role: 'user', content: resultados });
    nuevos.push({ rol: 'user', contenido: resultados, texto: '', herramientas: [], llamada: null });
  }
  return nuevos;
}
