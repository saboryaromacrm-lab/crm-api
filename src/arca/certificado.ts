/**
 * ARCA — LA CLAVE PRIVADA Y EL PEDIDO DE CERTIFICADO
 * ============================================================================
 * El trámite del certificado tiene un paso que no se hace en la web de ARCA:
 * uno genera una **clave privada** y un **pedido** (CSR), sube el pedido, y
 * ARCA devuelve el certificado firmado. Ese paso se hacía con dos comandos de
 * `openssl` a mano, y ahí se pierde media tarde:
 *
 *  · El `serialNumber` del pedido tiene que ser **literalmente** `CUIT ` más
 *    los once dígitos. Un guion de más y ARCA lo rechaza sin decir por qué.
 *  · En la máquina del dueño `openssl` está roto de dos formas distintas
 *    (`OPENSSL_CONF` apunta a un archivo que dejó PostgreSQL y no existe, y
 *    Git Bash convierte el `/C=AR/...` en una ruta de Windows). Las dos fallan
 *    con errores que no hablan de certificados.
 *
 * LA CLAVE PRIVADA NUNCA VUELVE AL NAVEGADOR. Se genera acá y se escribe
 * directamente donde apunta `ARCA_KEY_PATH` —el volumen montado, fuera de la
 * imagen—, con permisos 0600. Lo único que viaja es el CSR, que es público:
 * está hecho para dárselo a ARCA. Un endpoint que devolviera la clave la
 * pondría en el historial del navegador, en la carpeta de Descargas y en
 * cualquier proxy del camino.
 *
 * SE USA `node-forge` Y NO EL BINARIO `openssl` por la misma razón que el
 * WSAA: el contenedor viene pelado. Verificado que el pedido que arma esto lo
 * lee `openssl` con el mismo subject y la firma le verifica OK.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as forge from 'node-forge';
import { ARCA, resetDisponible } from './config';

/** El OID de `serialNumber`. Va por número porque forge no lo tiene por nombre. */
const OID_SERIAL_NUMBER = '2.5.4.5';

export interface DatosPedido {
  /** La razón social ANTE ARCA, no el nombre de fantasía. */
  razonSocial: string;
  /** Un nombre para identificar este certificado. Sin espacios ni acentos. */
  alias: string;
}

export interface ResultadoPedido {
  csr: string;
  /** `false` = se reusó la clave que ya estaba (no se pisa jamás). */
  claveNueva: boolean;
  subject: string;
  keyPath: string;
}

/** Un error que la pantalla puede mostrar tal cual. */
export class ErrorCertificado extends Error {}

/**
 * ¿LA CARPETA ES UN VOLUMEN DE VERDAD, O ES EL DISCO DEL CONTENEDOR?
 * ============================================================================
 * "Que la carpeta exista" NO alcanza, y esto se aprendió perdiendo un
 * certificado (20/8/2026). El `Dockerfile` crea `/certs` en la imagen —hace
 * falta, para que un volumen nuevo herede el dueño `node`—, y con eso
 * `existsSync` empezó a dar `true` **aunque no hubiera ningún volumen
 * montado**. La clave se generó contra el disco del contenedor, el trámite
 * salió perfecto, y el deploy siguiente se llevó clave y certificado. El
 * chequeo de "existe la carpeta" pasó de proteger a tapar el problema.
 *
 * La pregunta correcta es si esa carpeta es un **punto de montaje**. Se lee de
 * `/proc/self/mountinfo`, donde el campo 5 es el destino de cada montaje: si
 * la carpeta (o algún padre que no sea `/`) figura ahí, lo que se escriba
 * sobrevive al contenedor.
 *
 * Y solo importa **adentro de un contenedor**: en un servidor común, una
 * carpeta del disco raíz persiste perfectamente. Por eso se mira primero si
 * estamos en uno; si no, no hay nada que advertir.
 *
 * Devuelve `null` cuando no se puede saber (Windows, o sin `/proc`): en
 * desarrollo no se avisa nada, que es lo correcto — ahí el disco es el disco.
 */
