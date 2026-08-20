/**
 * ARCA — el servicio que une el protocolo con el negocio
 * ============================================================================
 * `wsfe.ts` habla SOAP y no sabe qué es una venta. `ventas.module.ts` sabe qué
 * es una venta y no tiene por qué saber qué es un CAE. Este servicio es la
 * bisagra: recibe los números de una venta, emite, y devuelve un resultado que
 * el POS puede entender sin conocer ARCA.
 *
 * TRES PROBLEMAS QUE RESUELVE, y ninguno es del protocolo:
 *
 * 1. **LA NUMERACIÓN LA LLEVA ARCA.** Antes de cada comprobante hay que
 *    preguntar cuál fue el último y pedir el siguiente. Un contador local no
 *    puede competir con eso: apenas se desincronizan, ARCA rechaza todo con
 *    "el número no se corresponde con el próximo a registrar".
 *
 * 2. **DOS CAJAS NO PUEDEN PEDIR EL MISMO NÚMERO.** Si Fontana y la
 *    Distribuidora facturan en el mismo segundo, las dos preguntan "cuál fue
 *    el último", las dos reciben N, y las dos piden N+1: una sale y la otra
 *    rebota. Se serializa con una cadena de promesas (§6.4 de la guía), y
 *    encima queda la red del punto 3.
 *
 * 3. **LA RESPUESTA QUE SE PIERDE.** El pedido sale, ARCA emite, y la
 *    respuesta no vuelve. Para nosotros falló; para ARCA la factura existe.
 *    Es el caso que genera DUPLICADOS, y se cubre en dos capas:
 *      · en el acto: si el pedido falla por red, se consulta el número.
 *      · más tarde: la venta guardó el número reservado (0075), así que el
 *        reintento consulta antes de emitir.
 */
