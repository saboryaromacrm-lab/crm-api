import {
  BadRequestException, Body, Controller, Delete, Get, Inject, Injectable, Module, NotFoundException,
  Param, ParseIntPipe, Patch, Post,
} from '@nestjs/common';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { and, eq, gt, ne, sql } from 'drizzle-orm';
import { createHash, randomBytes } from 'crypto';
import { DRIZZLE, Database } from '../db/drizzle';
import { Auth, Permiso, Publico, type Sesion } from '../auth/auth.decoradores';
import { incidencias, stock, sucursales, terminales } from '../db/schema';

class UpsertSucursalDto {
  @IsString() @MaxLength(80) nombre!: string;
  @IsOptional() @IsIn(['distribuidora', 'express']) tipo?: 'distribuidora' | 'express';
  /** El punto de venta de ARCA de este local. Vacío = todavía no se cargó. */
  @IsOptional() @IsString() @MaxLength(5) puntoVenta?: string;
  /** El domicilio comercial declarado para ese punto de venta. */
  @IsOptional() @IsString() @MaxLength(200) direccion?: string;
}

/**
 * CINCO DÍGITOS, y no reutiliza `normalizarPuntoVenta` de compras a propósito:
 * aquella normaliza a CUATRO y así están guardadas las facturas de proveedor
 * desde siempre — cambiarla dejaría de reconocer como duplicada una factura ya
 * cargada. Esta es para los NUESTROS, que nacen hoy y nacen de cinco.
 *
 * El vacío se respeta: es "todavía no cargado", no un cero.
 */
export const normalizarPuntoVentaFiscal = (v: unknown) => {
  const d = String(v ?? '').replace(/\D/g, '').replace(/^0+/, '');
  return d ? d.padStart(5, '0') : '';
};

@Injectable()
export class SucursalesService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  list() { return this.db.select().from(sucursales).orderBy(sucursales.id); }

  async get(id: number) {
    const [s] = await this.db.select().from(sucursales).where(eq(sucursales.id, id)).limit(1);
    if (!s) throw new NotFoundException('Sucursal inexistente.');
    return s;
  }

  /**
   * Lo que se guarda de una sucursal, con el punto de venta normalizado y el
   * candado contra el duplicado.
   *
   * EL DUPLICADO SE ATAJA ACÁ ADEMÁS DEL ÍNDICE porque el mensaje importa: dos
   * sucursales con el mismo punto de venta pedirían el mismo próximo número a
   * ARCA y se pisarían, y un error de índice único no explica nada de eso.
   */
  private async normalizar(dto: UpsertSucursalDto, idPropio?: number) {
    const puntoVenta = normalizarPuntoVentaFiscal(dto.puntoVenta);
    if (puntoVenta) {
      const dueño = await this.db.select({ id: sucursales.id, nombre: sucursales.nombre })
        .from(sucursales).where(eq(sucursales.puntoVenta, puntoVenta)).limit(1);
      if (dueño.length && dueño[0].id !== idPropio) {
        throw new BadRequestException(
          `El punto de venta ${puntoVenta} ya es el de ${dueño[0].nombre}. `
          + 'Cada local tiene el suyo: compartirlo haría que las dos sucursales le pidan '
          + 'el mismo número a ARCA y una de las dos rebote.',
        );
      }
    }
    return {
      nombre: dto.nombre.trim(),
      tipo: dto.tipo ?? ('express' as const),
      puntoVenta,
      direccion: (dto.direccion ?? '').trim(),
    };
  }

  async create(dto: UpsertSucursalDto) {
    const [s] = await this.db.insert(sucursales).values(await this.normalizar(dto)).returning();
    return s;
  }

  async update(id: number, dto: UpsertSucursalDto) {
    await this.get(id);
    const [s] = await this.db.update(sucursales)
      .set(await this.normalizar(dto, id)).where(eq(sucursales.id, id)).returning();
    return s;
  }

  /**
   * BORRAR UNA SUCURSAL SE LLEVA SU STOCK POR CASCADA.
   *
   * `stock.sucursalId` e `incidencias.sucursalId` cuelgan con `on delete
   * cascade`, así que un `DELETE /sucursales/5` borraba **todas las existencias
   * y todas las incidencias de ese local**, sin un solo movimiento, sin log y
   * sin vuelta atrás. Las sucursales viejas hoy zafan de casualidad, por las FK
   * `restrict` de ventas, cajas y transferencias; una sucursal nueva —o una de
   * sola recepción— no tiene ninguna de esas y se borraba entera.
   *
   * Ahora se corta antes: si hay una sola unidad en cualquier estado o una
   * incidencia abierta, no se borra. Lo que hay que hacer con un local que
   * cierra es vaciarlo por transferencia, que deja los movimientos.
   */
  async remove(id: number) {
    const s = await this.get(id);
    const [conStock] = await this.db.select({ n: sql<number>`count(*)` })
      .from(stock).where(and(eq(stock.sucursalId, id), gt(stock.cantidad, 0.000001)));
    if (Number(conStock?.n) > 0) {
      throw new BadRequestException(
        `${s.nombre} todavía tiene mercadería cargada. Transferila o dala de baja antes de borrar la sucursal: `
        + 'borrarla se llevaría su stock sin dejar ningún movimiento.',
      );
    }
    const [conInc] = await this.db.select({ n: sql<number>`count(*)` })
      .from(incidencias).where(and(eq(incidencias.sucursalId, id), ne(incidencias.estado, 'resuelta')));
    if (Number(conInc?.n) > 0) {
      throw new BadRequestException(`${s.nombre} tiene incidencias sin resolver: cerralas antes de borrarla.`);
    }
    await this.db.delete(sucursales).where(eq(sucursales.id, id));
    return { ok: true };
  }
}

