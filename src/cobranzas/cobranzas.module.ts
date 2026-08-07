/**
 * COBRANZAS (recibos)
 * ============================================================================
 * Gemelo de la orden de pago a proveedores: N medios de pago que entran + N
 * imputaciones a comprobantes de venta que salen.
 *
 * Reglas que sostienen el saldo del cliente:
 *  - Lo cobrado y NO imputado queda `aCuenta`: igual baja el saldo global, y
 *    queda disponible para imputarse a una venta futura.
 *  - Nunca se puede imputar a un documento más de lo que ese documento debe.
 *    El saldo se recalcula DENTRO de la transacción, no antes: si dos cajas
 *    cobran la misma factura a la vez, la segunda falla en vez de duplicar.
 *  - Anular no borra: cambia el estado, y todas las lecturas de saldo filtran
 *    por `confirmada`. El recibo anulado queda como rastro.
 */
import {
  Body, Controller, Get, Inject, Injectable, Module, BadRequestException,
  NotFoundException, Param, ParseIntPipe, Post, Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, ValidateNested,
} from 'class-validator';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import { cobranzaImputaciones, cobranzaPagos, cobranzas, ventas } from '../db/schema';
import { ClientesModule, ClientesService } from '../clientes/clientes.module';
import { ConfiguracionModule, ConfiguracionService } from '../configuracion/configuracion.module';
import { VentasModule, VentasService, money } from '../ventas/ventas.module';

const MEDIOS = ['efectivo', 'transferencia', 'tarjeta_debito', 'tarjeta_credito', 'cheque', 'qr', 'otro'] as const;

/** Tolerancia de comparación monetaria (medio centavo). */
const EPS = 0.005;

class PagoDto {
  @IsIn(MEDIOS as unknown as string[]) medio!: (typeof MEDIOS)[number];
  @IsNumber() importe!: number;
  @IsOptional() @IsString() referencia?: string;
}

class ImputacionDto {
  @IsInt() ventaId!: number;
  @IsNumber() importe!: number;
}

export class CreateCobranzaDto {
  @IsInt() clienteId!: number;
  @IsOptional() @IsInt() sucursalId?: number;
  @IsOptional() @IsInt() usuarioId?: number;
  /** Si la cobranza entra por caja, se imputa al turno para el arqueo. */
  @IsOptional() @IsInt() cajaSesionId?: number;
  @IsOptional() @IsString() fecha?: string;
  @IsOptional() @IsString() observaciones?: string;
  @IsArray() @ArrayNotEmpty() @ValidateNested({ each: true }) @Type(() => PagoDto)
  pagos!: PagoDto[];
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ImputacionDto)
  imputaciones?: ImputacionDto[];
  /** Reparte el total sobre los comprobantes más viejos primero. */
  @IsOptional() @IsBoolean() auto?: boolean;
}

