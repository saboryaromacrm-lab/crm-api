/**
 * EL CLIENTE DE GOOGLE DRIVE (Respaldo a Drive, 29/9/2026)
 * ============================================================================
 * Habla con Google por HTTP directo (`fetch` de Node): son cinco llamadas y
 * una librería de cientos de módulos no aporta nada a cambio. El permiso que
 * se pide es `drive.file`: el sistema SOLO ve y toca lo que él mismo creó en
 * Drive (su carpeta de respaldos) — no puede leer ningún otro archivo.
 *
 * Nada acá guarda estado ni conoce la base: recibe lo que necesita y devuelve
 * el resultado. La conexión, el horario y la limpieza los decide
 * `drive.service.ts`.
 */
import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';

export const SCOPE_DRIVE = 'https://www.googleapis.com/auth/drive.file';
const URL_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const URL_TOKEN = 'https://oauth2.googleapis.com/token';
const URL_REVOCAR = 'https://oauth2.googleapis.com/revoke';
const API = 'https://www.googleapis.com/drive/v3';
const API_SUBIDA = 'https://www.googleapis.com/upload/drive/v3/files';
const NOMBRE_CARPETA = 'Respaldos ERP Sabor y Aroma';
/** Hasta el 29/9/2026 el sistema se llamaba «CRM» en estos nombres: la carpeta y las copias ya subidas se siguen reconociendo. */
const NOMBRE_CARPETA_ANTERIOR = 'Respaldos CRM Sabor y Aroma';
export const PREFIJO_ARCHIVO = 'respaldo-erp-';
const PREFIJOS_ANTERIORES = ['respaldo-crm-'];
/** ¿Es una copia hecha por este sistema? (Lo único que la limpieza puede borrar.) */
export const esCopiaDelSistema = (nombre: string) => [PREFIJO_ARCHIVO, ...PREFIJOS_ANTERIORES].some((p) => nombre.startsWith(p));

export interface ConfigGoogle { clientId: string; clientSecret: string; redirectUri: string }

/** Un error de Google con su código, para decidir qué hacer (reconectar o reintentar). */
export class ErrorGoogle extends Error {
  constructor(mensaje: string, readonly codigo: string, readonly estado: number) { super(mensaje); }
  /** La cuenta revocó el permiso o el token venció: hay que reconectar, no reintentar. */
  get desconectado() { return this.codigo === 'invalid_grant' || this.estado === 401; }
}

async function pedir(url: string, opciones: RequestInit & { ms?: number } = {}) {
  const { ms = 30_000, ...resto } = opciones;
  let r: Response;
  try {
    r = await fetch(url, { ...resto, signal: AbortSignal.timeout(ms) });
  } catch (e) {
    throw new ErrorGoogle(`No se pudo comunicar con Google: ${(e as Error).message}`, 'red', 0);
  }
  return r;
}

async function comoJson(r: Response) {
  const texto = await r.text();
  try { return texto ? JSON.parse(texto) : {}; } catch { return { raw: texto }; }
}

async function exigirOk(r: Response, que: string) {
  if (r.ok) return;
  const d: any = await comoJson(r);
  const codigo = d?.error?.errors?.[0]?.reason || d?.error?.status || (typeof d?.error === 'string' ? d.error : '') || String(r.status);
  const detalle = d?.error_description || d?.error?.message || (typeof d?.error === 'string' ? d.error : '') || `HTTP ${r.status}`;
  throw new ErrorGoogle(`${que}: ${detalle}`, codigo, r.status);
}

/** La dirección a la que se manda a la persona para que autorice el acceso. */
export function urlDeConsentimiento(cfg: ConfigGoogle, state: string) {
  const q = new URLSearchParams({
    client_id: cfg.clientId, redirect_uri: cfg.redirectUri, response_type: 'code', scope: SCOPE_DRIVE,
    // offline + consent: sin esto Google no devuelve el token que permite respaldar de madrugada.
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false', state,
  });
  return `${URL_AUTH}?${q}`;
}

export async function canjearCodigo(cfg: ConfigGoogle, code: string) {
  const r = await pedir(URL_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri, grant_type: 'authorization_code',
    }),
  });
  await exigirOk(r, 'Google no aceptó la autorización');
  const d: any = await comoJson(r);
  return { accessToken: String(d.access_token ?? ''), refreshToken: String(d.refresh_token ?? ''), scope: String(d.scope ?? '') };
}

export async function tokenDeAcceso(cfg: ConfigGoogle, refreshToken: string) {
  const r = await pedir(URL_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken, client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: 'refresh_token',
    }),
  });
  await exigirOk(r, 'Google no renovó el acceso');
  const d: any = await comoJson(r);
  return String(d.access_token);
}

/** Le dice a Google que este sistema ya no tiene permiso (al desconectar). Mejor esfuerzo. */
export async function revocar(token: string) {
  try {
    await pedir(`${URL_REVOCAR}?token=${encodeURIComponent(token)}`, { method: 'POST', ms: 10_000 });
  } catch { /* si falla, el dueño puede quitarlo desde su cuenta de Google */ }
}

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

/** Con qué cuenta quedó conectado (para mostrarlo). Si Google no lo da, vacío. */
export async function emailDe(accessToken: string): Promise<string> {
  try {
    const r = await pedir(`${API}/about?fields=user(emailAddress)`, { headers: auth(accessToken) });
    if (!r.ok) return '';
    return String(((await comoJson(r)) as any)?.user?.emailAddress ?? '');
  } catch { return ''; }
}

