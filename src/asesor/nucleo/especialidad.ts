/**
 * LOS ASESORES · QUÉ ES UN ESPECIALISTA (0193)
 * ============================================================================
 * El núcleo (la IA, el tope, las conversaciones, las opiniones, la pantalla)
 * es uno solo; cada especialista aporta lo suyo:
 *   · quién es y cómo escribe (el sistema de la IA),
 *   · la FOTO que mira y las SEÑALES que el sistema detecta solo (sin IA),
 *   · el formato fijo de su informe,
 *   · las HERRAMIENTAS que la IA puede consultar al responder preguntas.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { Fuentes } from '../datos';

export type IdEspecialidad = 'negocio' | 'comercial';

export type Nivel = 'urgente' | 'mirar' | 'dato';
/** Algo raro que el SISTEMA detectó solo, con una regla fija (sin IA). */
export interface Senal { nivel: Nivel; area: string; titulo: string; detalle: string }

export interface Especialidad {
  id: IdEspecialidad;
  /** Cómo se llama en pantalla y en los mensajes. */
  nombre: string;
  /** El sistema de la IA: quién es, cómo es el negocio, cómo leer los números y cómo escribir. */
  quienEs: string;
  /** El JSON Schema del informe (formato fijo). */
  esquemaInforme: Record<string, unknown>;
  /** La última instrucción del análisis (después de los datos). */
  pedidoInforme: string;
  /** Lo que se suma al sistema cuando el dueño hace preguntas. */
  enPreguntas: string;
  armarFoto(f: Fuentes): Promise<unknown>;
  detectar(foto: any): Senal[];
  herramientas: Anthropic.Beta.BetaTool[];
  ejecutar(f: Fuentes, nombre: string, input: any): Promise<unknown>;
  /** El último informe en pocas líneas, para tenerlo presente en las preguntas. */
  resumirInforme(informe: any): string;
  /**
   * Lo que el SISTEMA le agrega al informe cuando la IA termina (opcional): por
   * ejemplo, la simulación de cada promoción propuesta. La IA no hace cuentas.
   */
  enriquecer?(informe: any, f: Fuentes): Promise<any>;
}
