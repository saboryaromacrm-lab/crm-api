/**
 * CAFETERÍA — el puente con coffit.
 * ============================================================================
 * El dueño tiene DOS negocios con el MISMO CUIT: la distribuidora (este
 * sistema) y una cafetería cuyo stock maneja OTRO sistema (coffit). El envío
 * NO es una transferencia entre sucursales — no hay receptor en el CRM — sino
 * un PUNTO DE SALIDA: la mercadería egresa del stock valorizada A COSTO
 * congelado y del otro lado coffit la ingresa en su almacén "Sabor y Aroma",
 * donde ELLA decide qué es cada cosa (góndola, insumo, lo que sea).
 *
 * Reglas que NO se negocian:
 *  - El CRM nunca muestra existencias de Cafetería (coffit es el dueño).
 *  - El envío va a COSTO: la ganancia aparece donde se genera (cuando el café
 *    vende), no en un traspaso interno.
 *  - La CLASIFICACIÓN de la mercadería es de coffit. El CRM no pregunta
 *    destinos: manda el detalle completo y ahí termina su responsabilidad.
 *
 * CICLO DE VIDA en dos estados (desde el 9/8/2026):
 *
 *   ──crear──► enviado ──anular──► anulado
 *              (egresa stock y     (reversión completa:
 *               congela costo       todo reingresa)
 *               en el mismo acto)
 *
 * Con el envío ya se da por hecho que coffit lo recibió: el "viaje" es cruzar
 * la calle. La corrección de un envío NO es una devolución (no existen): es
 * EDITARLO — se revierte el egreso viejo y se aplica el nuevo, en una
 * transacción. Cada cambio sube `version` y toca `actualizadoEn`, que es el
 * pulso con el que coffit sincroniza (GET /cafeteria/sync).
 *
 * EL COSTO SE CONGELA UNA VEZ. Editar no re-valúa los renglones que ya
 * estaban (re-valuar cambiaría retroactivamente cuánto costó la cafetería en
 * un período ya mirado); solo un renglón NUEVO entra al costo del día.
 */
import {
  Body, Controller, Get, Inject, Injectable, Module, Param, ParseIntPipe, Post, Put, Query,
  BadRequestException, NotFoundException,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty, IsArray, IsInt, IsNumber, IsOptional, IsString, MaxLength, ValidateNested,
} from 'class-validator';
import { and, asc, desc, eq, gt, gte, inArray, lte, ne, sql } from 'drizzle-orm';
import { fechaLocal } from '../common/documentos';
import { DRIZZLE, Database } from '../db/drizzle';
import {
  enviosCafeteria, envioCafeteriaItems, gastos, pedidoCafeteriaItems, pedidosCafeteria,
  presentaciones, productoProveedores, productos, sucursales, usuarios,
} from '../db/schema';
import { InventarioModule } from '../inventario/inventario.module';
import { InventarioService } from '../inventario/inventario.service';
import { costoNetoEntry, formatoActivo } from '../inventario/pricing';

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const r3 = (n: number) => Math.round((Number(n) || 0) * 1000) / 1000;

class EnvioItemDto {
  @IsInt() productoId!: number;
  @IsOptional() @IsInt() presentacionId?: number;
  @IsNumber() cantidad!: number;
}

class CrearEnvioDto {
  @IsOptional() @IsInt() sucursalId?: number;
  @IsOptional() @IsString() fecha?: string;
  @IsOptional() @IsString() @MaxLength(500) observaciones?: string;
  @IsOptional() @IsInt() usuarioId?: number;
  /** El pedido que este envío viene a cumplir: lo cierra en el mismo acto. */
  @IsOptional() @IsInt() pedidoId?: number;
  @IsArray() @ArrayNotEmpty() @ValidateNested({ each: true }) @Type(() => EnvioItemDto)
  items!: EnvioItemDto[];
}

class EditarEnvioDto {
  /**
   * La versión que la pantalla estaba mirando. Si en el medio otro la cambió,
   * el edit se rechaza en vez de pisar en silencio lo que el otro hizo.
   */
  @IsOptional() @IsInt() version?: number;
  @IsOptional() @IsString() fecha?: string;
  @IsOptional() @IsString() @MaxLength(500) observaciones?: string;
  @IsOptional() @IsInt() usuarioId?: number;
  @IsArray() @ArrayNotEmpty() @ValidateNested({ each: true }) @Type(() => EnvioItemDto)
  items!: EnvioItemDto[];
}

class AnularEnvioDto {
  @IsString() @MaxLength(300) motivo!: string;
  @IsOptional() @IsInt() usuarioId?: number;
}

class PedidoItemDto {
  @IsInt() productoId!: number;
  @IsOptional() @IsInt() presentacionId?: number;
  @IsNumber() cantidad!: number;
}