export function volumenPersistente(ruta: string): boolean | null {
  const carpeta = dirname(ruta);
  if (!carpeta || !existsSync('/proc/self/mountinfo')) return null;

  let montajes: string[];
  try {
    montajes = readFileSync('/proc/self/mountinfo', 'utf8').split('\n');
  } catch {
    return null;
  }

  /* ¿Contenedor? El `/.dockerenv` es el indicio clásico; el otro es que la
   * raíz esté montada sobre `overlay`, que es como corre cualquier imagen. */
  const raizOverlay = montajes.some((l) => {
    const campos = l.split(' - ');
    return campos[0]?.split(' ')[4] === '/' && /^\s*(overlay|aufs)\b/.test(campos[1] ?? '');
  });
  if (!existsSync('/.dockerenv') && !raizOverlay) return null;

  /* El destino de cada montaje, sin contar la raíz: esa es justamente la que
   * se borra. Sirve un padre, porque montar en `/certs` cubre `/certs/x`. */
  const destinos = montajes
    .map((l) => l.split(' ')[4])
    .filter((d): d is string => !!d && d !== '/');

  return destinos.some((d) => carpeta === d || carpeta.startsWith(`${d}/`));
}

/** Las dos rutas tienen que estar configuradas y su carpeta tiene que existir. */
function exigirRuta(ruta: string, cual: string, variable: string) {
  if (!ruta) {
    throw new ErrorCertificado(
      `Falta ${variable}: sin esa variable no hay dónde guardar ${cual}. `
      + 'Se configura en el servidor, apuntando al volumen montado de certificados.',
    );
  }
  const carpeta = dirname(ruta);
  if (!existsSync(carpeta)) {
    throw new ErrorCertificado(
      `La carpeta ${carpeta} no existe en el servidor. Es el volumen donde van los `
      + 'certificados: hay que montarlo antes (nunca adentro de la imagen, que se '
      + 'reconstruye entera en cada deploy).',
    );
  }
  /*
   * SE CORTA ACÁ A PROPÓSITO, aunque escribir funcionaría. Generar la clave
   * contra el disco del contenedor no falla: falla el deploy siguiente, con el
   * certificado ya emitido y el trámite hecho al pedo. Mejor no dejar empezar.
   */
  if (volumenPersistente(ruta) === false) {
    throw new ErrorCertificado(
      `${carpeta} existe pero NO es un volumen montado: es el disco del contenedor, y se borra `
      + 'entero en el próximo deploy. La clave que generes ahora se pierde, y con ella el '
      + 'certificado que ARCA te emita. Montá el volumen en Dokploy (Advanced › Volumes › Add, '
      + `Mount Path ${carpeta}), hacé Redeploy, y volvé a intentar.`,
    );
  }
}

/**
 * GENERA LA CLAVE (si no está) Y ARMA EL PEDIDO.
 *
 * **Nunca pisa una clave existente.** Es la regla que más importa acá: si ya
 * hay un certificado funcionando, escribir una clave nueva encima lo deja
 * muerto en el acto —el `.crt` deja de corresponderse con ella— y no hay
 * vuelta atrás, porque la clave vieja no se puede recuperar. Cuando ya existe
 * se REUSA para armar el pedido, que además es el caso real de "perdí el .csr"
 * o "tengo que pedir el certificado de nuevo".
 *
 * Para forzar una clave nueva hay que borrar el archivo en el servidor a mano.
 * Es incómodo a propósito.
 */
