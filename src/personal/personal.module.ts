/**
 * `/api/personal` — el personal para los adelantos de sueldo (0221). Reglas en `personal.ts`.
 *   · GET  /personal            los que NO usan el sistema (todos, también los desactivados) — Gerencia › Usuarios
 *   · POST /personal            alta de uno que no usa el sistema (solo el nombre)
 *   · PATCH /personal/:id       renombrar / desactivar / reactivar
 *   · GET  /personal/adelantos  la lista para elegir al sacar un adelanto (caja central o caja del local)
 * Los usuarios del ERP se marcan «es empleado» desde su ficha (`PATCH /usuarios/:id`).
 */
import { BadRequestException, Body, Controller, Get, Inject, Injectable, Module, NotFoundException, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { Auth, Permiso, type Sesion } from '../auth/auth.decoradores';
import { DRIZZLE, Database } from '../db/drizzle';
import { personal } from '../db/schema';
import { AuditoriaModule, AuditoriaService } from '../auditoria/auditoria.module';
import { PERMISO_CASHFLOW } from '../cashflow/a-controlar';
import { PERMISO_CAJA_POSTERIOR } from '../caja/caja.module';
import { empleadosVigentes } from './personal';

const limpio = (v: unknown) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);

@Injectable()
export class PersonalService {
  constructor(@Inject(DRIZZLE) private readonly db: Database, private readonly audit: AuditoriaService) {}

  sinUsuario() {
    return this.db.select({ id: personal.id, nombre: personal.nombre, activo: personal.activo })
      .from(personal).where(isNull(personal.usuarioId)).orderBy(asc(personal.nombre));
  }

  async crear(o: any, sesion: Sesion) {
    const nombre = limpio(o?.nombre);
    if (!nombre) throw new BadRequestException('Escribí el nombre del empleado.');
    return this.db.transaction(async (tx) => {
      const [p] = await tx.insert(personal).values({ nombre }).returning();
      await this.audit.registrar([{
        entidad: 'personal', entidadId: p.id, ambito: 'Usuarios', detalle: nombre, campo: 'Empleado sin usuario creado', despues: nombre, usuarioId: sesion?.usuarioId ?? null,
      }], tx);
      return p;
    });
  }

  async editar(id: number, o: any, sesion: Sesion) {
    const [p] = await this.db.select().from(personal).where(and(eq(personal.id, id), isNull(personal.usuarioId))).limit(1);
    if (!p) throw new NotFoundException('Ese empleado no existe (los que usan el sistema se cambian en su usuario).');
    const patch: { nombre?: string; activo?: boolean } = {};
    if (o?.nombre != null) {
      const nombre = limpio(o.nombre);
      if (!nombre) throw new BadRequestException('El nombre no puede quedar vacío.');
      if (nombre !== p.nombre) patch.nombre = nombre;
    }
    if (o?.activo != null && !!o.activo !== p.activo) patch.activo = !!o.activo;
    if (!Object.keys(patch).length) return p;
    const base = { entidad: 'personal', entidadId: id, ambito: 'Usuarios', detalle: patch.nombre ?? p.nombre, usuarioId: sesion?.usuarioId ?? null };
    return this.db.transaction(async (tx) => {
      const [n] = await tx.update(personal).set(patch).where(eq(personal.id, id)).returning();
      await this.audit.registrar([
        ...(patch.nombre ? [{ ...base, campo: 'Nombre del empleado', antes: p.nombre, despues: patch.nombre }] : []),
        ...(patch.activo != null ? [{ ...base, campo: 'Empleado activo', antes: p.activo ? 'Sí' : 'No', despues: patch.activo ? 'Sí' : 'No' }] : []),
      ], tx);
      return n;
    });
  }
}

@Controller('personal')
@Permiso('gerencia.usuarios')
export class PersonalController {
  constructor(private readonly svc: PersonalService, @Inject(DRIZZLE) private readonly db: Database) {}

  @Get() list() { return this.svc.sinUsuario(); }
  @Post() crear(@Body() body: any, @Auth() sesion: Sesion) { return this.svc.crear(body, sesion); }
  @Patch(':id') editar(@Param('id', ParseIntPipe) id: number, @Body() body: any, @Auth() sesion: Sesion) {
    return this.svc.editar(id, body, sesion);
  }

  /* Quien saca plata: la caja central, el egreso del cajón o el asentado después del cierre. */
  @Get('adelantos')
  @Permiso(PERMISO_CASHFLOW, 'diferencias', PERMISO_CAJA_POSTERIOR)
  adelantos() { return empleadosVigentes(this.db); }
}

@Module({
  imports: [AuditoriaModule],
  controllers: [PersonalController],
  providers: [PersonalService],
})
export class PersonalModule {}
