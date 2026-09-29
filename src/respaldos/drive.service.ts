/**
 * RESPALDO A GOOGLE DRIVE (Sistema › Respaldos, 29/9/2026)
 * ============================================================================
 * Pedido del dueño: que el sistema mande solo, todos los días a la hora que él
 * programe —y también a mano—, una copia de la base a su Drive.
 *
 * CÓMO SE COMPONE
 *   · conexión  — la persona autoriza UNA vez en Google (OAuth, permiso
 *                 `drive.file`: solo ve lo que el sistema crea). Se guarda un
 *                 token que no vence, CIFRADO, en `respaldo_drive`.
 *   · copia     — el mismo volcado de la descarga manual (`volcado.ts`), en
 *                 flujo: SQL → gzip → (cifrado) → archivo temporal → Drive. La
 *                 memoria máxima es la de la tabla más grande, no la de la base.
 *   · horario   — un reloj chico dentro del proceso (sin librerías): cada
 *                 minuto mira si ya pasó la hora de hoy y todavía no hay copia
 *                 buena. Si el servidor estaba caído a esa hora, la hace cuando
 *                 vuelve. Un candado de Postgres evita que dos instancias la
 *                 hagan a la vez.
 *   · limpieza  — borra de la carpeta las copias con más de N días, pero
 *                 nunca deja menos de 3.
 *
 * LO QUE FALLA, SE VE: cada intento deja su resultado en la tabla y la
 * pantalla lo muestra en rojo. Si Google revoca el permiso, el sistema deja de
 * insistir y pide reconectar — no reintenta en silencio para siempre.
 */
import {
  BadRequestException, Body, Controller, ForbiddenException, Get, Header, Inject, Injectable, Logger, Module,
  OnModuleDestroy, OnModuleInit, Post, Query, Res,
} from '@nestjs/common';
import type { Response } from 'express';
import type { Pool } from 'pg';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { IsBoolean, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { eq } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import { Auth, Permiso, Publico, type Sesion } from '../auth/auth.decoradores';
import { respaldoDrive } from '../db/schema';
import { AuditoriaModule, AuditoriaService } from '../auditoria/auditoria.module';
import { cifrarArchivo, cifrarTexto, descifrarTexto } from './cifrado';
import {
  ErrorGoogle, PREFIJO_ARCHIVO, asegurarCarpeta, borrarArchivo, canjearCodigo, emailDe, listarCopias, revocar,
  subirArchivo, tokenDeAcceso, urlDeCarpeta, urlDeConsentimiento, type ConfigGoogle,
} from './google';
import { volcarA } from './volcado';

const ZONA = 'America/Argentina/Buenos_Aires';
/** Las copias que nunca se borran, por viejas que sean: si algo saliera mal, siempre queda esto. */
const MINIMO_A_CONSERVAR = 3;
/** Si un intento falla, cuánto se espera para el siguiente. */
const REINTENTO_MS = 30 * 60_000;
const DIAS_VALIDEZ_STATE_MS = 10 * 60_000;

/** 'AAAA-MM-DD' y 'HH:MM' de un instante, en hora argentina. */
const enAr = (d: Date) => {
  const [dia, hora] = d.toLocaleString('sv-SE', { timeZone: ZONA }).split(' ');
  return { dia, hhmm: hora.slice(0, 5) };
};
/** El instante exacto de `hora` en el día `dia` (Argentina no tiene horario de verano: -03:00 fijo). */
const instanteAr = (dia: string, hhmm: string) => new Date(`${dia}T${hhmm}:00-03:00`);

class ConfigurarDriveDto {
  @IsOptional() @IsBoolean() activo?: boolean;
  @IsOptional() @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'La hora va como HH:MM (por ejemplo 03:00).' }) hora?: string;
  @IsOptional() @IsInt() @Min(3, { message: 'Se guardan al menos 3 días.' }) @Max(365) dias?: number;
  @IsOptional() @IsBoolean() cifrar?: boolean;
}