/**
 * Las sucursales son estructura de la empresa: crearlas, renombrarlas y —sobre
 * todo— mover cuál es "la distribuidora" es una decisión de gerencia, no de
 * mostrador. Ese `tipo` no es una etiqueta: `distribuidoraId()` toma la primera
 * con `tipo='distribuidora'` y es el destino por defecto de toda compra y el
 * origen de todo envío a Cafetería, así que un `PATCH` lo redirigía en silencio.
 *
 * La LECTURA queda abierta a cualquier sesión: la pide el Topbar para el
 * selector, el login y media docena de pantallas de todos los módulos.
 */
@Controller('sucursales')
export class SucursalesController {
  constructor(private readonly svc: SucursalesService) {}
  @Get() list() { return this.svc.list(); }
  @Get(':id') get(@Param('id', ParseIntPipe) id: number) { return this.svc.get(id); }

  @Post() @Permiso('gerencia.usuarios')
  create(@Body() dto: UpsertSucursalDto) { return this.svc.create(dto); }

  @Patch(':id') @Permiso('gerencia.usuarios')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpsertSucursalDto) { return this.svc.update(id, dto); }

  @Delete(':id') @Permiso('gerencia.usuarios')
  remove(@Param('id', ParseIntPipe) id: number) { return this.svc.remove(id); }
}

/* ==================================================================== *
 * TERMINALES — qué equipo es este y en qué sucursal está (0081)
 * ==================================================================== */

class CrearTerminalDto {
  @IsString() @MaxLength(60) nombre!: string;
  @IsInt() sucursalId!: number;
}

class EditarTerminalDto {
  @IsOptional() @IsString() @MaxLength(60) nombre?: string;
  @IsOptional() @IsInt() sucursalId?: number;
  @IsOptional() @IsBoolean() activa?: boolean;
}

class TokenTerminalDto {
  @IsString() @MaxLength(200) token!: string;
}

const hashTerminal = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * Resuelve el token del equipo a su terminal, o `null`.
 *
 * Vive suelta y recibe `db` para que **el login la pueda usar sin importar este
 * módulo**: la resolución pasa antes de que exista sesión, en `usuarios.module`,
 * y hacer que Usuarios dependa de Sucursales solo por esto sería enganchar dos
 * módulos por una consulta de cinco líneas.
 *
 * Devuelve `null` también para la terminal DADA DE BAJA: es la forma de sacar de
 * circulación un equipo perdido sin borrar su historia, y el login vuelve a
 * preguntar la sucursal como antes.
 */
export async function terminalPorToken(db: Database, token: unknown) {
  const t = String(token ?? '').trim();
  if (!t) return null;
  const [fila] = await db
    .select({
      id: terminales.id,
      nombre: terminales.nombre,
      activa: terminales.activa,
      sucursalId: sucursales.id,
      sucursalNombre: sucursales.nombre,
    })
    .from(terminales)
    .innerJoin(sucursales, eq(sucursales.id, terminales.sucursalId))
    .where(eq(terminales.tokenHash, hashTerminal(t)))
    .limit(1);
  if (!fila || !fila.activa) return null;
  return fila;
}

/** Deja constancia de que este equipo se usó, para poder reconocerlo en la lista. */
export async function marcarUsoTerminal(db: Database, id: number, userAgent = '') {
  await db.update(terminales)
    .set({ ultimoUso: new Date(), ultimoAgente: userAgent.slice(0, 300) })
    .where(eq(terminales.id, id));
}

