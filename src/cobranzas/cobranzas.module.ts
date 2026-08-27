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
  Body, Controller, ForbiddenException, Get, Inject, Injectable, Module, BadRequestException,
  NotFoundException, Param, ParseIntPipe, Post, Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString,
  Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import { Auth, Permiso, Sesion } from '../auth/auth.decoradores';
import { esJefe, sucursalDeOperacion } from '../auth/auth.guard';
import { cajaSesiones, cobranzaImputaciones, cobranzaPagos, cobranzas, ventas } from '../db/schema';
import { ClientesModule, ClientesService } from '../clientes/clientes.module';
import { ConfiguracionModule, ConfiguracionService } from '../configuracion/configuracion.module';
import { CajaModule, CajaService } from '../caja/caja.module';
import { VentasModule, VentasService, fechaDeDocumento, money } from '../ventas/ventas.module';
import { resolverOperador } from '../usuarios/usuarios.module';

const MEDIOS = ['efectivo', 'transferencia', 'tarjeta_debito', 'tarjeta_credito', 'cheque', 'qr', 'otro'] as const;

/** Tolerancia de comparación monetaria (medio centavo). */
const EPS = 0.005;

/**
 * TOPE DE UN IMPORTE DE RECIBO. Cien millones es una cifra que este negocio no
 * ve en un recibo, y es exactamente el punto: sin techo, un solo request
 * `{ medio: 'transferencia', importe: 9000000 }` dejaba al cliente con saldo a
 * favor de nueve millones sin que entrara un peso, y a partir de ahí se llevaba
 * mercadería en cuenta corriente para siempre — `validarCredito` compara contra
 * ese saldo. La transferencia inventada recién se descubre conciliando el banco.
 */
const MAX_IMPORTE = 100_000_000;

class PagoDto {
  @IsIn(MEDIOS as unknown as string[]) medio!: (typeof MEDIOS)[number];
  @IsNumber() @Min(0) @Max(MAX_IMPORTE) importe!: number;
  @IsOptional() @IsString() referencia?: string;
}

class ImputacionDto {
  @IsInt() ventaId!: number;
  @IsNumber() @Min(0) @Max(MAX_IMPORTE) importe!: number;
}

class AnularCobranzaDto {
  @IsString() @MaxLength(300) motivo!: string;
}

/**
 * Lo que la sesión habilita. Mismos dos campos que `OpcionesVenta` y por la
 * misma razón: GRABAR en una sucursal y poder TOCAR la de otro son cosas
 * distintas. El jefe hace las dos; el cajero, ninguna fuera de la suya.
 */
export interface OpcionesCobranza {
  soloSuSucursal?: number;
  /** Rol admin/superadmin: puede fechar el recibo y anular contra un turno cerrado. */
  esJefe?: boolean;
}

export class CreateCobranzaDto {
  @IsInt() clienteId!: number;
  /** Pista: para el cajero la sucursal sale de su sesión. Ver `sucursalDeOperacion`. */
  @IsOptional() @IsInt() sucursalId?: number;
  @IsOptional() @IsInt() usuarioId?: number;
  /** El relevo de caja (0088): quién está en la registradora. El interceptor
   *  no lo toca (significa OTRO usuario) y el servidor valida la marca. */
  @IsOptional() @IsInt() operadorId?: number;
  /*
   * `cajaSesionId` NO está acá y no vuelve: lo resuelve el servidor (ver
   * `create`). El campo se aceptaba sin validar nada —turno cerrado, turno de
   * otra sucursal, cualquier id— y encima el único cliente que crea cobranzas
   * nunca lo mandaba, así que TODA cobranza nacía con el turno en null y el
   * arqueo no la veía: el efectivo cobrado a un mayorista entraba al cajón y el
   * cierre daba diferencia 0.
   */
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
    private readonly caja: CajaService,
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

    /*
     * LAS NOTAS DE CRÉDITO TAMBIÉN BAJAN EL SALDO, y tienen que entrar en el
     * MISMO candado: si no, se le podría cobrar al cliente una factura que ya
     * se le acreditó entera. Se leen después del `for update` de las ventas, y
     * como una nota nueva se inserta apuntando a una fila que esta transacción
     * tiene bloqueada, no se puede colar una en el medio.
     */
    const notas = await tx
      .select({
        refVentaId: ventas.refVentaId,
        importe: sql<number>`coalesce(sum(${ventas.total}), 0)`,
      })
      .from(ventas)
      .where(and(inArray(ventas.refVentaId, ventaIds), ne(ventas.estado, 'anulada')))
      .groupBy(ventas.refVentaId);

