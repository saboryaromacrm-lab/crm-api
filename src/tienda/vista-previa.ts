/**
 * LA VISTA PREVIA DE LA TIENDA (20/10/2026, pedido del dueño)
 * ============================================================================
 * Una tienda «en preparación» (Tienda online › Configuración) no la ve el
 * público; con el link de vista previa que da el ERP se ve entera y se puede
 * comprar de prueba. La clave vive en `configuracion` bajo una llave que el
 * endpoint genérico no sirve (no está en sus defaults: GET y PUT dan 404), así
 * que solo la leen estos dos endpoints, con el permiso de la tienda online.
 */
import { Controller, Get, Inject, Injectable, Post } from '@nestjs/common';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Permiso } from '../auth/auth.decoradores';
import { DRIZZLE, Database } from '../db/drizzle';
import { configuracion } from '../db/schema';

const LLAVE = 'tiendaVistaPrevia';

@Injectable()
export class VistaPreviaService {
  /** En memoria (la API es un solo proceso): undefined = todavía no se leyó; null = no hay clave. */
  private clave: string | null | undefined;

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  private async actual(): Promise<string | null> {
    if (this.clave === undefined) {
      const [r] = await this.db.select({ valor: configuracion.valor }).from(configuracion).where(eq(configuracion.clave, LLAVE)).limit(1);
      this.clave = (r?.valor as { clave?: string } | undefined)?.clave ?? null;
    }
    return this.clave;
  }

  /** ¿Este token abre la vista previa? Comparación de tiempo constante. */
  async valida(token: unknown): Promise<boolean> {
    const clave = await this.actual();
    if (!clave || typeof token !== 'string' || token.length !== clave.length) return false;
    return timingSafeEqual(Buffer.from(token), Buffer.from(clave));
  }

  /** La clave para el ERP; la primera vez se crea. */
  async obtener() {
    return { clave: (await this.actual()) ?? (await this.nueva()).clave };
  }

  /** Una clave nueva: el link anterior deja de abrir la tienda. */
  async nueva() {
    const clave = randomBytes(18).toString('base64url');
    await this.db.insert(configuracion).values({ clave: LLAVE, valor: { clave } })
      .onConflictDoUpdate({ target: configuracion.clave, set: { valor: { clave }, updatedAt: new Date() } });
    this.clave = clave;
    return { clave };
  }
}

@Controller('web/vista-previa')
@Permiso('web.configuracion')
export class VistaPreviaController {
  constructor(private readonly svc: VistaPreviaService) {}

  @Get() obtener() { return this.svc.obtener(); }
  @Post('nueva') nueva() { return this.svc.nueva(); }
}
