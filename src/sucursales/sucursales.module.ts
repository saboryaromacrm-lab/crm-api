import {
  BadRequestException, Body, Controller, Delete, Get, Inject, Injectable, Module, NotFoundException,
  Param, ParseIntPipe, Patch, Post, Query,
} from '@nestjs/common';
import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { and, asc, eq, gt, inArray, ne, or, sql } from 'drizzle-orm';
import { createHash, randomBytes } from 'crypto';
import { DRIZZLE, Database } from '../db/drizzle';
import { Auth, Permiso, Publico, type Sesion } from '../auth/auth.decoradores';
import {
  cajaSesiones, conteos, enviosCafeteria, gastosRecurrentes, incidencias, pedidosCafeteria, presupuestos, productos, sesiones, stock,
  sucursales, terminales, transferencias, usuarios, vencimientos, ventas,
} from '../db/schema';

class UpsertSucursalDto {
  @IsString() @MaxLength(80) nombre!: string;
  @IsOptional() @IsIn(['distribuidora', 'express']) tipo?: 'distribuidora' | 'express';
  /** El punto de venta de ARCA de este local. Vacío = todavía no se cargó. */
  @IsOptional() @IsString() @MaxLength(5) puntoVenta?: string;
  /** El domicilio comercial declarado para ese punto de venta. */
  @IsOptional() @IsString() @MaxLength(200) direccion?: string;
  /** Factura electrónicamente con su punto de venta (0124). Sin el campo, queda como estaba. */
  @IsOptional() @IsBoolean() facturaElectronica?: boolean;
  /** El fondo fijo de caja (0111). Solo lo cambia quien edita sucursales: el superadmin. */
  @IsOptional() @IsNumber() @Min(0, { message: 'El fondo de caja no puede ser negativo.' }) @Max(100_000_000) fondoCaja?: number;
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