@Injectable()
export class CobranzasService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly cli: ClientesService,
    private readonly cfg: ConfiguracionService,
    private readonly vtas: VentasService,
  ) {}

  /* ------------------------------ Lectura ------------------------------ */

  async list(q: { clienteId?: number; estado?: string; limit?: number }) {
    const conds: any[] = [];
    if (q.clienteId) conds.push(eq(cobranzas.clienteId, Number(q.clienteId)));
    if (q.estado) conds.push(eq(cobranzas.estado, q.estado as any));

    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500);
    const rows = await this.db.select().from(cobranzas)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(cobranzas.id))
      .limit(limit);
    if (!rows.length) return [];

    // Los medios de pago se traen en UNA consulta para todo el listado.
    const ids = rows.map((c) => c.id);
    const pagos = await this.db.select().from(cobranzaPagos).where(inArray(cobranzaPagos.cobranzaId, ids));
    return rows.map((c) => ({ ...c, pagos: pagos.filter((p) => p.cobranzaId === c.id) }));
  }

  async get(id: number) {
    const [c] = await this.db.select().from(cobranzas).where(eq(cobranzas.id, id)).limit(1);
    if (!c) throw new NotFoundException('Cobranza inexistente.');
    const [pagos, imputaciones] = await Promise.all([
      this.db.select().from(cobranzaPagos).where(eq(cobranzaPagos.cobranzaId, id)),
      this.db
        .select({
          id: cobranzaImputaciones.id,
          ventaId: cobranzaImputaciones.ventaId,
          importe: cobranzaImputaciones.importe,
          tipo: ventas.tipo,
          puntoVenta: ventas.puntoVenta,
          numero: ventas.numero,
          fecha: ventas.fecha,
          total: ventas.total,
        })
        .from(cobranzaImputaciones)
        .innerJoin(ventas, eq(ventas.id, cobranzaImputaciones.ventaId))
        .where(eq(cobranzaImputaciones.cobranzaId, id)),
    ]);
    return { ...c, pagos, imputaciones };
  }

  /* ------------------------------ Escritura ------------------------------ */

  private async siguienteNumero(tx: any, puntoVenta: string) {
    const [r] = await tx
      .select({ max: sql<number>`coalesce(max(${cobranzas.numero}), 0)` })
      .from(cobranzas)
      .where(eq(cobranzas.puntoVenta, puntoVenta));
    return (Number(r?.max) || 0) + 1;
  }

  /** Saldo real de cada venta, leído dentro de la transacción. */
  private async saldosEnTx(tx: any, ventaIds: number[]) {
    /*
     * CON CANDADO, y es lo que hace confiable a la validación de más abajo.
     *
     * Postgres en READ COMMITTED no hace esperar a un `select` pelado: lee la
     * última versión confirmada. Dos cobranzas simultáneas sobre la misma venta
     * leían las dos el mismo saldo, las dos pasaban el "debe $X y estás imputando
     * $Y", y las dos entraban — la venta terminaba cobrada de más. Es la misma
     * carrera que tenía Pagos (ver Decisiones de diseño en /info).
     *
     * El agregado de imputaciones no se puede bloquear (es una suma), pero al
     * bloquear la fila de la VENTA se serializa cualquier par de transacciones
     * que toquen esa venta, y con eso la suma que se lee ya es estable.
     *
     * Si dos cobranzas toman las mismas dos ventas en orden distinto, Postgres
     * detecta el abrazo y aborta una con error — ruidoso, no silencioso, que es
     * lo que se quiere.
     */
    const docs = await tx.select().from(ventas).where(inArray(ventas.id, ventaIds)).for('update');
    const imput = await tx
      .select({
        ventaId: cobranzaImputaciones.ventaId,
        importe: sql<number>`coalesce(sum(${cobranzaImputaciones.importe}), 0)`,
      })
      .from(cobranzaImputaciones)
      .innerJoin(cobranzas, eq(cobranzas.id, cobranzaImputaciones.cobranzaId))
      .where(and(eq(cobranzas.estado, 'confirmada'), inArray(cobranzaImputaciones.ventaId, ventaIds)))
      .groupBy(cobranzaImputaciones.ventaId);

    const cobrado = new Map<number, number>(imput.map((i: any) => [i.ventaId, Number(i.importe) || 0]));
    return new Map<number, { doc: any; saldo: number }>(
      docs.map((d: any) => [d.id, { doc: d, saldo: money(d.total - (cobrado.get(d.id) ?? 0)) }]),
    );
  }

  async create(dto: CreateCobranzaDto) {
    const cliente = await this.cli.get(dto.clienteId);
    const config = await this.cfg.get('ventas');

    const pagos = (dto.pagos ?? []).filter((p) => Number(p.importe) > 0);
    if (!pagos.length) throw new BadRequestException('Cargá al menos un medio de pago con importe.');
    const total = money(pagos.reduce((a, p) => a + Number(p.importe), 0));
    if (total <= 0) throw new BadRequestException('El total de la cobranza debe ser mayor a 0.');

    /* -- Qué se imputa: lo que mandó el cliente, o FIFO sobre lo más viejo -- */
    let imputaciones = (dto.imputaciones ?? [])
      .map((i) => ({ ventaId: Number(i.ventaId), importe: money(i.importe) }))
      .filter((i) => i.importe > 0);

    if (!imputaciones.length && dto.auto) {
      const { comprobantes } = await this.vtas.cuenta(cliente.id);
      let resto = total;
      for (const c of comprobantes) {
        if (resto <= EPS) break;
        const aplica = money(Math.min(resto, c.saldo));
        if (aplica > 0) { imputaciones.push({ ventaId: c.id, importe: aplica }); resto = money(resto - aplica); }
      }
    }

    // Dos renglones sobre la misma venta se colapsan en uno.
    if (imputaciones.length) {
      const agrupado = new Map<number, number>();
      for (const i of imputaciones) agrupado.set(i.ventaId, money((agrupado.get(i.ventaId) ?? 0) + i.importe));
      imputaciones = [...agrupado].map(([ventaId, importe]) => ({ ventaId, importe }));
    }

    const imputado = money(imputaciones.reduce((a, i) => a + i.importe, 0));
    if (imputado > total + EPS) {
      throw new BadRequestException(`Estás imputando $${imputado.toFixed(2)} y la cobranza es de $${total.toFixed(2)}.`);
    }
    const aCuenta = money(total - imputado);

    const puntoVenta = String(config.puntoVenta || '0001');
    const fecha = dto.fecha ? new Date(dto.fecha) : new Date();

    const id = await this.db.transaction(async (tx) => {
      if (imputaciones.length) {
        const saldos = await this.saldosEnTx(tx, imputaciones.map((i) => i.ventaId));
        for (const i of imputaciones) {
          const entry = saldos.get(i.ventaId);
          if (!entry) throw new BadRequestException('Uno de los comprobantes no existe.');
          const { doc, saldo } = entry;
          if (doc.clienteId !== cliente.id) throw new BadRequestException('Un comprobante no pertenece a este cliente.');
          if (doc.estado !== 'confirmada') throw new BadRequestException('Solo se imputa a comprobantes confirmados.');
          if (i.importe > saldo + EPS) {
            throw new BadRequestException(
              `El comprobante ${doc.puntoVenta}-${String(doc.numero).padStart(8, '0')} debe $${saldo.toFixed(2)} y estás imputando $${i.importe.toFixed(2)}.`,
            );
          }
        }
      }

      const numero = await this.siguienteNumero(tx, puntoVenta);
      const [c] = await tx.insert(cobranzas).values({
        puntoVenta, numero, fecha, clienteId: cliente.id,
        sucursalId: dto.sucursalId ?? cliente.sucursalId ?? null,
        usuarioId: dto.usuarioId ?? null,
        cajaSesionId: dto.cajaSesionId ?? null,
        total, aCuenta, estado: 'confirmada', observaciones: dto.observaciones ?? '',
      }).returning();

      await tx.insert(cobranzaPagos).values(pagos.map((p) => ({
        cobranzaId: c.id, medio: p.medio, importe: money(p.importe), referencia: p.referencia ?? '',
      })));

      if (imputaciones.length) {
        await tx.insert(cobranzaImputaciones).values(imputaciones.map((i) => ({
          cobranzaId: c.id, ventaId: i.ventaId, importe: i.importe,
        })));
      }
      return c.id;
    });

    return this.get(id);
  }

  async anular(id: number) {
    const c = await this.get(id);
    if (c.estado === 'anulada') throw new BadRequestException('La cobranza ya está anulada.');
    await this.db.update(cobranzas).set({ estado: 'anulada' }).where(eq(cobranzas.id, id));
    return this.get(id);
  }
}

@Controller('cobranzas')
export class CobranzasController {
  constructor(private readonly svc: CobranzasService) {}

  @Get()
  list(@Query('clienteId') clienteId?: string, @Query('estado') estado?: string, @Query('limit') limit?: string) {
    return this.svc.list({
      clienteId: clienteId ? Number(clienteId) : undefined,
      estado, limit: limit ? Number(limit) : undefined,
    });
  }

  @Get(':id') get(@Param('id', ParseIntPipe) id: number) { return this.svc.get(id); }
  @Post() create(@Body() dto: CreateCobranzaDto) { return this.svc.create(dto); }
  @Post(':id/anular') anular(@Param('id', ParseIntPipe) id: number) { return this.svc.anular(id); }
}

@Module({
  imports: [ClientesModule, ConfiguracionModule, VentasModule],
  controllers: [CobranzasController],
  providers: [CobranzasService],
  exports: [CobranzasService],
})
export class CobranzasModule {}
