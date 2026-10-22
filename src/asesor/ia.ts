/**
 * GERENCIA › ASESOR · LA IA (0193)
 * ============================================================================
 * Con la librería oficial de Anthropic. La clave es la misma de la lectura de
 * facturas (`ANTHROPIC_API_KEY`, solo en el servidor). El modelo: Claude Opus
 * 5.5, o el de `ANTHROPIC_MODELO_ASESOR`. Si Claude declina una consulta, la API
 * la reintenta sola con otro modelo (respaldo del servidor, `fallbacks`).
 *
 *   · analizar: UNA llamada con la foto entera; la respuesta sale con FORMATO
 *     FIJO (JSON Schema), así la pantalla siempre sabe qué mostrar.
 *   · responder: la conversación; la IA llama a las herramientas (solo lectura)
 *     hasta tener los números, y contesta. Cada turno se guarda TAL CUAL lo
 *     devolvió la API y se reenvía sin tocar.
 */
import Anthropic from '@anthropic-ai/sdk';
import { IA } from '../facturas/ia/anthropic';
import { costoUsd } from '../facturas/ia/precios';
import { HERRAMIENTAS } from './herramientas';

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

/* ============================== QUIÉN ES ============================== */

const NEGOCIO = `Sos el asesor de negocio de «Sabor y Aroma», una distribuidora y cadena de locales de alimentos de Formosa (Argentina). Trabajás para el dueño: le leés los números de su sistema (un ERP propio) y le decís, como un socio que sabe de números, qué está pasando, qué te parece raro y qué haría.

Cómo es el negocio (lo que no dice la ficha del dueño):
- Vende productos ENTEROS (por unidad: envasados, bebidas…) y mucho GRANEL: se compra por kg en bolsas grandes y se vende SUELTO por peso o FRACCIONADO en paquetes de distintos tamaños (100 g, 250 g, 500 g, 1 kg…). Hay listas de precios minorista y mayorista.
- Fraccionar: un colaborador arma paquetes; el sistema descuenta esos kg del granel suelto y suma los paquetes. El costo de un paquete es el costo por kg × el tamaño, agrandado por una merma fija por producto. Si al contar faltan paquetes, se corrigen como «faltante» y se dan de baja: es la señal más directa de pérdida en el fraccionado. Un paquete chico tendría que salir más caro por kg que uno grande; si no, se regala margen.
- El precio puede seguir solo al costo (con markup) o ser un precio fijo: con precio fijo, si el costo sube y nadie cambia el precio, el margen se come.
- Cada local cierra la caja contando billetes; la diferencia contra lo que esperaba el sistema es faltante (negativa) o sobrante.
- Coffit es la cafetería: va aparte, no la mezcles con la distribuidora.

Cómo leer los números:
- Importes en pesos argentinos y NETOS (sin IVA), salvo los que dicen «conIva». Granel en kg.
- Margen = venta − costo de lo vendido, solo sobre los renglones con costo cargado; «ventaSinCosto» es lo que quedó afuera.
- Una «variación» es en % contra el período con el que se compara; los márgenes se comparan en puntos.
- Las «señales» son reglas fijas que ya corrió el sistema: no las repitas tal cual; explicá por qué pasan, cuánto pesan en plata y sumá lo que las reglas no ven (cruces entre ventas, márgenes, stock, granel, caja y gastos).

Cómo escribís:
- En castellano rioplatense, de vos, directo, sin relleno ni frases de cortesía. Honesto: si algo está mal, decilo; si está bien, decilo en una línea y seguí.
- SOLO usás números que estén en los datos, y los citás. Nunca inventes un número ni lo estimes como si fuera dato; si algo no se puede saber con estos datos, decilo y decí qué dato faltaría.
- Priorizás por plata: lo que más pesos cuesta o deja, primero. Pocas cosas importantes valen más que muchas obvias.
- Cada recomendación es una acción concreta que el dueño o su equipo puedan hacer esta semana, y dónde en el sistema (por ejemplo Gerencia › Métricas, Gerencia › Resultados, Ventas › Caja, Almacén › Existencias, el historial de fraccionamiento, Compras › Productos, Gastos). Si no estás seguro del nombre de la pantalla, nombrá el área.
- Respetás lo que el dueño ya te dijo: lo que marcó como «No aplica» o «Ya lo sé» no lo repetís, salvo que haya empeorado (y entonces decís que empeoró).`;

/* ============================== EL INFORME ============================== */

const AREAS = ['ventas', 'rentabilidad', 'granel', 'stock', 'precios', 'caja', 'gastos', 'resultados', 'ofertas', 'datos'];
const lista = (items: object, description: string) => ({ type: 'array', items, description });
const cadena = (description: string) => ({ type: 'string', description });