/**
 * La carpeta donde caen las copias. Si la guardada sigue viva se usa (y se le
 * pone el nombre actual si tenía el anterior); si la borraron (o nunca hubo) se
 * busca una con el nombre actual o el anterior creada por el sistema y, si no
 * está, se crea. Devuelve el id.
 */
export async function asegurarCarpeta(accessToken: string, idGuardado: string): Promise<string> {
  if (idGuardado) {
    const r = await pedir(`${API}/files/${encodeURIComponent(idGuardado)}?fields=id,trashed,name`, { headers: auth(accessToken) });
    if (r.ok) {
      const d: any = await comoJson(r);
      if (d?.id && !d.trashed) {
        if (d.name !== NOMBRE_CARPETA) await renombrar(accessToken, String(d.id), NOMBRE_CARPETA);
        return String(d.id);
      }
    } else if (r.status !== 404) {
      await exigirOk(r, 'No se pudo revisar la carpeta de Drive');
    }
  }
  const q = `(name = '${NOMBRE_CARPETA}' or name = '${NOMBRE_CARPETA_ANTERIOR}') and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const b = await pedir(`${API}/files?${new URLSearchParams({ q, fields: 'files(id,name)', pageSize: '1' })}`, { headers: auth(accessToken) });
  await exigirOk(b, 'No se pudo buscar la carpeta en Drive');
  const hallada: any = await comoJson(b);
  if (hallada?.files?.[0]?.id) {
    if (hallada.files[0].name !== NOMBRE_CARPETA) await renombrar(accessToken, String(hallada.files[0].id), NOMBRE_CARPETA);
    return String(hallada.files[0].id);
  }
  const c = await pedir(`${API}/files?fields=id`, {
    method: 'POST',
    headers: { ...auth(accessToken), 'content-type': 'application/json' },
    body: JSON.stringify({ name: NOMBRE_CARPETA, mimeType: 'application/vnd.google-apps.folder' }),
  });
  await exigirOk(c, 'No se pudo crear la carpeta en Drive');
  return String(((await comoJson(c)) as any).id);
}

/** Le cambia el nombre a un archivo o carpeta del sistema. Mejor esfuerzo: si falla, la copia igual sale. */
async function renombrar(accessToken: string, id: string, nombre: string) {
  try {
    await pedir(`${API}/files/${encodeURIComponent(id)}?fields=id`, {
      method: 'PATCH',
      headers: { ...auth(accessToken), 'content-type': 'application/json' },
      body: JSON.stringify({ name: nombre }),
    });
  } catch { /* el nombre es cosmético */ }
}

/** Sube un archivo de disco a la carpeta (subida reanudable, en flujo). Devuelve el id. */
export async function subirArchivo(accessToken: string, carpetaId: string, nombre: string, ruta: string): Promise<string> {
  const tamano = statSync(ruta).size;
  const inicio = await pedir(`${API_SUBIDA}?uploadType=resumable&fields=id`, {
    method: 'POST',
    headers: {
      ...auth(accessToken), 'content-type': 'application/json; charset=UTF-8',
      'x-upload-content-type': 'application/octet-stream', 'x-upload-content-length': String(tamano),
    },
    body: JSON.stringify({ name: nombre, parents: [carpetaId] }),
  });
  await exigirOk(inicio, 'Drive no aceptó iniciar la subida');
  const destino = inicio.headers.get('location');
  if (!destino) throw new ErrorGoogle('Drive no devolvió dónde subir el archivo.', 'sin_location', 0);
  const r = await pedir(destino, {
    method: 'PUT',
    headers: { 'content-length': String(tamano), 'content-type': 'application/octet-stream' },
    body: Readable.toWeb(createReadStream(ruta)) as any,
    // @ts-expect-error: `duplex` es obligatorio en Node para cuerpos en flujo y el tipo de fetch no lo incluye
    duplex: 'half',
    ms: 30 * 60_000,
  });
  await exigirOk(r, 'Drive no aceptó el archivo');
  return String(((await comoJson(r)) as any).id);
}

export interface ArchivoDrive { id: string; name: string; createdTime: string; size: string }

/** Las copias que hay en la carpeta, de la más nueva a la más vieja. */
export async function listarCopias(accessToken: string, carpetaId: string): Promise<ArchivoDrive[]> {
  const out: ArchivoDrive[] = [];
  let pagina = '';
  do {
    const q = `'${carpetaId}' in parents and trashed = false`;
    const r = await pedir(`${API}/files?${new URLSearchParams({
      q, fields: 'nextPageToken,files(id,name,createdTime,size)', orderBy: 'createdTime desc', pageSize: '200',
      ...(pagina ? { pageToken: pagina } : {}),
    })}`, { headers: auth(accessToken) });
    await exigirOk(r, 'No se pudieron listar las copias de Drive');
    const d: any = await comoJson(r);
    out.push(...(d.files ?? []));
    pagina = d.nextPageToken ?? '';
  } while (pagina);
  return out;
}

export async function borrarArchivo(accessToken: string, id: string) {
  const r = await pedir(`${API}/files/${encodeURIComponent(id)}`, { method: 'DELETE', headers: auth(accessToken) });
  if (r.status === 404) return;
  await exigirOk(r, 'No se pudo borrar una copia vieja de Drive');
}

export const urlDeCarpeta = (id: string) => (id ? `https://drive.google.com/drive/folders/${id}` : '');