@Injectable()
export class RespaldoDriveService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('RespaldoDrive');
  private reloj: ReturnType<typeof setInterval> | null = null;
  private corriendo = false;

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditoriaService,
  ) {}

  private get pool(): Pool { return (this.db as any).$client as Pool; }

  /* ------------------------- configuración del entorno ------------------------- */
  private google(): ConfigGoogle | null {
    const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
    const redirectUri = process.env.GOOGLE_REDIRECT_URI?.trim();
    return clientId && clientSecret && redirectUri ? { clientId, clientSecret, redirectUri } : null;
  }
  private clave() { return process.env.BACKUP_CLAVE?.trim() || ''; }

  /** A dónde se vuelve al terminar de autorizar: el CRM (el primer origen permitido). */
  private urlCrm() {
    const explicita = process.env.CRM_URL?.trim();
    if (explicita) return explicita.replace(/\/$/, '');
    const primero = (process.env.CORS_ORIGINS ?? '').split(',').map((x) => x.trim()).find((x) => x.startsWith('https://'));
    return (primero ?? 'http://localhost:5173').replace(/\/$/, '');
  }

  /* ------------------------------- la fila única ------------------------------- */
  private async fila() {
    const [f] = await this.db.select().from(respaldoDrive).where(eq(respaldoDrive.id, 1)).limit(1);
    return f ?? null;
  }
  private async guardar(cambios: Partial<typeof respaldoDrive.$inferInsert>) {
    await this.db.insert(respaldoDrive).values({ id: 1, ...cambios })
      .onConflictDoUpdate({ target: respaldoDrive.id, set: cambios });
  }

  private refreshToken(f: { tokenCifrado: string }, cfg: ConfigGoogle): string {
    try { return descifrarTexto(f.tokenCifrado, cfg.clientSecret); } catch { return ''; }
  }

  /* ---------------------------------- estado ---------------------------------- */
  async estado() {
    const f = await this.fila();
    const cfg = this.google();
    const conectado = !!f?.tokenCifrado;
    const programada = f && conectado && f.activo ? this.proximaCorrida(f) : null;
    return {
      /** El servidor tiene las variables de Google cargadas (si no, no se puede conectar). */
      disponible: !!cfg,
      /** El servidor tiene la contraseña de cifrado cargada. */
      tieneClave: !!this.clave(),
      conectado,
      email: f?.email ?? '',
      carpetaUrl: urlDeCarpeta(f?.carpetaId ?? ''),
      activo: f?.activo ?? true,
      hora: f?.hora ?? '03:00',
      dias: f?.dias ?? 30,
      cifrar: f?.cifrar ?? true,
      conectadoEn: f?.conectadoEn ?? null,
      ultimoIntento: f?.ultimoIntento ?? null,
      ultimoOk: f?.ultimoOk ?? null,
      ultimoArchivo: f?.ultimoArchivo ?? '',
      ultimoTamano: Number(f?.ultimoTamano ?? 0),
      ultimoError: f?.ultimoError ?? '',
      ultimoOrigen: f?.ultimoOrigen ?? '',
      corriendo: this.corriendo,
      proxima: programada,
    };
  }

  /** Cuándo toca la próxima copia programada (ISO), o null. */
  private proximaCorrida(f: { hora: string; ultimoOk: Date | null }): string {
    const ahora = new Date();
    const { dia } = enAr(ahora);
    const hoy = instanteAr(dia, f.hora);
    const hoyHecha = !!f.ultimoOk && f.ultimoOk >= hoy;
    if (!hoyHecha && ahora >= hoy) return ahora.toISOString();
    if (!hoyHecha) return hoy.toISOString();
    return instanteAr(enAr(new Date(hoy.getTime() + 26 * 3600_000)).dia, f.hora).toISOString();
  }

  /* --------------------------------- conectar --------------------------------- */
  /** `state` firmado: el callback no trae sesión, esto es lo que prueba que el pedido salió de acá. */
  private firmar(payload: object, secreto: string) {
    const cuerpo = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${cuerpo}.${createHmac('sha256', secreto).update(cuerpo).digest('hex')}`;
  }
  private verificar(state: string, secreto: string): any | null {
    const [cuerpo, firma] = String(state ?? '').split('.');
    if (!cuerpo || !firma) return null;
    const esperada = createHmac('sha256', secreto).update(cuerpo).digest('hex');
    const a = Buffer.from(firma);
    const b = Buffer.from(esperada);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try {
      const p = JSON.parse(Buffer.from(cuerpo, 'base64url').toString());
      return typeof p?.e === 'number' && p.e > Date.now() ? p : null;
    } catch { return null; }
  }

  urlParaConectar(usuarioId: number | null) {
    const cfg = this.google();
    if (!cfg) {
      throw new BadRequestException(
        'Falta configurar Google en el servidor: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET y GOOGLE_REDIRECT_URI (en Dokploy).',
      );
    }
    return { url: urlDeConsentimiento(cfg, this.firmar({ u: usuarioId, e: Date.now() + DIAS_VALIDEZ_STATE_MS }, cfg.clientSecret)) };
  }

  /** El regreso de Google. Siempre termina redirigiendo al CRM, con el resultado en la dirección. */
  async alVolver(q: { code?: string; state?: string; error?: string }, res: Response) {
    const crm = this.urlCrm();
    const salir = (r: string, motivo = '') => res.redirect(302, `${crm}/sistema?respaldo=${r}${motivo ? `&motivo=${encodeURIComponent(motivo)}` : ''}`);
    const cfg = this.google();
    if (!cfg) return salir('error', 'El servidor no tiene configurado Google.');
    const st = this.verificar(q.state ?? '', cfg.clientSecret);
    if (!st) return salir('error', 'El pedido de conexión venció o no es válido. Volvé a intentar desde Sistema › Respaldos.');
    if (q.error) return salir('error', q.error === 'access_denied' ? 'No diste el permiso en Google.' : q.error);
    if (!q.code) return salir('error', 'Google no devolvió el código de autorización.');
    try {
      const t = await canjearCodigo(cfg, q.code);
      if (!t.refreshToken) {
        return salir('error', 'Google no entregó el acceso permanente. Quitá el acceso del sistema en tu cuenta de Google (Seguridad › Accesos de terceros) y volvé a conectar.');
      }
      if (!t.scope.includes('drive.file')) return salir('error', 'Falta el permiso de Drive: tildalo al autorizar.');
      const email = await emailDe(t.accessToken);
      const previa = await this.fila();
      await this.guardar({
        email, tokenCifrado: cifrarTexto(t.refreshToken, cfg.clientSecret), conectadoEn: new Date(),
        carpetaId: previa?.carpetaId ?? '', ultimoError: '',
      });
      await this.audit.registrar([{
        entidad: 'sistema', entidadId: 0, ambito: 'Respaldos', campo: 'Google Drive conectado',
        usuarioId: st.u ?? null, despues: email || 'cuenta de Google',
      }]);
      return salir('conectado');
    } catch (e) {
      this.log.warn(`conectar: ${(e as Error).message}`);
      return salir('error', (e as Error).message);
    }
  }

  async desconectar(usuarioId: number | null) {
    const f = await this.fila();
    const cfg = this.google();
    if (f?.tokenCifrado && cfg) {
      const t = this.refreshToken(f, cfg);
      if (t) await revocar(t);
    }
    await this.guardar({ tokenCifrado: '', email: '', ultimoError: '' });
    await this.audit.registrar([{
      entidad: 'sistema', entidadId: 0, ambito: 'Respaldos', campo: 'Google Drive desconectado', usuarioId,
      despues: 'Las copias que ya están en Drive no se tocan.',
    }]);
    return { ok: true };
  }

  async configurar(dto: ConfigurarDriveDto, usuarioId: number | null) {
    if (dto.cifrar === true && !this.clave()) {
      throw new BadRequestException('Para cifrar falta la contraseña en el servidor (BACKUP_CLAVE, en Dokploy).');
    }
    const cambios: Partial<typeof respaldoDrive.$inferInsert> = {};
    if (dto.activo != null) cambios.activo = dto.activo;
    if (dto.hora != null) cambios.hora = dto.hora;
    if (dto.dias != null) cambios.dias = dto.dias;
    if (dto.cifrar != null) cambios.cifrar = dto.cifrar;
    if (!Object.keys(cambios).length) return this.estado();
    const antes = await this.fila();
    await this.guardar(cambios);
    await this.audit.registrar([{
      entidad: 'sistema', entidadId: 0, ambito: 'Respaldos', campo: 'Respaldo a Drive: configuración', usuarioId,
      antes: antes ? `${antes.activo ? 'activo' : 'apagado'} · ${antes.hora} · ${antes.dias} días · ${antes.cifrar ? 'cifrado' : 'sin cifrar'}` : '',
      despues: Object.entries(cambios).map(([k, v]) => `${k}: ${v}`).join(' · '),
    }]);
    return this.estado();
  }

  /* ---------------------------------- la copia ---------------------------------- */
  /** Pedido de una copia ahora: arranca en segundo plano (tarda) y la pantalla mira el estado. */
  async pedirAhora(usuarioId: number | null) {
    const f = await this.fila();
    if (!f?.tokenCifrado) throw new BadRequestException('Todavía no está conectado Google Drive.');
    if (this.corriendo) throw new BadRequestException('Ya hay una copia en marcha: esperá a que termine.');
    void this.respaldar('manual', usuarioId);
    return { ok: true, iniciado: true };
  }

  /**
   * Hace UNA copia completa y la sube. Nunca lanza: el resultado —bueno o
   * malo— queda en la fila y en la auditoría. Devuelve si salió bien.
   */
  async respaldar(origen: 'programado' | 'manual', usuarioId: number | null): Promise<boolean> {
    if (this.corriendo) return false;
    const cfg = this.google();
    const f = await this.fila();
    if (!cfg || !f?.tokenCifrado) return false;
    this.corriendo = true;
    const cli = await this.pool.connect();
    let carpetaTmp = '';
    try {
      // Un solo servidor a la vez: si otro ya está respaldando, este se retira.
      const { rows } = await cli.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', ['respaldo:drive']);
      if (!rows[0]?.ok) return false;

      await this.guardar({ ultimoIntento: new Date(), ultimoOrigen: origen });
      const clave = this.clave();
      if (f.cifrar && !clave) throw new Error('El respaldo está configurado con cifrado pero falta BACKUP_CLAVE en el servidor.');

      const ahora = enAr(new Date());
      const base = `${PREFIJO_ARCHIVO}${ahora.dia}-${ahora.hhmm.replace(':', '')}`;
      carpetaTmp = await mkdtemp(join(tmpdir(), 'respaldo-'));
      const rutaGz = join(carpetaTmp, `${base}.sql.gz`);
      let rutaFinal = rutaGz;
      let nombre = `${base}.sql.gz`;

      // 1. El volcado, comprimido, a un archivo temporal.
      const gz = createGzip({ level: 6 });
      const salida = createWriteStream(rutaGz);
      const escrito = pipeline(gz, salida);
      escrito.catch(() => { /* el error real se maneja abajo */ });
      let resumen;
      try {
        resumen = await volcarA(this.pool, async (s) => { if (!gz.write(s)) await once(gz, 'drain'); });
        gz.end();
        await escrito;
      } catch (e) {
        gz.destroy();
        throw e;
      }

      // 2. Cifrado (si está pedido): el archivo sin cifrar se borra enseguida.
      if (f.cifrar) {
        rutaFinal = `${rutaGz}.enc`;
        nombre = `${base}.sql.gz.enc`;
        await cifrarArchivo(rutaGz, rutaFinal, clave);
        await rm(rutaGz, { force: true });
      }
      const tamano = (await stat(rutaFinal)).size;

      // 3. Google: acceso, carpeta, subida.
      const refresh = this.refreshToken(f, cfg);
      if (!refresh) throw new ErrorGoogle('No se pudo leer el acceso guardado: hay que reconectar.', 'invalid_grant', 401);
      const acceso = await tokenDeAcceso(cfg, refresh);
      const carpetaId = await asegurarCarpeta(acceso, f.carpetaId);
      const idSubido = await subirArchivo(acceso, carpetaId, nombre, rutaFinal);

      // 4. Limpieza de las viejas (si falla, la copia igual salió bien).
      let borradas = 0;
      let aviso = '';
      try { borradas = await this.podar(acceso, carpetaId, idSubido, f.dias); } catch (e) { aviso = `No se pudieron borrar copias viejas: ${(e as Error).message}`; }

      await this.guardar({
        carpetaId, ultimoOk: new Date(), ultimoArchivo: nombre, ultimoTamano: tamano, ultimoError: aviso,
      });
      const mb = (tamano / 1024 / 1024).toFixed(1);
      await this.audit.registrar([{
        entidad: 'sistema', entidadId: 0, ambito: 'Respaldos', campo: `Respaldo a Drive (${origen})`, usuarioId,
        despues: `${resumen.tablas} tablas · ${resumen.filas.toLocaleString('es-AR')} filas · ${mb} MB${f.cifrar ? ' · cifrado' : ''}${borradas ? ` · ${borradas} copia(s) vieja(s) borrada(s)` : ''}`,
      }]);
      this.log.log(`Respaldo ${origen} subido: ${nombre} (${mb} MB)`);
      return true;
    } catch (e) {
      const err = e as Error;
      const desconectado = e instanceof ErrorGoogle && e.desconectado;
      this.log.error(`Respaldo ${origen} falló: ${err.message}`);
      await this.guardar({
        ultimoError: (desconectado ? 'Google retiró el permiso: hay que volver a conectar el Drive. ' : '') + err.message.slice(0, 400),
        ...(desconectado ? { tokenCifrado: '' } : {}),
      }).catch(() => { /* sin base no hay dónde anotarlo */ });
      await this.audit.registrar([{
        entidad: 'sistema', entidadId: 0, ambito: 'Respaldos', campo: `Respaldo a Drive (${origen}): FALLÓ`, usuarioId,
        despues: err.message.slice(0, 280),
      }]).catch(() => undefined);
      return false;
    } finally {
      try { await cli.query('SELECT pg_advisory_unlock(hashtext($1))', ['respaldo:drive']); } catch { /* al cerrar la conexión se suelta solo */ }
      cli.release();
      if (carpetaTmp) await rm(carpetaTmp, { recursive: true, force: true }).catch(() => undefined);
      this.corriendo = false;
    }
  }

  /** Borra de la carpeta las copias con más de `dias` días, dejando siempre las 3 más nuevas. */
  private async podar(acceso: string, carpetaId: string, idNuevo: string, dias: number): Promise<number> {
    const copias = (await listarCopias(acceso, carpetaId)).filter((c) => c.name.startsWith(PREFIJO_ARCHIVO));
    const limite = Date.now() - dias * 24 * 3600_000;
    let n = 0;
    for (const [i, c] of copias.entries()) {
      if (c.id === idNuevo || i < MINIMO_A_CONSERVAR) continue;
      if (new Date(c.createdTime).getTime() >= limite) continue;
      await borrarArchivo(acceso, c.id);
      n += 1;
    }
    return n;
  }

  /* ---------------------------------- el reloj ---------------------------------- */
  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    this.reloj = setInterval(() => { void this.tick(); }, 60_000);
    this.reloj.unref();
  }
  onModuleDestroy() { if (this.reloj) clearInterval(this.reloj); }

  /** Cada minuto: ¿ya pasó la hora de hoy y todavía no hay copia buena? */
  private async tick() {
    try {
      if (this.corriendo) return;
      const f = await this.fila();
      if (!f?.activo || !f.tokenCifrado) return;
      const ahora = new Date();
      const hoy = instanteAr(enAr(ahora).dia, f.hora);
      if (ahora < hoy) return;
      if (f.ultimoOk && f.ultimoOk >= hoy) return;
      if (f.ultimoIntento && f.ultimoIntento >= hoy && ahora.getTime() - f.ultimoIntento.getTime() < REINTENTO_MS) return;
      await this.respaldar('programado', null);
    } catch (e) {
      this.log.warn(`reloj: ${(e as Error).message}`);
    }
  }
}

@Controller('sistema/respaldos/drive')
export class RespaldoDriveController {
  constructor(private readonly svc: RespaldoDriveService) {}

  /* Conectar, cambiar la configuración y desconectar son del superadmin: la
   * copia tiene TODA la información del negocio, y a dónde va no se delega. */
  private soloSuperadmin(sesion: Sesion) {
    if (!sesion?.permisos?.includes('*')) throw new ForbiddenException('Conectar o configurar el respaldo a Drive es exclusivo del superadmin.');
  }

  @Get('estado') @Permiso('sistema.respaldos')
  estado() { return this.svc.estado(); }

  @Post('ahora') @Permiso('sistema.respaldos')
  ahora(@Auth() sesion: Sesion) { return this.svc.pedirAhora(sesion?.usuarioId ?? null); }

  @Post('conectar') @Permiso('sistema.respaldos')
  conectar(@Auth() sesion: Sesion) {
    this.soloSuperadmin(sesion);
    return this.svc.urlParaConectar(sesion?.usuarioId ?? null);
  }

  @Post('configurar') @Permiso('sistema.respaldos')
  configurar(@Body() dto: ConfigurarDriveDto, @Auth() sesion: Sesion) {
    this.soloSuperadmin(sesion);
    return this.svc.configurar(dto, sesion?.usuarioId ?? null);
  }

  @Post('desconectar') @Permiso('sistema.respaldos')
  desconectar(@Auth() sesion: Sesion) {
    this.soloSuperadmin(sesion);
    return this.svc.desconectar(sesion?.usuarioId ?? null);
  }

  /** A donde Google devuelve a la persona. No lleva sesión: lo protege el `state` firmado. */
  @Publico() @Get('callback')
  callback(@Query() q: { code?: string; state?: string; error?: string }, @Res() res: Response) {
    return this.svc.alVolver(q, res);
  }
}

/* ==========================================================================
 * LAS PÁGINAS PÚBLICAS QUE GOOGLE PIDE PARA PUBLICAR LA APLICACIÓN
 * ==========================================================================
 * Página principal, política de privacidad y condiciones, en el dominio
 * propio. Son texto fijo: no leen nada de la base.
 */
const CORREO = 'saboryaromacrm@gmail.com';
const pagina = (titulo: string, cuerpo: string) => `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${titulo} · ERP Sabor y Aroma</title>
<style>
  :root{color-scheme:light dark;--fondo:#f4f6f3;--tinta:#1c2a20;--suave:#54635a;--marca:#1b6b3a;--tarjeta:#fff;--linea:#dfe6e0}
  @media (prefers-color-scheme:dark){:root{--fondo:#121a15;--tinta:#e6efe8;--suave:#9fb0a5;--marca:#5fc186;--tarjeta:#1a2520;--linea:#2b3a31}}
  *{box-sizing:border-box}body{margin:0;background:var(--fondo);color:var(--tinta);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
  main{max-width:720px;margin:0 auto;padding:40px 20px 64px}
  header{margin-bottom:28px}h1{font-size:28px;line-height:1.25;margin:0 0 6px}h2{font-size:19px;margin:28px 0 8px}
  .marca{color:var(--marca);font-weight:700;letter-spacing:.04em;text-transform:uppercase;font-size:13px}
  p,li{color:var(--tinta)}ul{padding-left:22px}a{color:var(--marca)}.suave{color:var(--suave);font-size:14px}
  nav{margin-top:36px;padding-top:16px;border-top:1px solid var(--linea);display:flex;gap:18px;flex-wrap:wrap;font-size:14px}
</style></head><body><main>
<header><div class="marca">ERP Sabor y Aroma</div><h1>${titulo}</h1></header>
${cuerpo}
<nav><a href="/">Inicio</a><a href="/privacidad">Política de privacidad</a><a href="/condiciones">Condiciones del servicio</a></nav>
</main></body></html>`;

@Controller()
export class PaginasPublicasController {
  @Publico() @Get() @Header('Content-Type', 'text/html; charset=utf-8') @Header('Cache-Control', 'public, max-age=3600')
  inicio() {
    return pagina('Sistema de gestión de Sabor y Aroma', `
<p>Este es el sistema interno de gestión de <strong>Sabor y Aroma</strong>: ventas, compras, stock, proveedores y administración del negocio. Es de uso privado del personal autorizado.</p>
<p>Desde acá el sistema puede, con permiso expreso del titular, guardar copias de seguridad de su propia información en una carpeta de Google Drive.</p>
<p class="suave">Consultas: <a href="mailto:${CORREO}">${CORREO}</a></p>`);
  }

  @Publico() @Get('privacidad') @Header('Content-Type', 'text/html; charset=utf-8') @Header('Cache-Control', 'public, max-age=3600')
  privacidad() {
    return pagina('Política de privacidad', `
<p class="suave">Última actualización: 29 de septiembre de 2026.</p>
<p>ERP Sabor y Aroma es el sistema de gestión interno de Sabor y Aroma. No es una aplicación pública: la usa únicamente el personal autorizado por el titular del negocio.</p>
<h2>Qué acceso pedimos a Google y para qué</h2>
<p>Cuando el titular conecta su cuenta de Google Drive, el sistema pide un único permiso: <strong>ver, crear y modificar únicamente los archivos que el propio sistema crea</strong> en Drive. Se usa exclusivamente para guardar copias de seguridad de la información del negocio en una carpeta llamada «Respaldos CRM Sabor y Aroma».</p>
<ul>
  <li>El sistema <strong>no puede leer, listar ni modificar</strong> ningún otro archivo de tu Drive.</li>
  <li>Del perfil de Google solo se muestra la dirección de correo de la cuenta conectada, para que se sepa cuál está vinculada.</li>
</ul>
<h2>Qué guardamos</h2>
<ul>
  <li>Una credencial de acceso a Drive, guardada <strong>cifrada</strong> en la base de datos del sistema.</li>
  <li>Las copias de seguridad, que se guardan en la carpeta de Drive del titular, opcionalmente cifradas con una contraseña que solo conoce el titular.</li>
</ul>
<h2>Qué no hacemos</h2>
<ul>
  <li>No vendemos, alquilamos ni compartimos información con terceros.</li>
  <li>No usamos los datos de Google para publicidad ni para entrenar modelos de inteligencia artificial.</li>
  <li>El uso de la información recibida de las API de Google cumple con la <a href="https://developers.google.com/terms/api-services-user-data-policy" rel="noopener">Política de datos de usuario de los servicios de API de Google</a>, incluidos los requisitos de uso limitado.</li>
</ul>
<h2>Cómo desconectar y borrar</h2>
<p>El titular puede desconectar Google Drive en cualquier momento desde el propio sistema (Sistema › Respaldos › Desconectar), o quitando el acceso desde su cuenta de Google en <a href="https://myaccount.google.com/permissions" rel="noopener">myaccount.google.com/permissions</a>. Al desconectar, el sistema borra la credencial guardada. Las copias que ya están en Drive son del titular y las puede borrar cuando quiera.</p>
<h2>Contacto</h2>
<p>Por cualquier consulta sobre esta política: <a href="mailto:${CORREO}">${CORREO}</a></p>`);
  }

  @Publico() @Get('condiciones') @Header('Content-Type', 'text/html; charset=utf-8') @Header('Cache-Control', 'public, max-age=3600')
  condiciones() {
    return pagina('Condiciones del servicio', `
<p class="suave">Última actualización: 29 de septiembre de 2026.</p>
<p>ERP Sabor y Aroma es una herramienta de gestión interna, de uso privado y limitado al personal que el titular del negocio autorice. No se ofrece al público.</p>
<h2>Uso</h2>
<ul>
  <li>El acceso es personal e intransferible y se otorga según el rol de cada persona.</li>
  <li>La función de copias de seguridad en Google Drive solo puede ser conectada por el titular, con su propia cuenta.</li>
</ul>
<h2>Copias de seguridad</h2>
<p>El sistema hace lo posible por generar y subir las copias en el horario programado, pero no garantiza que estén siempre disponibles: si Google retira el permiso o hay una falla de conexión, el sistema lo informa en pantalla. El titular es responsable de verificar periódicamente que las copias se están generando y de conservar la contraseña de cifrado.</p>
<h2>Responsabilidad</h2>
<p>El servicio se brinda «tal cual», sin garantías adicionales. Ante cualquier duda, escribí a <a href="mailto:${CORREO}">${CORREO}</a>.</p>`);
  }
}

@Module({
  imports: [AuditoriaModule],
  controllers: [RespaldoDriveController, PaginasPublicasController],
  providers: [RespaldoDriveService],
  exports: [RespaldoDriveService],
})
export class RespaldoDriveModule {}