@Injectable()
export class TerminalesService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** Con el nombre de la sucursal y SIN el hash: el token no vuelve nunca. */
  list() {
    return this.db.select({
      id: terminales.id,
      nombre: terminales.nombre,
      activa: terminales.activa,
      creadaEn: terminales.creadaEn,
      ultimoUso: terminales.ultimoUso,
      ultimoAgente: terminales.ultimoAgente,
      sucursalId: terminales.sucursalId,
      sucursalNombre: sucursales.nombre,
    })
      .from(terminales)
      .innerJoin(sucursales, eq(sucursales.id, terminales.sucursalId))
      .orderBy(sucursales.nombre, terminales.nombre);
  }

  /**
   * Registra el equipo y devuelve el token EN CLARO — la única vez que existe,
   * igual que el de sesión. El navegador lo guarda y no vuelve a pedirlo.
   */
  async crear(dto: CrearTerminalDto, sesion?: Sesion) {
    const nombre = dto.nombre.trim();
    if (!nombre) throw new BadRequestException('Ponele un nombre al equipo: es como lo vas a reconocer en la lista.');
    const [suc] = await this.db.select().from(sucursales).where(eq(sucursales.id, dto.sucursalId)).limit(1);
    if (!suc) throw new BadRequestException('Elegí una sucursal válida.');

    const token = randomBytes(32).toString('base64url');
    const [t] = await this.db.insert(terminales).values({
      nombre,
      sucursalId: suc.id,
      tokenHash: hashTerminal(token),
      creadaPor: sesion?.usuarioId ?? null,
    }).returning();
    return { terminal: { ...t, tokenHash: undefined, sucursalNombre: suc.nombre }, token };
  }

  async editar(id: number, dto: EditarTerminalDto) {
    const [t] = await this.db.select().from(terminales).where(eq(terminales.id, id)).limit(1);
    if (!t) throw new NotFoundException('Ese equipo no está registrado.');
    const patch: any = {};
    if (dto.nombre != null) {
      const n = dto.nombre.trim();
      if (!n) throw new BadRequestException('El nombre no puede quedar vacío.');
      patch.nombre = n;
    }
    if (dto.sucursalId != null && dto.sucursalId !== t.sucursalId) {
      const [suc] = await this.db.select().from(sucursales).where(eq(sucursales.id, dto.sucursalId)).limit(1);
      if (!suc) throw new BadRequestException('Elegí una sucursal válida.');
      patch.sucursalId = suc.id;
    }
    if (dto.activa != null) patch.activa = !!dto.activa;
    if (!Object.keys(patch).length) return t;
    const [nuevo] = await this.db.update(terminales).set(patch).where(eq(terminales.id, id)).returning();
    return nuevo;
  }

  /**
   * Borrar la terminal invalida su token: ese equipo vuelve a preguntar la
   * sucursal en el próximo login. No arrastra nada —las ventas guardan la
   * sucursal, no la terminal—, así que acá sí se puede borrar de verdad.
   */
  async borrar(id: number) {
    const [t] = await this.db.select().from(terminales).where(eq(terminales.id, id)).limit(1);
    if (!t) throw new NotFoundException('Ese equipo no está registrado.');
    await this.db.delete(terminales).where(eq(terminales.id, id));
    return { ok: true };
  }

  /** Lo que el login necesita saber ANTES de que haya sesión. */
  async actual(token: string) {
    const t = await terminalPorToken(this.db, token);
    if (!t) return { terminal: null };
    return {
      terminal: {
        id: t.id,
        nombre: t.nombre,
        sucursal: { id: t.sucursalId, nombre: t.sucursalNombre },
      },
    };
  }
}

/**
 * Registrar un equipo es decidir en qué sucursal opera todo el que se siente
 * ahí: es la misma llave que crear usuarios y mover sucursales.
 */
@Controller('terminales')
export class TerminalesController {
  constructor(private readonly svc: TerminalesService) {}

  /**
   * PÚBLICO Y POR POST, las dos cosas a propósito.
   *
   * Público porque lo llama la pantalla de login, donde todavía no hay sesión
   * —es justamente lo que reemplaza al desplegable de sucursales—. Y por POST
   * en vez de un `?token=` porque el token del equipo no tiene por qué quedar
   * escrito en los logs del proxy ni en el historial del navegador.
   *
   * Con un token que no existe o de una terminal dada de baja devuelve
   * `{terminal: null}` y no un error: para el login "este equipo no está
   * registrado" es un caso normal, no una falla.
   */
  @Publico()
  @Post('actual') actual(@Body() dto: TokenTerminalDto) { return this.svc.actual(dto?.token ?? ''); }

  @Get() @Permiso('sistema.terminales') list() { return this.svc.list(); }

  @Post() @Permiso('sistema.terminales')
  crear(@Body() dto: CrearTerminalDto, @Auth() sesion: Sesion) { return this.svc.crear(dto, sesion); }

  @Patch(':id') @Permiso('sistema.terminales')
  editar(@Param('id', ParseIntPipe) id: number, @Body() dto: EditarTerminalDto) { return this.svc.editar(id, dto); }

  @Delete(':id') @Permiso('sistema.terminales')
  borrar(@Param('id', ParseIntPipe) id: number) { return this.svc.borrar(id); }
}

@Module({
  controllers: [SucursalesController, TerminalesController],
  providers: [SucursalesService, TerminalesService],
})
export class SucursalesModule {}
