import {
  BadRequestException, Body, Controller, Delete, Get, Inject, Injectable, Module,
  NotFoundException, Param, ParseIntPipe, Patch, Post, Put, Query,
} from '@nestjs/common';
import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { and, eq } from 'drizzle-orm';
import { Auth, Permiso, type Sesion } from '../auth/auth.decoradores';
import { DRIZZLE, Database } from '../db/drizzle';
import { proveedorCuentas, proveedorPercepciones, proveedores } from '../db/schema';
import { AuditoriaModule, AuditoriaService } from '../auditoria/auditoria.module';

class UpsertProveedorDto {
  @IsString() nombre!: string;
  @IsOptional() @IsString() cuit?: string;
  /** Define si su factura discrimina IVA (de acá sale la alícuota por defecto). */
  @IsOptional() @IsIn(['responsable_inscripto', 'monotributo', 'consumidor_final', 'exento', 'no_categorizado'])
  condicionIva?: string;
  @IsOptional() @IsString() direccion?: string;
  @IsOptional() @IsString() telefono?: string;
  @IsOptional() @IsString() email?: string;
  /**
   * Clasificación, no permiso: en qué buscador aparece. Un proveedor puede ser
   * las dos cosas (el que trae mercadería y además te cobra el flete).
   */
  @IsOptional() @IsBoolean() proveeMercaderia?: boolean;
  @IsOptional() @IsBoolean() proveeGastos?: boolean;
  /**
   * La letra que factura (0067): se pregunta UNA vez acá y la carga de gastos
   * la precarga, editable. `''` = borrarla (vuelve a "sin definir"), ausente =
   * conservar la que tenía.
   */
  @IsOptional() @IsIn(['A', 'B', 'C', 'X', '']) letraGasto?: string;
  /* ---- La ficha comercial (0068, módulo Proveedores) ---- */
  /** Qué emite: factura / liquidación (la mitad sin factura) / mixto. */
  @IsOptional() @IsIn(['factura', 'liquidacion', 'mixto']) condicionCompra?: string;
  /** Cómo cobra habitualmente. '' = sin definir; cta_cte/echeq generan compromiso. */
  @IsOptional() @IsIn(['efectivo', 'transferencia', 'deposito', 'echeq', 'cta_cte', ''])
  medioHabitual?: string;
  /** Plazo en días del diferido ("Cta cte 15"). null/0 = sin plazo cargado. */
  @IsOptional() @IsInt() @Min(0) @Max(365) diasPago?: number | null;
  @IsOptional() @IsIn(['facturas', 'libre']) modoCuenta?: string;
  /**
   * Qué parte del valor vende SIN factura, habitualmente (0–100, 0072). Es el
   * default que precarga los formatos de compra nuevos de este proveedor; el
   * que manda para el costo es siempre el del formato.
   */
  @IsOptional() @IsNumber() @Min(0) @Max(100) porcSinFactura?: number;
}

/* Cómo se muestran los valores de la ficha comercial en la auditoría: el
 * registro se LEE, así que guarda las palabras de la pantalla, no los enums. */
const LEGIBLE_CONDICION: Record<string, string> = {
  factura: 'Factura', liquidacion: 'Liquidación', mixto: 'Mixto (mitad y mitad)',
};
const LEGIBLE_MEDIO: Record<string, string> = {
  efectivo: 'Efectivo', transferencia: 'Transferencia', deposito: 'Depósito',
  echeq: 'Echeq', cta_cte: 'Cuenta corriente',
};