import {
  Controller, Get, Inject, Injectable, Logger, Module, Post,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { and, eq, ne, sql } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import { Permiso } from '../auth/auth.decoradores';
import { ConfiguracionModule, ConfiguracionService } from '../configuracion/configuracion.module';
import { clientes, sucursales, ventas } from '../db/schema';
import {
  ARCA, arcaDisponible, diferenciasConEmpresa, motivoNoDisponible, resetDisponible,
} from './config';
import { parsearFechaArca } from './fecha';
import {
  armarAlicuotas, armarReceptor, CBTE_TIPO, letraDe, esFiscal,
  type Receptor, type RenglonFiscal,
} from './comprobante';
import {
  consultarComprobante, feDummy, solicitarCae, ultimoAutorizado, ErrorArca,
} from './wsfe';
import { obtenerTicket } from './wsaa';

/** Una fila del diagnóstico: un punto de venta y qué contestó ARCA por él. */
interface DiagnosticoPunto {
  sucursalId: number | null;
  /** El local, o los locales que comparten el de la variable de entorno. */
  sucursal: string;
  /** Cinco dígitos, como sale impreso. */
  puntoVenta: string;
  numero: number;
  /** `false` = no tiene el suyo cargado y usa el de la configuración. */
  propio: boolean;
  tipos: Array<{ tipo: string; ultimo: number | null; error?: string }>;
}

/** Lo que el negocio le pasa a ARCA para emitir. */
export interface PedidoEmision {
  /** Tipo del sistema: 'factura_a' | 'factura_b' | 'nota_credito_b' … */
  tipo: string;
  receptor: Receptor;
  renglones: RenglonFiscal[];
  neto: number;
  iva: number;
  total: number;
  /**
   * EL PUNTO DE VENTA DEL LOCAL QUE EMITE (0077). Cada sucursal tiene el suyo
   * declarado en ARCA contra su domicilio, con numeración independiente. Sin
   * él, se usa el de la variable de entorno — que es lo correcto para una
   * instalación de un solo local.
   */
  ptoVta?: number | null;
  fecha?: Date;
  /** Notas de crédito/débito: el comprobante que ajustan. */
  asociado?: { tipo: string; ptoVta: string; numero: number };
  /**
   * Número ya reservado de un intento anterior. Si viene, ANTES de emitir se
   * consulta si ese número ya salió — es la recuperación.
   */
  reservado?: { cbteNro: number; cbteTipo: number } | null;
  /** Guarda el número reservado antes de llamar a ARCA. Ver problema 3. */
  reservar?: (cbteNro: number, cbteTipo: number) => Promise<void>;
}

export type ResultadoEmision =
  | {
    ok: true;
    /** `false` cuando ARCA está apagado: se emite como siempre, sin CAE. */
    conCae: boolean;
    cae: string;
    caeVencimiento: Date | null;
    cbteNro: number | null;
    puntoVenta: string | null;
    observaciones: string[];
    /** Se adoptó un comprobante que ya existía en ARCA (recuperación). */
    adoptado?: boolean;
  }
  | { ok: false; motivo: string; reintentable: boolean };

@Injectable()
export class ArcaService implements OnApplicationBootstrap {
  private readonly log = new Logger('ARCA');

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * EL TICKET SE PIDE AL ARRANCAR, NO EN LA PRIMERA VENTA.
   *
   * Medido contra el WSAA de homologación: pedir un ticket tarda **~10
   * segundos**. Las otras llamadas (el último número, el CAE) son de uno o
   * dos. O sea que sin esto, la primera factura del día —o la primera después
   * de cada deploy— se come diez segundos de más con un cliente esperando, y
   * el resto sale rápido. Un problema que aparece una vez cada tanto y nadie
   * logra reproducir.
   *
   * No bloquea el arranque ni rompe nada si falla: si ARCA está caído a esa
   * hora, la primera venta lo reintenta como siempre. Y si ya hay un ticket
   * vigente en la base, esto ni sale a la red.
   */
  onApplicationBootstrap(): void {
    if (!arcaDisponible()) return;
    obtenerTicket(this.db, 'wsfe')
      .then((ta) => this.log.log(`Ticket de acceso listo (vence ${ta.expiresAt.toISOString()}).`))
      .catch((e) => this.log.warn(`No se pudo obtener el ticket al arrancar: ${e.message}`));
  }

  /**
   * LA CADENA. Cada emisión espera a que termine la anterior.
   *
   * Es por tipo de comprobante porque las numeraciones son independientes: una
   * Factura A y una Factura B pueden salir a la vez sin pisarse. Serializar
   * todo junto sería frenar de más.
   */
  private cadenas = new Map<string, Promise<unknown>>();

  /**
   * La clave lleva el PUNTO DE VENTA además del tipo (0077). Las numeraciones
   * son independientes por punto de venta, así que Fontana y la Distribuidora
   * pueden facturar en el mismo segundo sin pisarse — y encolarlas juntas sería
   * hacer esperar a una por la otra sin ninguna razón.
   */
  private enFila<T>(ptoVta: number, cbteTipo: number, fn: () => Promise<T>): Promise<T> {
    const clave = `${ptoVta}:${cbteTipo}`;
    const previa = this.cadenas.get(clave) ?? Promise.resolve();
    // `.catch` para que un fallo no rompa la cadena de los que vienen atrás.
    const mia = previa.catch(() => {}).then(fn);
    this.cadenas.set(clave, mia.catch(() => {}));
    return mia;
  }

  disponible(): boolean {
    return arcaDisponible();
  }

  motivo(): string | null {
    return motivoNoDisponible();
  }

  /**
   * El punto de venta con el formato del comprobante: **CINCO dígitos**.
   *
   * Eran cuatro, y con el 0001 de la etapa de prueba nunca se notó. Los puntos
   * de venta reales de la casa son 00028 a 00032: recortados a cuatro, la
   * factura impresa diría `0028-00000001` mientras ARCA registra
   * `00028-00000001`. Es el mismo comprobante y dos números distintos, y ese
   * número es justo por donde se lo coteja contra Mis Comprobantes.
   */
  puntoVenta(ptoVta?: number | null): string {
    const n = Number(ptoVta) || ARCA.ptoVta;
    return n ? String(n).padStart(5, '0') : '';
  }

  /**
   * EMITE UN COMPROBANTE FISCAL.
   *
   * **Nunca lanza por un problema de ARCA**: devuelve `ok: false` con el
   * motivo. Quien llama decide qué hacer, y en el POS la decisión ya está
   * tomada — sale el ticket provisorio y la venta queda pendiente de facturar.
   * Una excepción acá sería una venta caída con el cliente enfrente.
   */
  async emitir(p: PedidoEmision): Promise<ResultadoEmision> {
    if (!esFiscal(p.tipo)) {
      // Un ticket interno no va a ARCA: se emite con la numeración de siempre.
      return { ok: true, conCae: false, cae: '', caeVencimiento: null, cbteNro: null, puntoVenta: null, observaciones: [] };
    }
    if (!arcaDisponible()) {
      /* ARCA apagado NO es un fallo: es la etapa previa, y el comprobante sale
       * con la numeración local y sin CAE, exactamente como hasta hoy. */
      return { ok: true, conCae: false, cae: '', caeVencimiento: null, cbteNro: null, puntoVenta: null, observaciones: [] };
    }

    const cbteTipo = CBTE_TIPO[p.tipo];
    const letra = letraDe(p.tipo)!;

    /* El receptor se arma ANTES de la fila: si falta el CUIT de una Factura A
     * no tiene sentido hacer esperar a nadie, y el mensaje es de datos. */
    let receptor;
    try {
      receptor = armarReceptor(letra, p.receptor, p.total, 0);
    } catch (e) {
      return { ok: false, motivo: (e as Error).message, reintentable: false };
    }

    let alicuotas;
    try {
      alicuotas = armarAlicuotas(p.renglones, { neto: p.neto, iva: p.iva });
    } catch (e) {
      return { ok: false, motivo: (e as Error).message, reintentable: false };
    }

    const asociado = p.asociado
      ? { tipo: CBTE_TIPO[p.asociado.tipo], ptoVta: Number(p.asociado.ptoVta) || Number(p.ptoVta) || ARCA.ptoVta, nro: p.asociado.numero }
      : undefined;

    /* El punto de venta del LOCAL que emite: cada uno tiene el suyo declarado
     * en ARCA y su propia numeración. Sin él, el de la configuración. */
    const ptoVta = Number(p.ptoVta) || ARCA.ptoVta;

    return this.enFila(ptoVta, cbteTipo, async () => {
      try {
        /* ---- 1. ¿Quedó algo en vuelo de un intento anterior? ---- */
        if (p.reservado && p.reservado.cbteTipo === cbteTipo) {
          const previo = await this.adoptarSiExiste(p.reservado.cbteNro, cbteTipo, p.total, receptor.docNro, ptoVta);
          if (previo) return previo;
        }

        /* ---- 2. El número lo dice ARCA ---- */
        let numero = (await ultimoAutorizado(this.db, cbteTipo, ptoVta)) + 1;
        if (p.reservar) await p.reservar(numero, cbteTipo);

        /* ---- 3. Emitir ---- */
        const pedido = {
          cbteTipo,
          cbteNro: numero,
          ptoVta,
          fecha: p.fecha,
          docTipo: receptor.docTipo,
          docNro: receptor.docNro,
          condIvaReceptorId: receptor.condIvaReceptorId,
          impNeto: p.neto,
          impIva: p.iva,
          impTotal: p.total,
          alicuotas,
          asociado,
        };

        try {
          const r = await solicitarCae(this.db, pedido);
          return this.exito(r.cae, r.caeVencimiento, r.cbteNro, r.observaciones, ptoVta);
        } catch (e) {
          const err = e as ErrorArca;

          /*
           * "El número no se corresponde con el próximo a registrar" (10016).
           * Es la carrera: alguien tomó ese número entre que preguntamos y
           * pedimos. Se vuelve a preguntar y se reintenta UNA vez — pelear más
           * sería quedarse dando vueltas con la caja esperando.
           */
          if (/10016|no se corresponde con el pr[oó]ximo/i.test(err.message)) {
            numero = (await ultimoAutorizado(this.db, cbteTipo, ptoVta)) + 1;
            if (p.reservar) await p.reservar(numero, cbteTipo);
            const r = await solicitarCae(this.db, { ...pedido, cbteNro: numero });
            return this.exito(r.cae, r.caeVencimiento, r.cbteNro, r.observaciones, ptoVta);
          }

          /*
           * FALLO DE RED CON EL PEDIDO YA EN VUELO. No sabemos si ARCA emitió.
           * Preguntamos en el acto: si el número ya salió con nuestros datos,
           * la factura ES nuestra y la adoptamos. Sin esto, el reintento de
           * más tarde emitiría una segunda factura de la misma venta.
           */
          if (err.reintentable) {
            const rescatado = await this.adoptarSiExiste(numero, cbteTipo, p.total, receptor.docNro, ptoVta)
              .catch(() => null);
            if (rescatado) return rescatado;
          }

          return { ok: false as const, motivo: err.message, reintentable: err.reintentable ?? true };
        }
      } catch (e) {
        const err = e as ErrorArca;
        return { ok: false as const, motivo: err.message ?? String(e), reintentable: err.reintentable ?? true };
      }
    });
  }

  private exito(cae: string, vto: string, nro: number, obs: string[], ptoVta?: number): ResultadoEmision {
    return {
      ok: true,
      conCae: true,
      cae,
      caeVencimiento: parsearFechaArca(vto),
      cbteNro: nro,
      puntoVenta: this.puntoVenta(ptoVta),
      observaciones: obs,
    };
  }

  /**
   * ¿ESE NÚMERO YA SALIÓ, Y ES NUESTRO?
   *
   * Se compara el IMPORTE y el DOCUMENTO, no solo la existencia: el número
   * puede haberlo tomado otro comprobante (otra caja, o una factura hecha a
   * mano desde la web de ARCA). Adoptar el CAE de un comprobante ajeno sería
   * ponerle a esta venta el número de otra.
   */
  private async adoptarSiExiste(
    cbteNro: number, cbteTipo: number, total: number, docNro: string, ptoVta?: number,
  ): Promise<ResultadoEmision | null> {
    const previo = await consultarComprobante(this.db, cbteTipo, cbteNro, ptoVta);
    if (!previo) return null;
    const mismoImporte = Math.abs(previo.impTotal - total) <= 0.01;
    const mismoDoc = String(previo.docNro || '0') === String(docNro || '0');
    if (!mismoImporte || !mismoDoc) return null;
    return { ...(this.exito(previo.cae, previo.caeVencimiento, previo.cbteNro, [], ptoVta) as any), adoptado: true };
  }

  /* ------------------------- Diagnóstico ------------------------- */

  /**
   * EL ESTADO BARATO: lo que se sabe SIN salir a la red.
   *
   * Va separado de `diagnostico()` a propósito. Abrir la pantalla de
   * Configuración no puede costar diez segundos de espera contra ARCA —y eso
   * es lo que tarda pedir un ticket de acceso—, así que la pantalla carga esto
   * y el viaje a la red lo dispara el usuario apretando "Probar conexión".
   *
   * `resetDisponible()` acá vale oro: es la trampa §9.8 (el certificado que
   * quedó como `.crt.crt`). Se corrige el nombre, se recarga esta pantalla y
   * el estado se relee del disco sin reiniciar la API.
   */
  /**
   * LOS PUNTOS DE VENTA EN USO, uno por sucursal (0077).
   *
   * Una sucursal sin el suyo cargado **cae al de la variable de entorno** —lo
   * correcto en una instalación de un solo local, donde no hay nada que
   * elegir— y viaja marcada con `propio: false` para que el panel lo muestre:
   * con varios locales, eso significa que sus facturas saldrían por la boca de
   * expendio de otro, y hay que verlo.
   *
   * Las que caen al mismo número se agrupan en una fila: preguntarle dos veces
   * a ARCA por el mismo punto de venta daría la misma respuesta dos veces.
   */
  private async puntosDeVenta() {
    const filas = await this.db.select({
      id: sucursales.id, nombre: sucursales.nombre, pv: sucursales.puntoVenta,
    }).from(sucursales).orderBy(sucursales.id);

    const salida: Array<{
      sucursalId: number | null; sucursal: string; puntoVenta: string;
      numero: number; propio: boolean;
    }> = [];
    const sinPropio: string[] = [];

    for (const f of filas) {
      const numero = Number(String(f.pv ?? '').replace(/\D/g, '')) || 0;
      if (numero) {
        salida.push({
          sucursalId: f.id, sucursal: f.nombre, puntoVenta: this.puntoVenta(numero),
          numero, propio: true,
        });
      } else {
        sinPropio.push(f.nombre);
      }
    }

    if (sinPropio.length && ARCA.ptoVta) {
      salida.push({
        sucursalId: null,
        sucursal: sinPropio.join(', '),
        puntoVenta: this.puntoVenta(),
        numero: ARCA.ptoVta,
        propio: false,
      });
    }
    return salida;
  }

  estado() {
    resetDisponible();
    return {
      produccion: ARCA.produccion,
      cuit: ARCA.cuit,
      puntoVenta: ARCA.ptoVta ? this.puntoVenta() : '',
      disponible: arcaDisponible(),
      motivo: motivoNoDisponible(),
      certPath: ARCA.certPath,
      keyPath: ARCA.keyPath,
      timeoutMs: ARCA.timeoutMs,
      /* La URL importa: es lo que distingue de un vistazo homologación de
       * producción cuando alguien duda de qué está mirando. */
      wsfeUrl: ARCA.wsfeUrl,
    };
  }

  /**
   * Las tres preguntas del §2.4, en orden. El orden ES el diagnóstico: si
   * falla la primera el problema es de ARCA; si falla la segunda, del
   * certificado; si falla la tercera, del punto de venta o su autorización.
   */
  async diagnostico() {
    const base = this.estado();
    const inicio = Date.now();
    /*
     * TRES PASOS QUE SE CORTAN EN EL PRIMER FALLO, y el corte es el
     * diagnóstico: seguir preguntando después de que el certificado fue
     * rechazado solo agrega tres errores más que dicen lo mismo, y el que mira
     * la pantalla tiene que adivinar cuál es la causa y cuáles las
     * consecuencias. El primero que falla ES la causa.
     */
    const pasos: Array<{
      clave: string; titulo: string; ok: boolean; detalle: string; ms: number;
    }> = [];
    const paso = async (clave: string, titulo: string, fn: () => Promise<string>) => {
      const t0 = Date.now();
      try {
        pasos.push({ clave, titulo, ok: true, detalle: await fn(), ms: Date.now() - t0 });
        return true;
      } catch (e) {
        pasos.push({ clave, titulo, ok: false, detalle: (e as Error).message, ms: Date.now() - t0 });
        return false;
      }
    };

    /*
     * 1. ¿ESTÁ VIVO EL SERVICIO? Va primero y **corre siempre, incluso sin
     *    certificado**: `FEDummy` no lleva credenciales. Es justo la pregunta
     *    que uno quiere contestar cuando algo no anda —¿es ARCA o soy yo?— y
     *    saltearla por no tener el certificado cargado sería tapar la única
     *    respuesta que se podía dar en ese estado.
     */
    const vivo = await paso('servicio', 'El servicio de ARCA responde', async () => {
      const d = await feDummy();
      if (!d.ok) throw new Error(`ARCA contesta pero se declara caído (${JSON.stringify(d)}).`);
      return 'appserver, dbserver y authserver en OK.';
    });

    /* 2. ¿Está la configuración? No es una llamada, es un chequeo local, pero
     *    va como paso para que el corte se vea en el mismo lugar que los
     *    demás en vez de aparecer como un cartel suelto. */
    if (!base.disponible) {
      pasos.push({
        clave: 'config',
        titulo: 'La configuración está completa',
        ok: false,
        detalle: base.motivo ?? 'La facturación electrónica no está configurada.',
        ms: 0,
      });
      return {
        ...base,
        pasos,
        numeracion: [],
        ms: Date.now() - inicio,
        veredicto: vivo
          ? `ARCA está funcionando; lo que falta es de este lado. ${base.motivo}`
          : `${base.motivo} Y además ARCA no está contestando.`,
      };
    }

    /* 3. ¿Nos reconoce el certificado? Es el paso que separa "ARCA no anda" de
     *    "el certificado no sirve", que son dos llamados de teléfono muy
     *    distintos. */
    const autenticado = vivo && await paso('ticket', 'El certificado autentica (WSAA)', async () => {
      const ta = await obtenerTicket(this.db, 'wsfe');
      return `Ticket de acceso vigente hasta ${ta.expiresAt.toLocaleString('es-AR', {
        timeZone: 'America/Argentina/Buenos_Aires',
      })}.`;
    });

    /*
     * 4. ¿CADA PUNTO DE VENTA EXISTE Y ESTÁ AUTORIZADO? Un certificado válido
     *    con el punto de venta equivocado falla ACÁ y en ningún lado antes.
     *
     * Se pregunta POR SUCURSAL (0077), porque cada local tiene el suyo y uno
     * puede estar mal mientras los otros cuatro andan — que es exactamente el
     * caso que hay que poder ver.
     *
     * EN PARALELO: son lecturas independientes y no tocan numeración, así que
     * la cadena que serializa las emisiones no aplica. En serie, cinco locales
     * por dos comprobantes serían veinte segundos de botón apretado; así es lo
     * que tarde la más lenta.
     */
    const numeracion: DiagnosticoPunto[] = [];
    if (autenticado) {
      const puntos = await this.puntosDeVenta();
      await paso('numeracion', puntos.length > 1
        ? `Los ${puntos.length} puntos de venta están autorizados`
        : `El punto de venta ${puntos[0]?.puntoVenta ?? base.puntoVenta} está autorizado`, async () => {
        const TIPOS_SONDA = ['factura_a', 'factura_b'];
        const filas = await Promise.all(puntos.map(async (p) => {
          const tipos = await Promise.all(TIPOS_SONDA.map(async (tipo) => {
            try {
              return { tipo, ultimo: await ultimoAutorizado(this.db, CBTE_TIPO[tipo], p.numero) };
            } catch (e) {
              return { tipo, ultimo: null, error: (e as Error).message };
            }
          }));
          return { ...p, tipos };
        }));
        numeracion.push(...filas);

        /* Falla el paso solo si NINGUNO contesta: si cuatro andan y uno no, el
         * problema es de ese punto de venta y se ve en su fila, no en el
         * veredicto general. */
        const mudos = numeracion.filter((n) => n.tipos.every((t) => t.error));
        if (mudos.length === numeracion.length && numeracion.length) {
          throw new Error(mudos[0].tipos[0].error!);
        }
        if (mudos.length) {
          return `${numeracion.length - mudos.length} de ${numeracion.length} contestan. `
            + `Sin autorizar: ${mudos.map((m) => `${m.sucursal} (${m.puntoVenta})`).join(', ')}.`;
        }
        return `Los ${numeracion.length === 1 ? 'comprobantes contestan' : `${numeracion.length} contestan`} con su último número.`;
      });
    }

    const roto = pasos.find((p) => !p.ok);
    return {
      ...base,
      pasos,
      numeracion,
      ms: Date.now() - inicio,
      /* El veredicto en una línea. La pantalla muestra el detalle igual, pero
       * lo primero que alguien necesita saber es si puede facturar o no. */
      veredicto: roto
        ? `${roto.titulo}: NO. ${roto.detalle}`
        : `Todo en orden: se puede facturar contra ${base.produccion ? 'PRODUCCIÓN' : 'homologación'}.`,
    };
  }
}

/* ==================================================================== *
 * EL PANEL DE DIAGNÓSTICO (fase 6)
 * ==================================================================== */

/** El techo de la lista del panel: para mirar más está el listado de Ventas. */
const TRABADAS_EN_PANEL = 20;

/**
 * DOS ENDPOINTS Y NO UNO, porque cuestan cosas muy distintas.
 *
 * `estado` no sale a la red: lee el entorno y mira el disco, así que la
 * pantalla lo puede pedir al abrir. `probar` hace el viaje completo a ARCA
 * —hasta ~10 segundos si hay que pedir un ticket de acceso nuevo— y lo dispara
 * el usuario apretando el botón. Fundirlos en uno haría que abrir
 * Configuración se cuelgue diez segundos contra un servicio ajeno.
 *
 * El permiso es `ventas.configuracion`: es la misma pantalla donde vive el
 * interruptor de la facturación, y quien decide prenderlo tiene que poder ver
 * si va a funcionar.
 */
@Controller('arca')
export class ArcaController {
  constructor(
    private readonly svc: ArcaService,
    private readonly cfg: ConfiguracionService,
    @Inject(DRIZZLE) private readonly db: Database,
  ) {}

  @Get('estado')
  @Permiso('ventas.configuracion')
  async estado() {
    const base = this.svc.estado();
    const [empresa, locales] = await Promise.all([
      this.cfg.get('empresa'),
      /* Los puntos de venta de cada local (0077). Salen del estado barato y no
       * de la prueba porque son un dato nuestro, no de ARCA: la tabla se ve
       * apenas se abre la pantalla, y "Probar conexión" le agrega el último
       * número autorizado de cada uno. */
      this.db.select({
        id: sucursales.id,
        nombre: sucursales.nombre,
        tipo: sucursales.tipo,
        puntoVenta: sucursales.puntoVenta,
        direccion: sucursales.direccion,
      }).from(sucursales).orderBy(sucursales.id),
    ]);
    return {
      ...base,
      /* El CUIT del certificado manda, pero si el del membrete es otro, el
       * papel y el comprobante dicen cosas distintas — y eso no lo nota nadie
       * hasta que lo mira un inspector. */
      avisos: diferenciasConEmpresa(empresa),
      sucursales: locales,
      /* Cuántos locales facturarían por la boca de expendio de otro. Con un
       * solo local es lo normal y no dice nada; con cinco, es un problema. */
      sinPuntoVenta: locales.filter((s) => !s.puntoVenta).length,
      trabadas: await this.trabadas(),
    };
  }

  @Post('probar')
  @Permiso('ventas.configuracion')
  probar() {
    return this.svc.diagnostico();
  }

  /**
   * LAS TRABADAS: las ventas que salieron como ticket provisorio porque ARCA
   * no contestó, y sigue sin haber factura.
   *
   * Es la misma lista que la pestaña ⚠ Sin facturar del listado de Ventas,
   * pero acotada y con el motivo adelante: acá no se viene a buscar una venta,
   * se viene a entender por qué se trabaron. Se ordenan de la MÁS VIEJA
   * primero — la que lleva tres días sin factura es la urgente, no la de
   * recién.
   */
  private async trabadas() {
    const donde = and(eq(ventas.facturarPendiente, true), ne(ventas.estado, 'anulada'));
    const [agg] = await this.db.select({
      cantidad: sql<number>`count(*)::int`,
      plata: sql<number>`coalesce(sum(${ventas.total}), 0)`,
      desde: sql<Date | null>`min(${ventas.fecha})`,
    }).from(ventas).where(donde);

    const filas = await this.db.select({
      id: ventas.id,
      tipo: ventas.tipo,
      puntoVenta: ventas.puntoVenta,
      numero: ventas.numero,
      fecha: ventas.fecha,
      total: ventas.total,
      motivo: ventas.facturarMotivo,
      clienteNombre: clientes.nombre,
      sucursalNombre: sucursales.nombre,
    }).from(ventas)
      .innerJoin(clientes, eq(clientes.id, ventas.clienteId))
      .leftJoin(sucursales, eq(sucursales.id, ventas.sucursalId))
      .where(donde)
      .orderBy(ventas.fecha, ventas.id)
      .limit(TRABADAS_EN_PANEL);

    return {
      cantidad: Number(agg?.cantidad) || 0,
      plata: Math.round((Number(agg?.plata) || 0) * 100) / 100,
      desde: agg?.desde ?? null,
      filas,
      /* Cuántas quedaron afuera del techo. Un panel que muestra 20 de 300 sin
       * decirlo miente por omisión. */
      ocultas: Math.max(0, (Number(agg?.cantidad) || 0) - filas.length),
    };
  }
}

@Module({
  imports: [ConfiguracionModule],
  controllers: [ArcaController],
  providers: [ArcaService],
  exports: [ArcaService],
})
export class ArcaModule {}