  /**
   * Las sucursales para ELEGIR: solo las activas (0143). `todas` (la pantalla
   * de Sucursales de Gerencia) trae también las desactivadas, para poder
   * reactivarlas. Lo que solo muestra un nombre en el historial no pasa por
   * acá: lo lee con un join y sigue viendo el nombre de un local cerrado.
   */
  list(todas = false) {
    const q = this.db.select().from(sucursales);
    return (todas ? q : q.where(eq(sucursales.activa, true))).orderBy(sucursales.id);
  }

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
  private async normalizar(dto: UpsertSucursalDto, idPropio?: number, actual?: { facturaElectronica: boolean }) {
    const puntoVenta = normalizarPuntoVentaFiscal(dto.puntoVenta);
    const direccion = (dto.direccion ?? '').trim();
    /*
     * FACTURA ELECTRÓNICA (0124): sin el campo queda como estaba; sin punto de
     * venta se apaga sola (no hay con qué facturar). Encenderla pide las dos
     * cosas que van impresas y declaradas: el punto de venta y su domicilio.
     */
    let facturaElectronica = dto.facturaElectronica ?? actual?.facturaElectronica ?? false;
    if (!puntoVenta) facturaElectronica = false;
    if (dto.facturaElectronica && !puntoVenta) {
      throw new BadRequestException(
        'Para facturar electrónicamente, la sucursal necesita su propio punto de venta de ARCA (tipo Web Services). '
        + 'Cargalo primero; así nunca factura con el de otro local.',
      );
    }
    if (dto.facturaElectronica && !direccion) {
      throw new BadRequestException(
        'Para facturar electrónicamente, cargá el domicilio del local tal como está declarado en ARCA para ese punto de venta: va impreso en cada factura.',
      );
    }
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
      direccion,
      facturaElectronica,
      // Sin el campo, el fondo queda como estaba: editar el nombre no lo borra.
      ...(dto.fondoCaja !== undefined ? { fondoCaja: Math.round(Number(dto.fondoCaja) * 100) / 100 } : {}),
    };
  }

  async create(dto: UpsertSucursalDto) {
    const [s] = await this.db.insert(sucursales).values(await this.normalizar(dto)).returning();
    return s;
  }

  async update(id: number, dto: UpsertSucursalDto) {
    const actual = await this.get(id);
    const [s] = await this.db.update(sucursales)
      .set(await this.normalizar(dto, id, actual)).where(eq(sucursales.id, id)).returning();
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

  /**
   * DESACTIVAR UN LOCAL QUE CERRÓ (0143, 8/10/2026).
   *
   * Antes de apagarlo se revisa que no quede nada vivo atado a él: si quedara,
   * desaparecería de las pantallas con plata, mercadería o un pedido adentro.
   * Se juntan TODOS los motivos en un solo mensaje, así se resuelven de una vez
   * y no de a uno por intento.
   *
   * Al apagarlo: los equipos registrados en ese local dejan de abrir el ERP
   * (si no, el login lo seguiría eligiendo solo) y se cierran las sesiones
   * paradas ahí. La del que lo apaga, si estaba parado ahí, se muda a otra.
   */
  async desactivar(id: number, sesion?: Sesion) {
    const s = await this.get(id);
    if (!s.activa) return { ok: true, yaEstaba: true };
    const motivos: string[] = [];
    if (s.tipo === 'distribuidora') {
      motivos.push('es la Distribuidora: de ahí salen las compras, los envíos a Coffit y el stock de la tienda online');
    }
    const n = async (q: Promise<any[]>) => Number((await q)[0]?.n) || 0;
    /* Stock DISTINTO de cero, también el negativo: un faltante sin explicar no puede quedar escondido en un local cerrado. */
    const conCantidad = sql`abs(${stock.cantidad}) > 0.000001`;
    const [activas, cajas, conStock, pases, incs, abiertas, pedidosCafe, controles, presus, enviosCafe, vencs, sinCae] = await Promise.all([
      n(this.db.select({ n: sql<number>`count(*)` }).from(sucursales).where(and(eq(sucursales.activa, true), ne(sucursales.id, id)))),
      n(this.db.select({ n: sql<number>`count(*)` }).from(cajaSesiones).where(and(eq(cajaSesiones.sucursalId, id), eq(cajaSesiones.estado, 'abierta')))),
      n(this.db.select({ n: sql<number>`count(distinct ${stock.productoId})` }).from(stock).where(and(eq(stock.sucursalId, id), conCantidad))),
      n(this.db.select({ n: sql<number>`count(*)` }).from(transferencias).where(and(
        or(eq(transferencias.origenId, id), eq(transferencias.destinoId, id)),
        inArray(transferencias.estado, ['borrador', 'pendiente', 'preparada', 'transito'] as any)))),
      n(this.db.select({ n: sql<number>`count(*)` }).from(incidencias).where(and(eq(incidencias.sucursalId, id), ne(incidencias.estado, 'resuelta')))),
      n(this.db.select({ n: sql<number>`count(*)` }).from(ventas).where(and(eq(ventas.sucursalId, id), eq(ventas.estado, 'borrador')))),
      n(this.db.select({ n: sql<number>`count(*)` }).from(pedidosCafeteria).where(and(
        eq(pedidosCafeteria.sucursalId, id), inArray(pedidosCafeteria.estado, ['pendiente', 'armando'] as any)))),
      n(this.db.select({ n: sql<number>`count(*)` }).from(conteos).where(and(eq(conteos.sucursalId, id), eq(conteos.estado, 'en_curso')))),
      n(this.db.select({ n: sql<number>`count(*)` }).from(presupuestos).where(and(
        eq(presupuestos.sucursalId, id), inArray(presupuestos.estado, ['borrador', 'enviado', 'confirmado', 'pendiente'] as any)))),
      n(this.db.select({ n: sql<number>`count(*)` }).from(enviosCafeteria).where(and(
        eq(enviosCafeteria.sucursalId, id), eq(enviosCafeteria.estado, 'enviado'), eq(enviosCafeteria.recepcion, 'pendiente')))),
      n(this.db.select({ n: sql<number>`count(*)` }).from(vencimientos).where(and(eq(vencimientos.sucursalId, id), eq(vencimientos.procesado, false)))),
      n(this.db.select({ n: sql<number>`count(*)` }).from(ventas).where(and(
        eq(ventas.sucursalId, id), or(eq(ventas.estado, 'pendiente_cae'), and(eq(ventas.estado, 'confirmada'), eq(ventas.facturarPendiente, true)))))),
    ]);
    if (!activas) motivos.push('es la única sucursal activa');
    if (cajas) motivos.push('tiene la caja abierta: cerrala primero (el sobre tiene que llegar)');
    if (conStock) {
      const ej = await this.db.select({ nombre: productos.nombre }).from(stock)
        .innerJoin(productos, eq(productos.id, stock.productoId))
        .where(and(eq(stock.sucursalId, id), conCantidad)).orderBy(asc(productos.nombre)).limit(3);
      motivos.push(`todavía tiene stock cargado distinto de cero (${conStock} producto${conStock === 1 ? '' : 's'}, por ejemplo ${ej.map((x) => x.nombre).join(', ')}): transferilo a otro local, dalo de baja o, si está en negativo, corregilo con un control de stock`);
    }
    if (pases) motivos.push(`tiene ${pases} pase${pases === 1 ? '' : 's'} entre locales sin terminar (en borrador, preparándose o en viaje)`);
    if (incs) motivos.push(`tiene ${incs} incidencia${incs === 1 ? '' : 's'} sin resolver`);
    if (abiertas) motivos.push(`tiene ${abiertas} ticket${abiertas === 1 ? '' : 's'} abierto${abiertas === 1 ? '' : 's'} en la caja sin cobrar: cobralos o descartalos`);
    if (pedidosCafe) motivos.push(`tiene ${pedidosCafe} pedido${pedidosCafe === 1 ? '' : 's'} de Coffit sin enviar`);
    if (controles) motivos.push(`tiene ${controles} control${controles === 1 ? '' : 'es'} de stock en curso: cerralo o descartalo`);
    if (presus) motivos.push(`tiene ${presus} presupuesto${presus === 1 ? '' : 's'} o pedido${presus === 1 ? '' : 's'} abierto${presus === 1 ? '' : 's'}: concretalos o cancelalos`);
    if (enviosCafe) motivos.push(`tiene ${enviosCafe} envío${enviosCafe === 1 ? '' : 's'} de Coffit sin recibir`);
    if (vencs) motivos.push(`tiene ${vencs} fecha${vencs === 1 ? '' : 's'} de vencimiento sin procesar en Almacén › Vencimientos: procesalas o borralas (si no, el aviso de vencimientos queda prendido para siempre)`);
    if (sinCae) motivos.push(`tiene ${sinCae} venta${sinCae === 1 ? '' : 's'} esperando el CAE de ARCA: facturalas desde Ventas › Caídas por ARCA`);
    if (motivos.length) {
      throw new BadRequestException(`No se puede desactivar ${s.nombre} porque ${motivos.join('; ')}.`);
    }

    const otra = (await this.db.select({ id: sucursales.id }).from(sucursales)
      .where(and(eq(sucursales.activa, true), ne(sucursales.id, id))).orderBy(sucursales.id).limit(1))[0];
    const r = await this.db.transaction(async (tx) => {
      await tx.update(sucursales).set({ activa: false, desactivadaEn: new Date() }).where(eq(sucursales.id, id));
      const eqs = await tx.update(terminales).set({ activa: false })
        .where(and(eq(terminales.sucursalId, id), eq(terminales.activa, true))).returning({ id: terminales.id });
      // El que la apaga no queda afuera: si estaba parado ahí, se muda a otra activa.
      if (sesion?.sesionId && otra) {
        await tx.update(sesiones).set({ sucursalId: otra.id })
          .where(and(eq(sesiones.id, sesion.sesionId), eq(sesiones.sucursalId, id)));
      }
      const cerradas = await tx.delete(sesiones).where(eq(sesiones.sucursalId, id)).returning({ id: sesiones.id });
      return { equipos: eqs.length, sesiones: cerradas.length };
    });
    /* Quien trabajaba SOLO ahí ya no tiene dónde entrar: se avisa (no se le
     * cambia nada solo; vaciarle la lista sería abrirle TODAS las sucursales). */
    const soloAhi = await this.db.select({ nombre: usuarios.nombre }).from(usuarios)
      .where(and(eq(usuarios.activo, true), sql`${usuarios.sucursales} @> ${JSON.stringify([id])}::jsonb`,
        sql`NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(${usuarios.sucursales}) e
              JOIN sucursales x ON x.id = e::int WHERE x.activa AND x.id <> ${id})`));
    /* Los gastos fijos del local se siguen generando si nadie los da de baja: se avisa (no se tocan solos). */
    const fijos = await this.db.select({ nombre: gastosRecurrentes.nombre }).from(gastosRecurrentes)
      .where(and(eq(gastosRecurrentes.sucursalId, id), eq(gastosRecurrentes.activo, true)));
    return { ok: true, sucursal: s.nombre, ...r, usuariosSinLocal: soloAhi.map((u) => u.nombre), gastosFijos: fijos.map((g) => g.nombre) };
  }

  async reactivar(id: number) {
    const s = await this.get(id);
    if (s.activa) return { ok: true, yaEstaba: true };
    await this.db.update(sucursales).set({ activa: true, desactivadaEn: null }).where(eq(sucursales.id, id));
    return { ok: true, sucursal: s.nombre };
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
  @Get() list(@Query('todas') todas?: string) { return this.svc.list(todas === '1' || todas === 'true'); }
  @Get(':id') get(@Param('id', ParseIntPipe) id: number) { return this.svc.get(id); }

  @Post() @Permiso('gerencia.usuarios')
  create(@Body() dto: UpsertSucursalDto) { return this.svc.create(dto); }

  @Patch(':id') @Permiso('gerencia.usuarios')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpsertSucursalDto) { return this.svc.update(id, dto); }

  @Delete(':id') @Permiso('gerencia.usuarios')
  remove(@Param('id', ParseIntPipe) id: number) { return this.svc.remove(id); }

  /** Un local que cerró (0143): sale de todas las listas para elegir; el historial queda. */
  @Post(':id/desactivar') @Permiso('gerencia.usuarios')
  desactivar(@Param('id', ParseIntPipe) id: number, @Auth() sesion: Sesion) { return this.svc.desactivar(id, sesion); }

  @Post(':id/reactivar') @Permiso('gerencia.usuarios')
  reactivar(@Param('id', ParseIntPipe) id: number) { return this.svc.reactivar(id); }
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
      sucursalActiva: sucursales.activa,
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
    if (!suc.activa) throw new BadRequestException(`${suc.nombre} está desactivada (el local cerró): registrá el equipo en otra sucursal.`);

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
      if (!suc.activa) throw new BadRequestException(`${suc.nombre} está desactivada (el local cerró): elegí otra sucursal.`);
      patch.sucursalId = suc.id;
    }
    if (dto.activa != null) patch.activa = !!dto.activa;
    /* Un equipo de un local que cerró (0143) no se reactiva ahí: primero se lo pasa a otra sucursal. */
    if (patch.activa === true && !patch.sucursalId) {
      const [suya] = await this.db.select({ nombre: sucursales.nombre, activa: sucursales.activa }).from(sucursales).where(eq(sucursales.id, t.sucursalId)).limit(1);
      if (suya && !suya.activa) throw new BadRequestException(`"${t.nombre}" es de ${suya.nombre}, que está desactivada: pasalo a otra sucursal antes de reactivarlo.`);
    }
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