class CrearPedidoDto {
  @IsOptional() @IsString() @MaxLength(500) observaciones?: string;
  @IsOptional() @IsInt() usuarioId?: number;
  @IsArray() @ArrayNotEmpty() @ValidateNested({ each: true }) @Type(() => PedidoItemDto)
  items!: PedidoItemDto[];
}

class AnularPedidoDto {
  @IsString() @MaxLength(300) motivo!: string;
  @IsOptional() @IsInt() usuarioId?: number;
}

@Injectable()
export class CafeteriaService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly inv: InventarioService,
  ) {}

  /** Costo unitario de HOY del formato activo ($/kg del granel, $/paquete de la presentación). */
  private async valuarItems(tx: any, items: { productoId: number; presentacionId?: number | null }[]) {
    const ids = [...new Set(items.map((it) => it.productoId))];
    const provs = await tx.select().from(productoProveedores)
      .where(inArray(productoProveedores.productoId, ids));
    const out = new Map<string, { prod: any; pres: any; costoU: number }>();
    for (const it of items) {
      const clave = `${it.productoId}-${it.presentacionId ?? 0}`;
      if (out.has(clave)) continue;
      const [prod] = await tx.select().from(productos).where(eq(productos.id, it.productoId)).limit(1);
      if (!prod) throw new BadRequestException('Producto inválido en el detalle.');
      // Archivado = fuera de catálogo: no se pide ni se manda al café.
      if (prod.estado === 'archivado') {
        throw new BadRequestException(`${prod.nombre} está archivado: ya no se maneja. Reactivalo si volvió a entrar.`);
      }
      let pres: any = null;
      if (it.presentacionId) {
        [pres] = await tx.select().from(presentaciones).where(eq(presentaciones.id, it.presentacionId)).limit(1);
        if (!pres || pres.productoId !== prod.id) throw new BadRequestException(`Presentación inválida para ${prod.nombre}.`);
      }
      const cnKg = costoNetoEntry(formatoActivo(provs.filter((p: any) => p.productoId === prod.id)) as any, prod.iva);
      out.set(clave, { prod, pres, costoU: pres ? cnKg * (pres.tamKg ?? 1) : cnKg });
    }
    return out;
  }

  /**
   * Los renglones listos para insertar, con el MODO DE UNIDAD explícito.
   * `costoDe` decide el costo unitario de cada renglón: en el alta es el de
   * hoy; en la edición conserva el congelado de los renglones que ya estaban.
   */
  private armarFilas(
    items: EnvioItemDto[],
    val: Map<string, { prod: any; pres: any; costoU: number }>,
    costoDe: (clave: string, costoHoy: number) => number,
  ) {
    let total = 0;
    const filas: any[] = [];
    for (const it of items) {
      const clave = `${it.productoId}-${it.presentacionId ?? 0}`;
      const { prod, pres, costoU } = val.get(clave)!;
      const cantidad = Number(it.cantidad);
      const costo = costoDe(clave, costoU);
      total += costo * cantidad;

      const esGranel = prod.tipo === 'granel' && !pres;
      const modo = pres ? 'paquete' : (esGranel ? 'granel' : 'unidad');
      const tamKg = pres ? Number(pres.tamKg) || 0 : (esGranel ? 1 : 0);
      const tam = pres ? (pres.tamKg < 1 ? `${Math.round(pres.tamKg * 1000)} g` : `${pres.tamKg} kg`) : '';
      filas.push({
        productoId: prod.id,
        presentacionId: pres?.id ?? null,
        modo,
        cantidad,
        tamKg,
        costoUnitario: costo,
        nombre: pres ? `${prod.nombre} · ${tam}` : prod.nombre,
        unidad: esGranel ? 'kg' : (pres ? 'paq.' : 'u.'),
        codigoBarras: (pres?.codigoBarras || prod.codigoBarras || ''),
        codigoPropio: prod.codigoPropio || '',
      });
    }
    return { filas, total: r2(total) };
  }

  /** El envío nace ENVIADO: egresa stock y congela costo en el mismo acto. */
  async crear(o: CrearEnvioDto) {
    const items = (o.items || []).filter((it) => Number(it.cantidad) > 0);
    if (!items.length) throw new BadRequestException('Agregá al menos un renglón con cantidad.');

    const id = await this.db.transaction(async (tx) => {
      const sucId = o.sucursalId
        || (await tx.select().from(sucursales).where(eq(sucursales.tipo, 'distribuidora')).limit(1))[0]?.id;
      if (!sucId) throw new BadRequestException('No hay sucursal de origen.');

      /*
       * Si viene a cumplir un pedido, el pedido se CIERRA acá, con reclamo
       * atómico: dos personas convirtiendo el mismo pedido a la vez generarían
       * dos envíos por la misma demanda — solo una gana el UPDATE condicional.
       */
      if (o.pedidoId) {
        const cerrado = await tx.update(pedidosCafeteria)
          .set({ estado: 'enviado', actualizadoEn: new Date() })
          .where(and(
            eq(pedidosCafeteria.id, o.pedidoId),
            inArray(pedidosCafeteria.estado, ['pendiente', 'armando']),
          ))
          .returning({ id: pedidosCafeteria.id });
        if (!cerrado.length) {
          throw new BadRequestException('Ese pedido ya se convirtió en envío (o está anulado) — actualizá la pantalla.');
        }
      }

      const val = await this.valuarItems(tx, items);
      const { filas, total } = this.armarFilas(items, val, (_c, hoy) => hoy);

      const [envio] = await tx.insert(enviosCafeteria).values({
        codigo: '', fecha: fechaLocal(o.fecha) ?? new Date(), sucursalId: sucId,
        usuarioId: o.usuarioId ?? null, estado: 'enviado', totalCosto: total,
        observaciones: (o.observaciones ?? '').trim(),
        version: 1, actualizadoEn: new Date(),
        pedidoId: o.pedidoId ?? null,
      }).returning();
      const codigo = `CAF${String(envio.id).padStart(4, '0')}`;
      await tx.update(enviosCafeteria).set({ codigo }).where(eq(enviosCafeteria.id, envio.id));
      await tx.insert(envioCafeteriaItems).values(filas.map((f) => ({ ...f, envioId: envio.id })));

      // Egresa de DISPONIBLE, validando que alcance (el helper corta si no).
      await this.inv.egresarStockItems(tx, {
        sucursalId: sucId, usuarioId: o.usuarioId ?? null, tipoMovimiento: 'envio_cafeteria',
        items: filas.map((f) => ({ productoId: f.productoId, presentacionId: f.presentacionId, cantidad: f.cantidad })),
        descripcion: `${codigo}: enviado a Cafetería`,
      });
      return envio.id;
    });
    return this.get(id);
  }

  /**
   * EDITAR UN ENVÍO YA ENVIADO — la única forma de corregirlo (no hay
   * devoluciones). El patrón es el de la casa: REVERTIR Y RE-APLICAR, nunca
   * deltas. En una sola transacción:
   *
   *   1. La fila del envío se toma con FOR UPDATE (dos edits simultáneos se
   *      serializan; edit y anular no se pisan).
   *   2. Se valida la versión que la pantalla estaba mirando.
   *   3. Se REINGRESA todo el detalle viejo (la reversión).
   *   4. Se arma el detalle nuevo: el renglón que ya estaba CONSERVA su costo
   *      congelado; el renglón nuevo se valúa al costo de hoy.
   *   5. Se EGRESA el detalle nuevo — la validación de stock corre acá, ya con
   *      lo viejo devuelto: subir de 10 a 15 kg exige 5 de más, no 15.
   *   6. version + 1, actualizadoEn = ahora: coffit se entera en el próximo sync.
   *
   * Si algo falla (stock que no alcanza, producto inválido), la transacción
   * entera vuelve atrás y el envío queda EXACTAMENTE como estaba.
   */
  async editar(id: number, o: EditarEnvioDto) {
    const items = (o.items || []).filter((it) => Number(it.cantidad) > 0);
    if (!items.length) {
      throw new BadRequestException('Un envío sin renglones no existe: si no va más, anulalo.');
    }

    const avisos: string[] = [];
    await this.db.transaction(async (tx) => {
      const [envio] = await tx.select().from(enviosCafeteria)
        .where(eq(enviosCafeteria.id, id)).limit(1).for('update');
      if (!envio) throw new NotFoundException('Envío inexistente.');
      if (envio.estado === 'anulado') throw new BadRequestException('Un envío anulado no se edita.');
      if (o.version != null && o.version !== envio.version) {
        throw new BadRequestException('El envío cambió desde que abriste la pantalla — actualizá y volvé a intentar.');
      }

      const viejos = await tx.select().from(envioCafeteriaItems)
        .where(eq(envioCafeteriaItems.envioId, id));

      /* 3 — la reversión: todo lo viejo vuelve a disponible. */
      await this.inv.reingresarStockItems(tx, {
        sucursalId: envio.sucursalId, usuarioId: o.usuarioId ?? null,
        items: viejos.map((f) => ({ productoId: f.productoId, presentacionId: f.presentacionId, cantidad: f.cantidad })),
        descripcion: `${envio.codigo} v${envio.version + 1}: edición — reversión del detalle anterior`,
      });

      /* 4 — el detalle nuevo, conservando el costo congelado de lo que ya estaba. */
      const costoViejo = new Map(viejos.map((f) => [`${f.productoId}-${f.presentacionId ?? 0}`, f.costoUnitario]));
      const val = await this.valuarItems(tx, items);
      const { filas, total } = this.armarFilas(items, val, (clave, hoy) => {
        const congelado = costoViejo.get(clave);
        if (congelado != null) return congelado;
        avisos.push(`${val.get(clave)!.prod.nombre}: renglón nuevo, valuado al costo de hoy.`);
        return hoy;
      });

      await tx.delete(envioCafeteriaItems).where(eq(envioCafeteriaItems.envioId, id));
      await tx.insert(envioCafeteriaItems).values(filas.map((f) => ({ ...f, envioId: id })));

      /* 5 — el egreso nuevo. La validación de stock corre acá, después de la
       * reversión: si no alcanza, TODO vuelve atrás. */
      await this.inv.egresarStockItems(tx, {
        sucursalId: envio.sucursalId, usuarioId: o.usuarioId ?? null, tipoMovimiento: 'envio_cafeteria',
        items: filas.map((f) => ({ productoId: f.productoId, presentacionId: f.presentacionId, cantidad: f.cantidad })),
        descripcion: `${envio.codigo} v${envio.version + 1}: edición — detalle nuevo`,
      });

      await tx.update(enviosCafeteria).set({
        totalCosto: total,
        fecha: fechaLocal(o.fecha) ?? envio.fecha,
        observaciones: o.observaciones != null ? o.observaciones.trim() : envio.observaciones,
        version: envio.version + 1,
        actualizadoEn: new Date(),
      }).where(eq(enviosCafeteria.id, id));
    });
    return { ...(await this.get(id)), avisos };
  }

  /** Anular = reversión completa. También sube la versión: coffit tiene que deshacer su ingreso. */
  async anular(id: number, o: AnularEnvioDto) {
    if (!o.motivo?.trim()) throw new BadRequestException('Escribí por qué se anula.');
    await this.db.transaction(async (tx) => {
      const [envio] = await tx.select().from(enviosCafeteria)
        .where(eq(enviosCafeteria.id, id)).limit(1).for('update');
      if (!envio) throw new NotFoundException('Envío inexistente.');
      if (envio.estado === 'anulado') throw new BadRequestException('El envío ya está anulado.');

      const items = await tx.select().from(envioCafeteriaItems)
        .where(eq(envioCafeteriaItems.envioId, id));
      await this.inv.reingresarStockItems(tx, {
        sucursalId: envio.sucursalId, usuarioId: o.usuarioId ?? null,
        items: items.map((f) => ({ productoId: f.productoId, presentacionId: f.presentacionId, cantidad: f.cantidad })),
        descripcion: `${envio.codigo}: envío a Cafetería ANULADO — reingreso completo`,
      });
      await tx.update(enviosCafeteria).set({
        estado: 'anulado', motivoAnulacion: o.motivo.trim(),
        version: envio.version + 1, actualizadoEn: new Date(),
      }).where(eq(enviosCafeteria.id, id));
    });
    return this.get(id);
  }

  /** Kg totales de un renglón, para que coffit contraste y la trampa del 20× no exista. */
  private conKg(it: any) {
    const totalKg = it.modo === 'granel' ? r3(it.cantidad)
      : it.modo === 'paquete' ? r3(it.cantidad * it.tamKg)
        : null;
    return { ...it, totalKg };
  }

  async list(q: { desde?: string; hasta?: string; estado?: string; limit?: number }) {
    const conds: any[] = [];
    const desde = fechaLocal(q.desde);
    const hasta = fechaLocal(q.hasta);
    if (desde) conds.push(gte(enviosCafeteria.fecha, desde));
    if (hasta) { hasta.setHours(23, 59, 59, 999); conds.push(lte(enviosCafeteria.fecha, hasta)); }
    if (q.estado === 'enviado' || q.estado === 'anulado') {
      conds.push(eq(enviosCafeteria.estado, q.estado as any));
    }
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 300);

    const rows = await this.db.select({
      id: enviosCafeteria.id, codigo: enviosCafeteria.codigo,
      fecha: enviosCafeteria.fecha, sucursalId: enviosCafeteria.sucursalId,
      estado: enviosCafeteria.estado, totalCosto: enviosCafeteria.totalCosto,
      observaciones: enviosCafeteria.observaciones, version: enviosCafeteria.version,
      actualizadoEn: enviosCafeteria.actualizadoEn,
      sucursalNombre: sucursales.nombre, usuarioNombre: usuarios.nombre,
    }).from(enviosCafeteria)
      .leftJoin(sucursales, eq(sucursales.id, enviosCafeteria.sucursalId))
      .leftJoin(usuarios, eq(usuarios.id, enviosCafeteria.usuarioId))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(enviosCafeteria.id))
      .limit(limit);

    const cuenta = await this.db.select({
      envioId: envioCafeteriaItems.envioId,
      renglones: sql<number>`count(*)`,
    }).from(envioCafeteriaItems)
      .where(inArray(envioCafeteriaItems.envioId, rows.length ? rows.map((r) => r.id) : [-1]))
      .groupBy(envioCafeteriaItems.envioId);
    const porEnvio = new Map(cuenta.map((c) => [c.envioId, Number(c.renglones)]));
    return rows.map((r) => ({ ...r, renglones: porEnvio.get(r.id) ?? 0 }));
  }

  async get(id: number) {
    const [envio] = await this.db.select({
      id: enviosCafeteria.id, codigo: enviosCafeteria.codigo,
      fecha: enviosCafeteria.fecha, sucursalId: enviosCafeteria.sucursalId,
      estado: enviosCafeteria.estado, totalCosto: enviosCafeteria.totalCosto,
      observaciones: enviosCafeteria.observaciones, motivoAnulacion: enviosCafeteria.motivoAnulacion,
      version: enviosCafeteria.version, actualizadoEn: enviosCafeteria.actualizadoEn,
      pedidoId: enviosCafeteria.pedidoId, pedidoCodigo: pedidosCafeteria.codigo,
      sucursalNombre: sucursales.nombre, usuarioNombre: usuarios.nombre,
    }).from(enviosCafeteria)
      .leftJoin(sucursales, eq(sucursales.id, enviosCafeteria.sucursalId))
      .leftJoin(usuarios, eq(usuarios.id, enviosCafeteria.usuarioId))
      .leftJoin(pedidosCafeteria, eq(pedidosCafeteria.id, enviosCafeteria.pedidoId))
      .where(eq(enviosCafeteria.id, id)).limit(1);
    if (!envio) throw new NotFoundException('Envío inexistente.');
    const items = await this.db.select().from(envioCafeteriaItems)
      .where(eq(envioCafeteriaItems.envioId, id))
      .orderBy(envioCafeteriaItems.id);
    return { ...envio, items: items.map((it) => this.conKg(it)) };
  }

  /* ==================================================================== *
   * PEDIDOS DE LA CAFETERÍA — la demanda, separada del envío
   * ==================================================================== *
   * Los arma el usuario del rol Cafetería (su única pantalla del CRM) contra
   * el catálogo completo con disponibilidad. NO tocan stock ni costo: la
   * realidad entra con el envío, que se crea desde el pedido y lo cierra.
   */

  async crearPedido(o: CrearPedidoDto) {
    const items = (o.items || []).filter((it) => Number(it.cantidad) > 0);
    if (!items.length) throw new BadRequestException('Agregá al menos un renglón con cantidad.');

    const id = await this.db.transaction(async (tx) => {
      // valuarItems valida producto/presentación y da los nombres; el costo
      // que calcula acá NO se guarda — el pedido es demanda, no plata.
      const val = await this.valuarItems(tx, items);
      const filas = items.map((it) => {
        const { prod, pres } = val.get(`${it.productoId}-${it.presentacionId ?? 0}`)!;
        const esGranel = prod.tipo === 'granel' && !pres;
        const tam = pres ? (pres.tamKg < 1 ? `${Math.round(pres.tamKg * 1000)} g` : `${pres.tamKg} kg`) : '';
        return {
          productoId: prod.id,
          presentacionId: pres?.id ?? null,
          cantidad: Number(it.cantidad),
          nombre: pres ? `${prod.nombre} · ${tam}` : prod.nombre,
          unidad: esGranel ? 'kg' : (pres ? 'paq.' : 'u.'),
        };
      });

      const [pedido] = await tx.insert(pedidosCafeteria).values({
        codigo: '', usuarioId: o.usuarioId ?? null,
        observaciones: (o.observaciones ?? '').trim(), actualizadoEn: new Date(),
      }).returning();
      const codigo = `PCAF${String(pedido.id).padStart(4, '0')}`;
      await tx.update(pedidosCafeteria).set({ codigo }).where(eq(pedidosCafeteria.id, pedido.id));
      await tx.insert(pedidoCafeteriaItems).values(filas.map((f) => ({ ...f, pedidoId: pedido.id })));
      return pedido.id;
    });
    return this.getPedido(id);
  }

  async listPedidos(q: { estado?: string; limit?: number } = {}) {
    const conds: any[] = [];
    if (q.estado && ['pendiente', 'armando', 'enviado', 'anulado'].includes(q.estado)) {
      conds.push(eq(pedidosCafeteria.estado, q.estado as any));
    }
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 300);
    const rows = await this.db.select({
      id: pedidosCafeteria.id, codigo: pedidosCafeteria.codigo, fecha: pedidosCafeteria.fecha,
      estado: pedidosCafeteria.estado, observaciones: pedidosCafeteria.observaciones,
      usuarioNombre: usuarios.nombre,
      // El envío que lo cumplió, si ya se convirtió.
      envioId: enviosCafeteria.id, envioCodigo: enviosCafeteria.codigo,
    }).from(pedidosCafeteria)
      .leftJoin(usuarios, eq(usuarios.id, pedidosCafeteria.usuarioId))
      .leftJoin(enviosCafeteria, eq(enviosCafeteria.pedidoId, pedidosCafeteria.id))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(pedidosCafeteria.id))
      .limit(limit);

    const cuenta = await this.db.select({
      pedidoId: pedidoCafeteriaItems.pedidoId,
      renglones: sql<number>`count(*)`,
    }).from(pedidoCafeteriaItems)
      .where(inArray(pedidoCafeteriaItems.pedidoId, rows.length ? rows.map((r) => r.id) : [-1]))
      .groupBy(pedidoCafeteriaItems.pedidoId);
    const porPedido = new Map(cuenta.map((c) => [c.pedidoId, Number(c.renglones)]));
    return rows.map((r) => ({ ...r, renglones: porPedido.get(r.id) ?? 0 }));
  }

  async getPedido(id: number) {
    const [pedido] = await this.db.select({
      id: pedidosCafeteria.id, codigo: pedidosCafeteria.codigo, fecha: pedidosCafeteria.fecha,
      estado: pedidosCafeteria.estado, observaciones: pedidosCafeteria.observaciones,
      motivoAnulacion: pedidosCafeteria.motivoAnulacion, actualizadoEn: pedidosCafeteria.actualizadoEn,
      usuarioId: pedidosCafeteria.usuarioId, usuarioNombre: usuarios.nombre,
      envioId: enviosCafeteria.id, envioCodigo: enviosCafeteria.codigo,
    }).from(pedidosCafeteria)
      .leftJoin(usuarios, eq(usuarios.id, pedidosCafeteria.usuarioId))
      .leftJoin(enviosCafeteria, eq(enviosCafeteria.pedidoId, pedidosCafeteria.id))
      .where(eq(pedidosCafeteria.id, id)).limit(1);
    if (!pedido) throw new NotFoundException('Pedido inexistente.');
    const items = await this.db.select().from(pedidoCafeteriaItems)
      .where(eq(pedidoCafeteriaItems.pedidoId, id))
      .orderBy(pedidoCafeteriaItems.id);
    return { ...pedido, items };
  }

  /** El contador del badge y del aviso del admin: qué demanda espera. */
  async pedidosPendientes() {
    const rows = await this.db.select({
      estado: pedidosCafeteria.estado,
      n: sql<number>`count(*)::int`,
    }).from(pedidosCafeteria)
      .where(inArray(pedidosCafeteria.estado, ['pendiente', 'armando']))
      .groupBy(pedidosCafeteria.estado);
    const de = (e: string) => Number(rows.find((r) => r.estado === e)?.n) || 0;
    return { pendientes: de('pendiente'), armando: de('armando') };
  }

  /** pendiente → armando: "lo estoy preparando". Reclamo atómico. */
  async tomarPedido(id: number) {
    const gano = await this.db.update(pedidosCafeteria)
      .set({ estado: 'armando', actualizadoEn: new Date() })
      .where(and(eq(pedidosCafeteria.id, id), eq(pedidosCafeteria.estado, 'pendiente')))
      .returning({ id: pedidosCafeteria.id });
    if (!gano.length) throw new BadRequestException('El pedido cambió de estado — actualizá la pantalla.');
    return this.getPedido(id);
  }

  async anularPedido(id: number, o: AnularPedidoDto) {
    if (!o.motivo?.trim()) throw new BadRequestException('Escribí por qué se anula.');
    const gano = await this.db.update(pedidosCafeteria)
      .set({ estado: 'anulado', motivoAnulacion: o.motivo.trim(), actualizadoEn: new Date() })
      .where(and(
        eq(pedidosCafeteria.id, id),
        inArray(pedidosCafeteria.estado, ['pendiente', 'armando']),
      ))
      .returning({ id: pedidosCafeteria.id });
    if (!gano.length) throw new BadRequestException('Ese pedido ya se envió (o ya estaba anulado): no se anula.');
    return this.getPedido(id);
  }

  /**
   * SINCRONIZACIÓN PARA COFFIT: todo lo que cambió desde `desde` (creados,
   * editados y anulados — el anulado VIAJA, coffit tiene que deshacerlo), con
   * el detalle completo. `ahora` va en la respuesta para que coffit lo guarde
   * como el próximo `desde`: así el cursor lo pone el reloj de ESTE servidor y
   * no hay agujeros por relojes desfasados.
   */
  async sync(desde?: string) {
    const ahora = new Date();
    const corte = desde ? new Date(desde) : null;
    if (desde && Number.isNaN(corte!.getTime())) {
      throw new BadRequestException('El desde va en formato ISO (el "ahora" de la respuesta anterior).');
    }
    const envios = await this.db.select().from(enviosCafeteria)
      .where(corte ? gt(enviosCafeteria.actualizadoEn, corte) : undefined)
      .orderBy(asc(enviosCafeteria.actualizadoEn))
      .limit(200);

    const items = envios.length
      ? await this.db.select().from(envioCafeteriaItems)
        .where(inArray(envioCafeteriaItems.envioId, envios.map((e) => e.id)))
        .orderBy(envioCafeteriaItems.id)
      : [];
    const porEnvio = new Map<number, any[]>();
    for (const it of items) {
      const arr = porEnvio.get(it.envioId) ?? [];
      arr.push(this.conKg(it));
      porEnvio.set(it.envioId, arr);
    }
    return {
      ahora: ahora.toISOString(),
      envios: envios.map((e) => ({ ...e, items: porEnvio.get(e.id) ?? [] })),
    };
  }

  /**
   * MÉTRICA: qué se le mandó a coffit en el período, agregado POR ARTÍCULO.
   * Suma solo lo enviado (lo anulado no existió). El agregado corre en SQL:
   * traer todos los renglones para sumarlos en JS sería peso al aire.
   */
  async metrica(q: { desde?: string; hasta?: string; buscar?: string }) {
    const desde = fechaLocal(q.desde);
    const hasta = fechaLocal(q.hasta);
    if (hasta) hasta.setHours(23, 59, 59, 999);
    const conds: any[] = [eq(enviosCafeteria.estado, 'enviado')];
    if (desde) conds.push(gte(enviosCafeteria.fecha, desde));
    if (hasta) conds.push(lte(enviosCafeteria.fecha, hasta));
    const buscar = (q.buscar ?? '').trim();
    const condsItems = [...conds];
    if (buscar) condsItems.push(sql`${envioCafeteriaItems.nombre} ilike ${`%${buscar}%`}`);

    const [cab] = await this.db.select({
      envios: sql<number>`count(*)::int`,
      costoTotal: sql<number>`coalesce(sum(${enviosCafeteria.totalCosto}), 0)`,
    }).from(enviosCafeteria).where(and(...conds));

    const productosAgg = await this.db.select({
      productoId: envioCafeteriaItems.productoId,
      presentacionId: envioCafeteriaItems.presentacionId,
      nombre: envioCafeteriaItems.nombre,
      modo: envioCafeteriaItems.modo,
      unidad: envioCafeteriaItems.unidad,
      envios: sql<number>`count(distinct ${envioCafeteriaItems.envioId})::int`,
      cantidad: sql<number>`coalesce(sum(${envioCafeteriaItems.cantidad}), 0)`,
      kg: sql<number>`coalesce(sum(case
        when ${envioCafeteriaItems.modo} = 'granel' then ${envioCafeteriaItems.cantidad}
        when ${envioCafeteriaItems.modo} = 'paquete' then ${envioCafeteriaItems.cantidad} * ${envioCafeteriaItems.tamKg}
        else 0 end), 0)`,
      costo: sql<number>`coalesce(sum(${envioCafeteriaItems.cantidad} * ${envioCafeteriaItems.costoUnitario}), 0)`,
    }).from(envioCafeteriaItems)
      .innerJoin(enviosCafeteria, eq(enviosCafeteria.id, envioCafeteriaItems.envioId))
      .where(and(...condsItems))
      .groupBy(
        envioCafeteriaItems.productoId, envioCafeteriaItems.presentacionId,
        envioCafeteriaItems.nombre, envioCafeteriaItems.modo, envioCafeteriaItems.unidad,
      )
      .orderBy(sql`sum(${envioCafeteriaItems.cantidad} * ${envioCafeteriaItems.costoUnitario}) desc`);

    const productosOut = productosAgg.map((p) => ({
      ...p,
      cantidad: r3(Number(p.cantidad)),
      kg: r3(Number(p.kg)),
      costo: r2(Number(p.costo)),
    }));
    return {
      envios: Number(cab?.envios) || 0,
      costoTotal: r2(Number(cab?.costoTotal) || 0),
      kgTotales: r3(productosOut.reduce((a, p) => a + p.kg, 0)),
      articulos: productosOut.length,
      productos: productosOut,
    };
  }

  /**
   * La foto de gestión del período: cuánto le costó la cafetería al negocio.
   * Envíos (a costo) MÁS los gastos imputados a ella. Las ventas las tiene
   * coffit — la rentabilidad es la resta entre los dos sistemas.
   */
  async resumen(q: { desde?: string; hasta?: string }) {
    const desde = fechaLocal(q.desde);
    const hasta = fechaLocal(q.hasta);
    if (hasta) hasta.setHours(23, 59, 59, 999);
    const condsEnvio: any[] = [eq(enviosCafeteria.estado, 'enviado')];
    const condsGasto: any[] = [eq(gastos.negocio, 'cafeteria'), ne(gastos.estado, 'anulado')];
    if (desde) { condsEnvio.push(gte(enviosCafeteria.fecha, desde)); condsGasto.push(gte(gastos.fecha, desde)); }
    if (hasta) { condsEnvio.push(lte(enviosCafeteria.fecha, hasta)); condsGasto.push(lte(gastos.fecha, hasta)); }

    const [e] = await this.db.select({
      total: sql<number>`coalesce(sum(${enviosCafeteria.totalCosto}), 0)`,
      cantidad: sql<number>`count(*)`,
    }).from(enviosCafeteria).where(and(...condsEnvio));
    const [g] = await this.db.select({
      total: sql<number>`coalesce(sum(${gastos.total}), 0)`,
      cantidad: sql<number>`count(*)`,
    }).from(gastos).where(and(...condsGasto));

    const enviado = Number(e?.total ?? 0);
    const gastosCafe = Number(g?.total ?? 0);
    return {
      enviado: r2(enviado),
      enviosCantidad: Number(e?.cantidad ?? 0),
      gastos: r2(gastosCafe),
      gastosCantidad: Number(g?.cantidad ?? 0),
      costoTotal: r2(enviado + gastosCafe),
    };
  }
}