    const cobrado = new Map<number, number>(imput.map((i: any) => [i.ventaId, Number(i.importe) || 0]));
    const acreditado = new Map<number, number>(notas.map((n: any) => [n.refVentaId, Number(n.importe) || 0]));
    return new Map<number, { doc: any; saldo: number }>(
      docs.map((d: any) => [
        d.id,
        { doc: d, saldo: money(d.total - (cobrado.get(d.id) ?? 0) - (acreditado.get(d.id) ?? 0)) },
      ]),
    );
  }

  /**
   * `sucursalId` ya viene resuelto contra la sesión por el controller, y el TURNO
   * lo resuelve este método: la plata de un recibo entra por una caja concreta o
   * por administración, y eso no lo puede decidir el que manda el request.
   */
  async create(dto: CreateCobranzaDto, sucursalId: number, opciones: OpcionesCobranza = {}) {
    const esJefeSesion = !!opciones.esJefe;
    const cliente = await this.cli.get(dto.clienteId);
    const config = await this.cfg.get('ventas');
    // El relevo (0088): el recibo lo firma quien está parado en la caja.
    const autor = await resolverOperador(this.db, dto.operadorId, dto.usuarioId);

    const pagos = (dto.pagos ?? []).filter((p) => Number(p.importe) > 0);
    if (!pagos.length) throw new BadRequestException('Cargá al menos un medio de pago con importe.');
    const total = money(pagos.reduce((a, p) => a + Number(p.importe), 0));
    if (total <= 0) throw new BadRequestException('El total de la cobranza debe ser mayor a 0.');

    /*
     * EL TURNO DE CAJA, resuelto acá y no aceptado del cliente.
     *
     * Con efectivo el turno es obligatorio si la configuración lo pide: esa
     * plata va a estar físicamente en el cajón, y una cobranza en efectivo que
     * no cuelga de ningún turno es plata que el arqueo no espera — el cierre da
     * diferencia 0 y el faltante no existe para el sistema.
     *
     * Sin efectivo (transferencia, tarjeta) igual se cuelga del turno abierto si
     * hay: así el arqueo lo muestra en el desglose por medio, que es lo que se
     * concilia después contra el resumen del banco. Si no hay turno abierto,
     * queda en administración (`null`), que es el caso real de la transferencia
     * que entra un sábado.
     */
    const hayEfectivo = pagos.some((p) => p.medio === 'efectivo');
    const turno = await this.caja.actual(sucursalId);
    if (hayEfectivo && !!config.cajaObligatoria && !turno) {
      throw new BadRequestException(
        'No hay un turno de caja abierto en esta sucursal, y el efectivo de un recibo tiene que entrar a una caja. Abrí la caja y volvé a cobrar.',
      );
    }

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
    /*
     * La misma regla que la venta, que acá faltaba: un cajero fechaba el recibo
     * en noviembre y la plata entraba igual al turno de HOY (el turno lo resuelve
     * el servidor por sucursal). El recibo quedaba fuera de cualquier corte del
     * mes y adentro del arqueo de hoy — la conciliación no cerraba nunca. Y
     * `new Date('chau')` llegaba como `Invalid Date` al insert: 500 en vez de 400.
     */
    const fecha = fechaDeDocumento(dto.fecha, esJefeSesion);

    const id = await this.db.transaction(async (tx) => {
      /*
       * EL TURNO, RELEÍDO CON CANDADO (25/8). `caja.actual()` se consultó fuera
       * de la transacción, y entre esa lectura y el insert cabía el cierre de
       * caja: el recibo entraba a un turno cuyo arqueo ya estaba calculado — la
       * misma carrera que se cerró en la venta. FOR UPDATE espera a un cierre
       * en curso; si al soltar el candado el turno ya no está abierto, con
       * efectivo obligatorio se rechaza, y sin esa exigencia el recibo cae a
       * administración (null), igual que si nunca hubiera habido turno.
       */
      let turnoIdEnTx: number | null = null;
      if (turno) {
        const [t] = await tx.select().from(cajaSesiones)
          .where(eq(cajaSesiones.id, turno.id)).limit(1).for('update');
        if (t && t.estado === 'abierta') {
          turnoIdEnTx = t.id;
        } else if (hayEfectivo && !!config.cajaObligatoria) {
          throw new BadRequestException(
            'El turno de caja se cerró mientras se cargaba este recibo. Abrí la caja y volvé a cobrar.',
          );
        }
      }

      if (imputaciones.length) {
        const saldos = await this.saldosEnTx(tx, imputaciones.map((i) => i.ventaId));
        for (const i of imputaciones) {
          const entry = saldos.get(i.ventaId);
          if (!entry) throw new BadRequestException('Uno de los comprobantes no existe.');
          const { doc, saldo } = entry;
          if (doc.clienteId !== cliente.id) throw new BadRequestException('Un comprobante no pertenece a este cliente.');
          if (doc.estado !== 'confirmada') throw new BadRequestException('Solo se imputa a comprobantes confirmados.');
          /* A UNA NOTA DE CRÉDITO NO SE LE COBRA NADA: es plata que la casa
           * devolvió. `cuenta()` ya no la ofrece, pero una imputación mandada
           * a mano llegaría acá — y su "saldo" (total menos nada) daría
           * positivo, o sea: cobrarle al cliente su propia devolución. */
          if (String(doc.tipo ?? '').startsWith('nota_credito')) {
            throw new BadRequestException(
              'No se le imputa una cobranza a una nota de crédito: la nota ya descuenta de la cuenta del cliente.',
            );
          }
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
        sucursalId,
        usuarioId: autor,
        cajaSesionId: turnoIdEnTx,
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

  /**
   * ANULAR UN RECIBO ES LA MISMA MANIOBRA QUE ANULAR UNA VENTA, y hasta acá era
   * la puerta de al lado sin llave: `set({ estado: 'anulada' })` y nada más.
   *
   * El arqueo suma solo las cobranzas `confirmada` (ver `caja.arqueo`), así que
   * anular le saca esa plata al efectivo esperado del cajón: se cobran $80.000
   * a un mayorista a la mañana y a las 19:50 se anula el recibo — el esperado
   * baja $80.000, el cierre da diferencia 0 y el faltante no existe para el
   * sistema. De yapa, el saldo del cliente vuelve a subir como si nunca hubiera
   * pagado. No pedía permiso propio, no pedía motivo y no guardaba quién.
   *
   * Ahora es el espejo de `ventas.anular`: permiso `devoluciones`, motivo
   * obligatorio, rastro (0060), la sucursal de la sesión y —lo que de verdad lo
   * cierra— **no se puede anular contra un turno ya cerrado**, cuyo arqueo está
   * firmado. Eso se corrige con otro recibo, no reescribiendo el pasado.
   */
  async anular(id: number, motivo: string, usuarioId?: number, opciones: OpcionesCobranza = {}) {
    const c = await this.get(id);
    if (c.estado === 'anulada') throw new BadRequestException('La cobranza ya está anulada.');
    if (opciones.soloSuSucursal && c.sucursalId !== opciones.soloSuSucursal) {
      throw new ForbiddenException('Ese recibo es de otra sucursal.');
    }
    const razon = (motivo ?? '').trim();
    if (!razon) throw new BadRequestException('Indicá por qué se anula el recibo.');

    /*
     * CANDADO Y RELECTURA (25/8), como en `ventas.anular`: el chequeo de arriba
     * es de cortesía — acá adentro se retoma la cobranza FOR UPDATE (dos
     * anulaciones a la vez: gana una) y el turno FOR UPDATE (un cierre en
     * curso espera o esta anulación se rechaza porque el arqueo ya se firmó).
     */
    await this.db.transaction(async (tx) => {
      const [fresca] = await tx.select().from(cobranzas)
        .where(eq(cobranzas.id, id)).limit(1).for('update');
      if (!fresca || fresca.estado === 'anulada') {
        throw new BadRequestException('La cobranza ya está anulada.');
      }
      if (fresca.cajaSesionId) {
        const [turno] = await tx.select().from(cajaSesiones)
          .where(eq(cajaSesiones.id, fresca.cajaSesionId)).limit(1).for('update');
        if (turno && turno.estado === 'cerrada' && !opciones.esJefe) {
          throw new BadRequestException(
            'El turno de caja de ese recibo ya está cerrado: su arqueo quedó firmado. '
            + 'Corregilo con un recibo nuevo en vez de anularlo.',
          );
        }
      }
      await tx.update(cobranzas).set({
        estado: 'anulada',
        anuladoPor: usuarioId ?? null,
        anuladoEn: new Date(),
        anuladoMotivo: razon,
      }).where(eq(cobranzas.id, id));
    });
    return this.get(id);
  }
}

@Controller('cobranzas')
@Permiso('ventas.cobranzas')
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

  /** Lo que la sesión habilita, en un solo lugar (igual que en Ventas). */
  private opciones(sesion: Sesion): OpcionesCobranza {
    const jefe = esJefe(sesion);
    return { esJefe: jefe, soloSuSucursal: jefe ? undefined : sesion.sucursalId };
  }

  @Post()
  create(@Body() dto: CreateCobranzaDto, @Auth() sesion: Sesion) {
    const sucursalId = sucursalDeOperacion(sesion, dto.sucursalId);
    if (!sucursalId) throw new BadRequestException('Tu sesión no tiene sucursal: volvé a entrar eligiéndola.');
    return this.svc.create(dto, sucursalId, this.opciones(sesion));
  }

  /*
   * `devoluciones` SOLO, sin `ventas.cobranzas`: el permiso del método reemplaza
   * al de la clase, y las claves de un mismo `@Permiso` se evalúan con O — poner
   * las dos haría que alcanzara con ver la pantalla. Es la misma llave con la
   * que se anula una venta, porque es la misma maniobra sobre la misma plata.
   */
  @Post(':id/anular')
  @Permiso('devoluciones')
  anular(@Param('id', ParseIntPipe) id: number, @Body() dto: AnularCobranzaDto, @Auth() sesion: Sesion) {
    return this.svc.anular(id, dto.motivo, sesion.usuarioId, this.opciones(sesion));
  }
}

@Module({
  imports: [ClientesModule, ConfiguracionModule, CajaModule, VentasModule],
  controllers: [CobranzasController],
  providers: [CobranzasService],
  exports: [CobranzasService],
})
export class CobranzasModule {}