export function generarPedido(datos: DatosPedido): ResultadoPedido {
  exigirRuta(ARCA.keyPath, 'la clave privada', 'ARCA_KEY_PATH');

  const cuit = ARCA.cuit;
  if (!cuit || cuit.length !== 11) {
    throw new ErrorCertificado(
      'Falta ARCA_CUIT, o no tiene 11 dígitos. El pedido lleva el CUIT adentro y '
      + 'tiene que ser exactamente el del contribuyente que va a facturar.',
    );
  }
  const razonSocial = (datos.razonSocial ?? '').trim();
  if (!razonSocial) throw new ErrorCertificado('Poné la razón social, como figura en ARCA.');
  /* El alias identifica al certificado dentro de tu CUIT. ARCA lo trata como
   * un nombre de sistema: sin espacios ni caracteres raros. */
  const alias = (datos.alias ?? '').trim().replace(/[^A-Za-z0-9._-]/g, '');
  if (!alias) throw new ErrorCertificado('Poné un alias (letras, números, guiones).');

  let clave: forge.pki.rsa.PrivateKey;
  let publica: forge.pki.rsa.PublicKey;
  let claveNueva = false;

  if (existsSync(ARCA.keyPath)) {
    try {
      clave = forge.pki.privateKeyFromPem(readFileSync(ARCA.keyPath, 'utf8'));
    } catch {
      throw new ErrorCertificado(
        `Ya hay un archivo en ${ARCA.keyPath} pero no es una clave privada legible. `
        + 'Revisalo antes de seguir: si es la clave de un certificado en uso, '
        + 'reemplazarla lo dejaría inservible.',
      );
    }
    publica = forge.pki.setRsaPublicKey(clave.n, clave.e);
  } else {
    const par = forge.pki.rsa.generateKeyPair(2048);
    clave = par.privateKey;
    publica = par.publicKey;
    /* 0600: la lee el dueño del proceso y nadie más. En Windows es casi
     * decorativo; en el servidor, que es Linux, no lo es. */
    writeFileSync(ARCA.keyPath, forge.pki.privateKeyToPem(clave), { mode: 0o600 });
    claveNueva = true;
  }

  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = publica;
  csr.setSubject([
    { name: 'countryName', value: 'AR' },
    { name: 'organizationName', value: razonSocial },
    { name: 'commonName', value: alias },
    /* LA LÍNEA QUE HACE FALLAR EL TRÁMITE si sale mal: ARCA la compara letra
     * por letra contra el CUIT que dice representar. */
    { type: OID_SERIAL_NUMBER, value: `CUIT ${cuit}` },
  ] as any);
  csr.sign(clave, forge.md.sha256.create());

  return {
    csr: forge.pki.certificationRequestToPem(csr),
    claveNueva,
    subject: `C=AR, O=${razonSocial}, CN=${alias}, serialNumber=CUIT ${cuit}`,
    keyPath: ARCA.keyPath,
  };
}

export interface ResultadoInstalacion {
  vence: Date;
  emisor: string;
  subject: string;
  certPath: string;
}

/**
 * GUARDA EL CERTIFICADO QUE DEVOLVIÓ ARCA, después de comprobar que sirve.
 *
 * Tres controles, y los tres evitan un fallo que después aparece disfrazado de
 * otra cosa —un "Certificado bloqueado" del WSAA no dice cuál de estos tres
 * problemas tenés:
 *
 *  1. **Que se corresponda con la clave.** Es el error más fácil de cometer
 *     (el `.crt` de homologación pegado en producción, o el de un pedido
 *     anterior) y el más difícil de diagnosticar después.
 *  2. **Que el CUIT sea el nuestro.** Un certificado de otro contribuyente es
 *     un certificado perfectamente válido que no sirve para nada acá.
 *  3. **Que no esté vencido.** Los de ARCA duran dos años y se renuevan; uno
 *     vencido falla en el login y el mensaje habla de otra cosa.
 */