@Controller('cafeteria')
export class CafeteriaController {
  constructor(private readonly svc: CafeteriaService) {}

  @Get('envios') list(
    @Query('desde') desde?: string,
    @Query('hasta') hasta?: string,
    @Query('estado') estado?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.list({ desde, hasta, estado, limit: limit ? Number(limit) : undefined });
  }

  @Get('resumen') resumen(@Query('desde') desde?: string, @Query('hasta') hasta?: string) {
    return this.svc.resumen({ desde, hasta });
  }

  @Get('metrica') metrica(
    @Query('desde') desde?: string,
    @Query('hasta') hasta?: string,
    @Query('buscar') buscar?: string,
  ) {
    return this.svc.metrica({ desde, hasta, buscar });
  }

  /** El endpoint de coffit: todo lo que cambió desde el cursor. */
  @Get('sync') sync(@Query('desde') desde?: string) {
    return this.svc.sync(desde);
  }

  /* ---- Pedidos de la cafetería (la demanda) ---- */

  @Get('pedidos') listPedidos(@Query('estado') estado?: string, @Query('limit') limit?: string) {
    return this.svc.listPedidos({ estado, limit: limit ? Number(limit) : undefined });
  }

  /** El poller del aviso del admin: un count, nada más. */
  @Get('pedidos-pendientes') pedidosPendientes() {
    return this.svc.pedidosPendientes();
  }