@Injectable()
export class ProveedoresService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditoriaService,
  ) {}

  /** La foto legible de lo auditable de la ficha, para comparar antes/después. */
  private fotoFicha(p: any): Record<string, string> {
    return {
      nombre: p.nombre ?? '',
      cuit: p.cuit ?? '',
      condicionCompra: LEGIBLE_CONDICION[p.condicionCompra] ?? (p.condicionCompra ?? ''),
      medioHabitual: p.medioHabitual ? (LEGIBLE_MEDIO[p.medioHabitual] ?? p.medioHabitual) : 'Sin definir',
      diasPago: p.diasPago ? `${p.diasPago} día(s)` : 'Sin plazo',
      modoCuenta: p.modoCuenta === 'libre' ? 'Libre' : 'Por facturas',
      porcSinFactura: `${Number(p.porcSinFactura) || 0}%`,
    };
  }

  /**
   * `tipo` filtra por clasificación ('mercaderia' | 'gastos'); sin él vienen
   * todos. El filtro NO es excluyente: un proveedor marcado como los dos sale
   * en las dos listas, que es exactamente lo que se quiere.
   */
  list(tipo?: string) {
    const conds: any[] = [];
    if (tipo === 'mercaderia') conds.push(eq(proveedores.proveeMercaderia, true));
    if (tipo === 'gastos') conds.push(eq(proveedores.proveeGastos, true));
    return this.db.select().from(proveedores)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(proveedores.nombre);
  }

  async get(id: number) {
    const [p] = await this.db.select().from(proveedores).where(eq(proveedores.id, id)).limit(1);
    if (!p) throw new NotFoundException('Proveedor inexistente.');
    return p;
  }

  async create(dto: UpsertProveedorDto) {
    const [p] = await this.db.insert(proveedores).values({
      nombre: dto.nombre.trim(), cuit: dto.cuit ?? '', condicionIva: (dto.condicionIva ?? 'responsable_inscripto') as any, direccion: dto.direccion ?? '',
      telefono: dto.telefono ?? '', email: dto.email ?? '',
      // Sin indicar nada se asume el proveedor clásico: el que trae mercadería.
      proveeMercaderia: dto.proveeMercaderia ?? true,
      proveeGastos: dto.proveeGastos ?? false,
      letraGasto: (dto.letraGasto || null) as any,
      condicionCompra: (dto.condicionCompra ?? 'factura') as any,
      medioHabitual: (dto.medioHabitual || null) as any,
      diasPago: dto.diasPago || null,
      modoCuenta: (dto.modoCuenta ?? 'facturas') as any,
      // Sin número explícito, "emite liquidación" solo puede querer decir 100.
      porcSinFactura: dto.porcSinFactura ?? (dto.condicionCompra === 'liquidacion' ? 100 : 0),
    }).returning();
    return p;
  }

  async update(id: number, dto: UpsertProveedorDto, usuarioId?: number | null) {
    const actual = await this.get(id);
    const [p] = await this.db.update(proveedores).set({
      nombre: dto.nombre.trim(),
      // TODO el update es "ausente conserva, '' borra" — también la identidad:
      // un PATCH parcial (solo la ficha comercial) no puede volar el CUIT.
      cuit: dto.cuit === undefined ? actual.cuit : dto.cuit.trim(),
      condicionIva: (dto.condicionIva ?? actual.condicionIva) as any,
      direccion: dto.direccion === undefined ? actual.direccion : dto.direccion.trim(),
      telefono: dto.telefono === undefined ? actual.telefono : dto.telefono.trim(),
      email: dto.email === undefined ? actual.email : dto.email.trim(),
      // Un formulario viejo que no manda los flags no puede reclasificar al
      // proveedor sin querer: si no vienen, se conserva lo que ya tenía.
      proveeMercaderia: dto.proveeMercaderia ?? actual.proveeMercaderia,
      proveeGastos: dto.proveeGastos ?? actual.proveeGastos,
      // '' borra a propósito; ausente conserva (mismo criterio que los flags).
      letraGasto: (dto.letraGasto === undefined ? actual.letraGasto : (dto.letraGasto || null)) as any,
      /* La ficha comercial sigue el mismo contrato: ausente conserva, '' borra.
       * OJO con el medio habitual: cambiarlo NO toca compromisos ya generados
       * (el plazo pactado quedó congelado en cada compromiso, como en la app). */
      condicionCompra: (dto.condicionCompra ?? actual.condicionCompra) as any,
      medioHabitual: (dto.medioHabitual === undefined ? actual.medioHabitual : (dto.medioHabitual || null)) as any,
      diasPago: dto.diasPago === undefined ? actual.diasPago : (dto.diasPago || null),
      modoCuenta: (dto.modoCuenta ?? actual.modoCuenta) as any,
      porcSinFactura: dto.porcSinFactura ?? actual.porcSinFactura,
    }).where(eq(proveedores.id, id)).returning();

    /* AUDITORÍA (0086): la identidad y la ficha comercial, campo por campo.
     * Se compara la FOTO legible antes/después — solo lo que cambió deja fila. */
    await this.audit.registrar(this.audit.diferencias(
      { entidad: 'proveedor', entidadId: id, ambito: 'Ficha del proveedor', usuarioId },
      this.fotoFicha(actual), this.fotoFicha(p),
      {
        nombre: 'Nombre', cuit: 'CUIT',
        condicionCompra: 'Condición de compra', medioHabitual: 'Medio de pago habitual',
        diasPago: 'Plazo de pago', modoCuenta: 'Modo de cuenta',
        porcSinFactura: 'Sin factura % (default de sus formatos)',
      },
    ));
    return p;
  }

  async remove(id: number) {
    await this.get(id);
    // Los costos por proveedor se borran en cascada; el proveedor_activo_id queda en null.
    await this.db.delete(proveedores).where(eq(proveedores.id, id));
    return { ok: true };
  }

  /* -------------------------- CUENTAS BANCARIAS -------------------------- *
   * CBU o alias para transferirle, con su descripción ("Galicia, del titular").
   * Full-replace como las percepciones: el formulario manda la lista entera.
   * Dato de referencia puro — sin historia, sin soft-delete.
   */
  cuentas(proveedorId: number) {
    return this.db.select().from(proveedorCuentas)
      .where(eq(proveedorCuentas.proveedorId, proveedorId))
      .orderBy(proveedorCuentas.id);
  }

  async setCuentas(proveedorId: number, filas: any[]) {
    await this.get(proveedorId);
    const validas = (filas || [])
      .filter((f) => (f?.cbuAlias ?? '').trim())
      .map((f) => ({
        proveedorId,
        cbuAlias: String(f.cbuAlias).trim().slice(0, 120),
        descripcion: String(f.descripcion ?? '').trim().slice(0, 100),
      }));
    if (validas.length > 5) throw new BadRequestException('Hasta 5 cuentas bancarias por proveedor.');
    await this.db.transaction(async (tx) => {
      await tx.delete(proveedorCuentas).where(eq(proveedorCuentas.proveedorId, proveedorId));
      if (validas.length) await tx.insert(proveedorCuentas).values(validas);
    });
    return this.cuentas(proveedorId);
  }

  /* ---------------------------- PERCEPCIONES ---------------------------- *
   * Las que ESTE proveedor suele cobrar. Se configuran una vez acá y después
   * la carga de la factura las ofrece con un tilde: el mismo proveedor a veces
   * las trae y a veces no, así que nunca se aplican solas.
   */
  percepciones(proveedorId: number) {
    return this.db.select().from(proveedorPercepciones)
      .where(eq(proveedorPercepciones.proveedorId, proveedorId))
      .orderBy(proveedorPercepciones.id);
  }

  /**
   * Reemplaza la lista completa (el formulario manda todas las filas juntas).
   * Se borra y se reinserta: las percepciones YA APLICADAS a un comprobante
   * tienen su propia copia con nombre y alícuota, así que tocar esta lista no
   * altera ninguna factura vieja.
   */
  async setPercepciones(proveedorId: number, filas: any[], usuarioId?: number | null) {
    await this.get(proveedorId);
    const validas = (filas || [])
      .filter((f) => (f?.nombre ?? '').trim())
      .map((f) => ({
        proveedorId,
        nombre: String(f.nombre).trim(),
        alicuota: Number(f.alicuota) || 0,
        base: (f.base === 'total' ? 'total' : 'neto') as 'neto' | 'total',
        activa: f.activa !== false,
      }));
    for (const f of validas) {
      if (f.alicuota < 0 || f.alicuota > 100) {
        throw new BadRequestException(`La alícuota de "${f.nombre}" tiene que estar entre 0 y 100.`);
      }
    }

    /* AUDITORÍA (0086): el full-replace se traduce a cambios legibles POR
     * PERCEPCIÓN (comparando por nombre): agregada, quitada o modificada. */
    const anteriores = await this.percepciones(proveedorId);
    const legible = (f: any) => `${Number(f.alicuota) || 0}% sobre ${f.base === 'total' ? 'el total' : 'el neto'}${f.activa === false ? ' (inactiva)' : ''}`;
    const viejas = new Map(anteriores.map((f: any) => [f.nombre, legible(f)]));
    const nuevas = new Map(validas.map((f) => [f.nombre, legible(f)]));
    const cambios = [] as { campo: string; antes: string; despues: string }[];
    for (const [nombre, v] of viejas) {
      if (!nuevas.has(nombre)) cambios.push({ campo: nombre, antes: v, despues: '(quitada)' });
      else if (nuevas.get(nombre) !== v) cambios.push({ campo: nombre, antes: v, despues: nuevas.get(nombre)! });
    }
    for (const [nombre, v] of nuevas) {
      if (!viejas.has(nombre)) cambios.push({ campo: nombre, antes: '(no estaba)', despues: v });
    }

    await this.db.transaction(async (tx) => {
      await tx.delete(proveedorPercepciones).where(eq(proveedorPercepciones.proveedorId, proveedorId));
      if (validas.length) await tx.insert(proveedorPercepciones).values(validas);
      await this.audit.registrar(cambios.map((c) => ({
        entidad: 'proveedor', entidadId: proveedorId, ambito: 'Percepciones', usuarioId, ...c,
      })), tx);
    });
    return this.percepciones(proveedorId);
  }
}