export function instalarCertificado(pem: string): ResultadoInstalacion {
  exigirRuta(ARCA.certPath, 'el certificado', 'ARCA_CERT_PATH');
  if (!existsSync(ARCA.keyPath)) {
    throw new ErrorCertificado(
      'Todavía no hay clave privada en el servidor. Generá primero la clave y el pedido: '
      + 'el certificado no sirve de nada sin la clave con la que se pidió.',
    );
  }

  const texto = String(pem ?? '').trim();
  if (!/-----BEGIN CERTIFICATE-----/.test(texto)) {
    throw new ErrorCertificado(
      'Eso no parece un certificado. Tiene que empezar con "-----BEGIN CERTIFICATE-----" '
      + 'y terminar con "-----END CERTIFICATE-----" — abrí el .crt con el Bloc de notas y '
      + 'copiá todo, esas dos líneas incluidas.',
    );
  }

  let cert: forge.pki.Certificate;
  try {
    cert = forge.pki.certificateFromPem(texto);
  } catch (e) {
    throw new ErrorCertificado(`El certificado no se pudo leer: ${(e as Error).message}`);
  }

  /* 1. ¿Es de nuestra clave? */
  const clave = forge.pki.privateKeyFromPem(readFileSync(ARCA.keyPath, 'utf8'));
  const nuestra = forge.pki.publicKeyToPem(forge.pki.setRsaPublicKey(clave.n, clave.e));
  const suya = forge.pki.publicKeyToPem(cert.publicKey as forge.pki.rsa.PublicKey);
  if (nuestra !== suya) {
    throw new ErrorCertificado(
      'Este certificado NO se corresponde con la clave privada del servidor: se pidió con otra. '
      + 'Suele pasar al mezclar homologación con producción, o al pegar el certificado de un '
      + 'pedido anterior. Generá el pedido de nuevo y subí a ARCA ESE .csr.',
    );
  }

  /* 2. ¿Es de nuestro CUIT? */
  const serial = cert.subject.attributes
    .find((a: any) => a.type === OID_SERIAL_NUMBER || a.shortName === 'serialNumber');
  const cuitDelCert = String(serial?.value ?? '').replace(/\D/g, '');
  if (cuitDelCert && ARCA.cuit && cuitDelCert !== ARCA.cuit) {
    throw new ErrorCertificado(
      `El certificado es del CUIT ${cuitDelCert} y acá se factura con el ${ARCA.cuit}. `
      + 'ARCA compara los dos y rechaza todo si no coinciden.',
    );
  }

  /* 3. ¿Está vigente? */
  const ahora = new Date();
  if (cert.validity.notAfter < ahora) {
    throw new ErrorCertificado(
      `Este certificado venció el ${cert.validity.notAfter.toLocaleDateString('es-AR')}. `
      + 'Hay que pedir uno nuevo en ARCA con un pedido nuevo.',
    );
  }
  if (cert.validity.notBefore > ahora) {
    throw new ErrorCertificado(
      `Este certificado recién empieza a valer el ${cert.validity.notBefore.toLocaleDateString('es-AR')}.`,
    );
  }

  writeFileSync(ARCA.certPath, `${texto}\n`, { mode: 0o644 });
  /* Sin esto el sistema sigue creyendo que no hay certificado: `arcaDisponible`
   * cachea el resultado de mirar el disco. */
  resetDisponible();

  const nombre = (attrs: any[]) => attrs
    .filter((a) => a.shortName === 'CN' || a.shortName === 'O')
    .map((a) => a.value).join(' · ') || '—';

  return {
    vence: cert.validity.notAfter,
    emisor: nombre(cert.issuer.attributes),
    subject: nombre(cert.subject.attributes),
    certPath: ARCA.certPath,
  };
}

/** Lo que la pantalla necesita saber del certificado que ya está instalado. */
export function certificadoInstalado() {
  if (!ARCA.certPath || !existsSync(ARCA.certPath)) return null;
  try {
    const cert = forge.pki.certificateFromPem(readFileSync(ARCA.certPath, 'utf8'));
    const dias = Math.floor((cert.validity.notAfter.getTime() - Date.now()) / 86_400_000);
    return {
      vence: cert.validity.notAfter,
      /* Los de ARCA duran dos años. Avisar ANTES sirve: renovarlo es un
       * trámite, y enterarse el día que deja de facturar es tarde. */
      diasParaVencer: dias,
      subject: cert.subject.attributes
        .filter((a: any) => a.shortName === 'CN' || a.shortName === 'O')
        .map((a: any) => a.value).join(' · '),
    };
  } catch {
    return { ilegible: true as const };
  }
}

/** ¿Hay clave privada en el servidor? (nunca se devuelve su contenido) */
export function hayClave() {
  if (!ARCA.keyPath || !existsSync(ARCA.keyPath)) return null;
  const st = statSync(ARCA.keyPath);
  return { desde: st.mtime, ruta: ARCA.keyPath };
}