  @Get('pedidos/:id') getPedido(@Param('id', ParseIntPipe) id: number) {
    return this.svc.getPedido(id);
  }

  @Post('pedidos') crearPedido(@Body() dto: CrearPedidoDto) {
    return this.svc.crearPedido(dto);
  }

  @Post('pedidos/:id/tomar') tomarPedido(@Param('id', ParseIntPipe) id: number) {
    return this.svc.tomarPedido(id);
  }

  @Post('pedidos/:id/anular') anularPedido(@Param('id', ParseIntPipe) id: number, @Body() dto: AnularPedidoDto) {
    return this.svc.anularPedido(id, dto);
  }

  @Get('envios/:id') get(@Param('id', ParseIntPipe) id: number) {
    return this.svc.get(id);
  }

  @Post('envios') crear(@Body() dto: CrearEnvioDto) {
    return this.svc.crear(dto);
  }

  @Put('envios/:id') editar(@Param('id', ParseIntPipe) id: number, @Body() dto: EditarEnvioDto) {
    return this.svc.editar(id, dto);
  }

  @Post('envios/:id/anular') anular(@Param('id', ParseIntPipe) id: number, @Body() dto: AnularEnvioDto) {
    return this.svc.anular(id, dto);
  }
}

@Module({
  imports: [InventarioModule],
  controllers: [CafeteriaController],
  providers: [CafeteriaService],
  exports: [CafeteriaService],
})
export class CafeteriaModule {}
