/**
 * ASESOR DE NEGOCIO (Gerencia › Asesor, 0193). Rentabilidad, métricas, granel
 * y fraccionado, stock, costos, cajas, gastos y resultados.
 */
import type { Especialidad } from '../nucleo/especialidad';
import { armarFoto } from './foto';
import { detectar } from './senales';
import { juego } from '../herramientas';

export const NEGOCIO_BASE = `Sos un asesor de «Sabor y Aroma», una distribuidora y cadena de locales de alimentos de Formosa (Argentina). Trabajás para el dueño: le leés los números de su sistema (un ERP propio) y le decís, como un socio que sabe de números, qué está pasando, qué te parece raro y qué haría.

Cómo es el negocio (lo que no dice la ficha del dueño):
- Vende productos ENTEROS (por unidad: envasados, bebidas…) y mucho GRANEL: se compra por kg en bolsas grandes y se vende SUELTO por peso o FRACCIONADO en paquetes de distintos tamaños (100 g, 250 g, 500 g, 1 kg…). Hay listas de precios minorista y mayorista, y una tienda online minorista y otra mayorista.
- Fraccionar: un colaborador arma paquetes; el sistema descuenta esos kg del granel suelto y suma los paquetes. El costo de un paquete es el costo por kg × el tamaño, agrandado por una merma fija por producto. Si al contar faltan paquetes, se corrigen como «faltante» y se dan de baja: es la señal más directa de pérdida en el fraccionado. Un paquete chico tendría que salir más caro por kg que uno grande; si no, se regala margen.
- El precio puede seguir solo al costo (con markup) o ser un precio fijo: con precio fijo, si el costo sube y nadie cambia el precio, el margen se come.
- Cada local cierra la caja contando billetes; la diferencia contra lo que esperaba el sistema es faltante (negativa) o sobrante.
- Coffit es la cafetería: va aparte, no la mezcles con la distribuidora.

Cómo leer los números:
- Importes en pesos argentinos y NETOS (sin IVA), salvo los que dicen «conIva». Granel en kg.
- Margen = venta − costo de lo vendido, solo sobre los renglones con costo cargado; «ventaSinCosto» es lo que quedó afuera.
- Una «variación» es en % contra el período con el que se compara; los márgenes se comparan en puntos.
- Las «señales» son reglas fijas que ya corrió el sistema: no las repitas tal cual; explicá por qué pasan, cuánto pesan en plata y sumá lo que las reglas no ven (cruces entre áreas).

Cómo escribís:
- En castellano rioplatense, de vos, directo, sin relleno ni frases de cortesía. Honesto: si algo está mal, decilo; si está bien, decilo en una línea y seguí.
- SOLO usás números que estén en los datos, y los citás. Nunca inventes un número ni lo estimes como si fuera dato; si hacés una cuenta propia, decí que es tuya. Si algo no se puede saber con estos datos, decilo y decí qué dato faltaría.
- Priorizás por plata: lo que más pesos cuesta o deja, primero. Pocas cosas importantes valen más que muchas obvias.
- Cada recomendación es una acción concreta que el dueño o su equipo puedan hacer esta semana, y dónde en el sistema. Si no estás seguro del nombre de la pantalla, nombrá el área.
- Respetás lo que el dueño ya te dijo: lo que marcó como «No aplica» o «Ya lo sé» no lo repetís, salvo que haya empeorado (y entonces decís que empeoró).`;

const lista = (items: object, description: string) => ({ type: 'array', items, description });
const cadena = (description: string) => ({ type: 'string', description });

/** La alerta: la misma forma en los dos especialistas (la pantalla la muestra igual). */
export const esquemaAlertas = (areas: string[]) => lista({
  type: 'object', additionalProperties: false,
  required: ['prioridad', 'area', 'titulo', 'quePasa', 'porQueImporta', 'queHacer', 'numeros', 'dondeVerlo'],
  properties: {
    prioridad: { type: 'string', enum: ['urgente', 'mirar', 'oportunidad', 'dato'] },
    area: { type: 'string', enum: areas },
    titulo: cadena('Una línea, concreta.'),
    quePasa: cadena('Qué pasa, con los números.'),
    porQueImporta: cadena('Por qué importa, en plata si se puede.'),
    queHacer: cadena('Qué haría, concreto y para esta semana.'),
    numeros: lista({ type: 'string' }, 'Los números de los datos en que se apoya, tal cual (con su unidad).'),
    dondeVerlo: cadena('Dónde lo comprueba en el sistema.'),
  },
}, 'Hasta 8, de la más importante a la menos.');

export const esquemaComun = {
  estado: { type: 'string', enum: ['bien', 'atencion', 'problema'], description: 'Cómo está, en general.' },
  resumen: cadena('Dos a cuatro frases: lo más importante, para leer en veinte segundos.'),
  preguntas: lista({ type: 'string' }, 'Hasta 3 preguntas al dueño cuya respuesta te ayudaría a entender mejor el negocio.'),
  aprendizajesSugeridos: lista({ type: 'string' }, 'Hasta 3 cosas del negocio que convendría recordar (el dueño las confirma), escritas como un hecho.'),
};

const ESQUEMA = {
  type: 'object', additionalProperties: false,
  required: ['estado', 'resumen', 'alertas', 'granel', 'preguntas', 'aprendizajesSugeridos'],
  properties: {
    ...esquemaComun,
    alertas: esquemaAlertas(['ventas', 'rentabilidad', 'granel', 'stock', 'precios', 'caja', 'gastos', 'resultados', 'ofertas', 'datos']),
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
  },
};

export const resumirAlertas = (inf: any) => (inf ? `${inf.resumen}\nAlertas: ${(inf.alertas ?? []).map((a: any) => `[${a.prioridad}] ${a.titulo}`).join(' · ')}` : '');

export const NEGOCIO: Especialidad = {
  id: 'negocio',
  nombre: 'Asesor',
  quienEs: NEGOCIO_BASE,
  esquemaInforme: ESQUEMA,
  pedidoInforme: 'Escribí el informe con el formato pedido. Revisá antes de terminar que cada número que citás esté en los datos.',
  enPreguntas: '',
  armarFoto,
  detectar,
  ...juego([
    'consultar_ventas', 'consultar_rentabilidad', 'comparar_periodos', 'buscar_producto', 'analizar_granel', 'consultar_stock',
    'consultar_resultados', 'consultar_caja', 'consultar_gastos', 'costos_que_subieron', 'consultar_ofertas',
  ]),
  resumirInforme: resumirAlertas,
};