@Controller('proveedores')
export class ProveedoresController {
  constructor(private readonly svc: ProveedoresService) {}

  @Get() list(@Query('tipo') tipo?: string) { return this.svc.list(tipo); }
  @Get(':id/percepciones') percepciones(@Param('id', ParseIntPipe) id: number) {
    return this.svc.percepciones(id);
  }
  @Get(':id/cuentas') cuentas(@Param('id', ParseIntPipe) id: number) {
    return this.svc.cuentas(id);
  }
  @Permiso('compras.proveedores', 'gastos.proveedores', 'proveedores.padron')
  @Put(':id/cuentas') setCuentas(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.svc.setCuentas(id, body?.cuentas ?? body);
  }
  /*
   * LAS LECTURAS QUEDAN ABIERTAS Y LAS ESCRITURAS PIDEN PERMISO.
   *
   * El padrón lo lee medio sistema —la cajera eligiendo a quién le pagó cuando
   * llegó el camión, Gastos, el filtro del catálogo—, así que cerrar el `GET`
   * habría roto pantallas de tres módulos. Escribir es otra cosa: el CUIT es lo
   * que usa la bandeja para reconocer de quién es una factura, y borrar un
   * proveedor cascadea sus formatos de compra y con ellos el historial de costos.
   *
   * Las dos claves son un OR porque es UN padrón con flags mercadería/gastos:
   * lo administran los dos mundos.
   */
  @Permiso('compras.proveedores', 'gastos.proveedores', 'proveedores.padron')
  @Put(':id/percepciones') setPercepciones(@Param('id', ParseIntPipe) id: number, @Body() body: any, @Auth() sesion: Sesion) {
    return this.svc.setPercepciones(id, body?.percepciones ?? body, sesion?.usuarioId ?? null);
  }
  @Get(':id') get(@Param('id', ParseIntPipe) id: number) { return this.svc.get(id); }
  @Permiso('compras.proveedores', 'gastos.proveedores', 'proveedores.padron')
  @Post() create(@Body() dto: UpsertProveedorDto) { return this.svc.create(dto); }
  @Permiso('compras.proveedores', 'gastos.proveedores', 'proveedores.padron')
  @Patch(':id') update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpsertProveedorDto, @Auth() sesion: Sesion) {
    return this.svc.update(id, dto, sesion?.usuarioId ?? null);
  }
  @Permiso('compras.proveedores', 'gastos.proveedores', 'proveedores.padron')
  @Delete(':id') remove(@Param('id', ParseIntPipe) id: number) { return this.svc.remove(id); }
}

@Module({
  imports: [AuditoriaModule],
  controllers: [ProveedoresController],
  providers: [ProveedoresService],
  exports: [ProveedoresService],
})
export class ProveedoresModule {}