export const ESQUEMA_INFORME = {
  type: 'object', additionalProperties: false,
  required: ['estado', 'resumen', 'alertas', 'granel', 'preguntas', 'aprendizajesSugeridos'],
  properties: {
    estado: { type: 'string', enum: ['bien', 'atencion', 'problema'], description: 'Cómo está el negocio en general.' },
    resumen: cadena('Dos a cuatro frases: lo más importante, para leer en veinte segundos.'),
    alertas: lista({
      type: 'object', additionalProperties: false,
      required: ['prioridad', 'area', 'titulo', 'quePasa', 'porQueImporta', 'queHacer', 'numeros', 'dondeVerlo'],
      properties: {
        prioridad: { type: 'string', enum: ['urgente', 'mirar', 'oportunidad', 'dato'] },
        area: { type: 'string', enum: AREAS },
        titulo: cadena('Una línea, concreta.'),
        quePasa: cadena('Qué pasa, con los números.'),
        porQueImporta: cadena('Por qué importa, en plata si se puede.'),
        queHacer: cadena('Qué haría, concreto y para esta semana.'),
        numeros: lista({ type: 'string' }, 'Los números de los datos en que se apoya, tal cual (con su unidad).'),
        dondeVerlo: cadena('Dónde lo comprueba en el sistema.'),
      },
    }, 'Hasta 8, de la más importante a la menos.'),
    granel: {
      type: 'object', additionalProperties: false, required: ['resumen', 'fraccionar', 'revisar'],
      properties: {
        resumen: cadena('Cómo viene el granel y el fraccionado, en dos o tres frases.'),
        fraccionar: lista({
          type: 'object', additionalProperties: false, required: ['producto', 'tamano', 'motivo'],
          properties: { producto: { type: 'string' }, tamano: { type: 'string' }, motivo: { type: 'string' } },
        }, 'Qué conviene fraccionar ya (hasta 10), con el motivo.'),
        revisar: lista({ type: 'string' }, 'Precios por tamaño, sobrefraccionado, faltantes o colaboradores a revisar (hasta 6).'),
      },
    },
    preguntas: lista({ type: 'string' }, 'Hasta 3 preguntas al dueño cuya respuesta te ayudaría a entender mejor el negocio.'),
    aprendizajesSugeridos: lista({ type: 'string' }, 'Hasta 3 cosas del negocio que convendría recordar (el dueño las confirma), escritas como un hecho.'),
  },
};

export interface Contexto {
  ficha: string;
  aprendizajes: string[];
  opiniones: { titulo: string; area: string; valor: string; nota: string; fecha: string }[];
}

const bloqueContexto = (x: Contexto) => [
  `<ficha_del_duenio>\n${x.ficha.trim() || '(El dueño todavía no escribió nada de su negocio.)'}\n</ficha_del_duenio>`,
  `<lo_que_ya_sabes>\n${x.aprendizajes.length ? x.aprendizajes.map((a) => `- ${a}`).join('\n') : '(Nada todavía.)'}\n</lo_que_ya_sabes>`,
  `<opiniones_del_duenio_sobre_alertas_anteriores>\n${x.opiniones.length ? JSON.stringify(x.opiniones) : '(Ninguna todavía.)'}\n</opiniones_del_duenio_sobre_alertas_anteriores>`,
].join('\n\n');

export async function analizar(o: { foto: unknown; senales: unknown; contexto: Contexto; enfoque: string }): Promise<{ informe: any; llamada: Llamada }> {
  const mensaje = [
    bloqueContexto(o.contexto),
    `<senales_del_sistema>\n${JSON.stringify(o.senales)}\n</senales_del_sistema>`,
    `<foto_del_negocio>\n${JSON.stringify(o.foto)}\n</foto_del_negocio>`,
    o.enfoque.trim()
      ? `El dueño pidió que mires especialmente: «${o.enfoque.trim()}». Respondé eso primero, sin dejar afuera lo urgente.`
      : 'Hacé el análisis completo del negocio.',
    'Escribí el informe con el formato pedido. Revisá antes de terminar que cada número que citás esté en los datos.',
  ].join('\n\n');
  let r: Anthropic.Beta.BetaMessage;
  try {
    r = await ia().beta.messages.stream({
      model: MODELO_ASESOR(),
      max_tokens: 32000,
      system: NEGOCIO,
      messages: [{ role: 'user', content: mensaje }],
      output_config: { effort: 'high', format: { type: 'json_schema', schema: ESQUEMA_INFORME } },
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

export function sistemaPreguntas(x: Contexto & { hoy: string; sucursales: { id: number; nombre: string }[]; ultimoInforme: string }) {
  return `${NEGOCIO}

Ahora el dueño te hace preguntas. Para responder con números usás las herramientas: consultan el sistema en el momento y son de solo lectura. Nunca supongas un número que podés consultar; si una herramienta no tiene el dato, decilo. Si la pregunta es ambigua (qué período, qué local), elegí lo razonable, decí qué elegiste y respondé. Respuestas cortas y al grano: primero la respuesta, después el detalle que la sostiene; tablas chicas en markdown solo si ayudan.

Hoy es ${x.hoy}. Sucursales activas (id: nombre): ${x.sucursales.map((s) => `${s.id}: ${s.nombre}`).join(', ')}.

${bloqueContexto(x)}

<ultimo_informe>
${x.ultimoInforme || '(Todavía no hay un análisis.)'}
</ultimo_informe>`;
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
  sistema: string; historial: Anthropic.Beta.BetaMessageParam[]; pregunta: string;
  ejecutar: (nombre: string, input: unknown) => Promise<unknown>;
  puedeGastar: () => Promise<boolean>;
  alLlamar: (l: Llamada, ok: boolean, error?: string) => Promise<void>;
}): Promise<Turno[]> {
  const nuevos: Turno[] = [{ rol: 'user', contenido: o.pregunta, texto: o.pregunta, herramientas: [], llamada: null }];
  const mensajes: Anthropic.Beta.BetaMessageParam[] = [...o.historial, { role: 'user', content: o.pregunta }];
  for (let vuelta = 0; vuelta < MAX_VUELTAS; vuelta++) {
    if (!(await o.puedeGastar())) throw new ErrorAsesor('Se llegó al tope de gasto del mes del asesor. Subilo en «Configuración» del Asesor si querés seguir.');
    const ultima = vuelta === MAX_VUELTAS - 1;
    let r: Anthropic.Beta.BetaMessage;
    try {
      r = await ia().beta.messages.create({
        model: MODELO_ASESOR(),
        max_tokens: 16000,
        system: o.sistema,
        tools: HERRAMIENTAS,
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
