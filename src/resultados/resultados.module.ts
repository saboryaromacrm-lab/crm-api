/**
 * GERENCIA › RESULTADOS — el estado de resultados (0152, 9/10/2026)
 * ============================================================================
 * Pedido del dueño: «la sección Resultados completa, como un experto en
 * administración de empresas». Decisiones suyas (no re-preguntar):
 *
 *   · TODO EN NETO. El IVA va aparte, como un resultado propio, con dos
 *     vistas: «declarado» (débito − crédito − percepciones, con el saldo a
 *     favor arrastrado, igual que Métricas › Resultados IVA) y «de gestión»
 *     (el IVA de lo vendido sin factura, que queda en la casa).
 *   · DEVENGADO: cada gasto en el mes al que corresponde; el aguinaldo, 1/12
 *     por mes.
 *   · Gastos variables por %: Ingresos Brutos y tasa municipal (distinta por
 *     local) sobre lo facturado sin IVA; comisión del posnet 4 % (el IVA de la
 *     comisión se recupera). Cada tasa con «vigente desde». El pago real, si
 *     se carga, reemplaza al estimado; las percepciones de IIBB son pago a cuenta.
 *   · Sueldos por empleado; gastos sin local repartidos por ventas, o no, según
 *     el rubro; amortizaciones opcionales.
 *   · Retiros sin costo = retiro de socios (abajo, aparte). Coffit afuera.
 *   · Ganancias: persona humana (escala del artículo 94, por lo acumulado).
 *   · Objetivos por mes, celular y exportar.
 *
 * SOLO EL SUPERADMIN (`gerencia.resultados`, fuera del catálogo). La lectura
 * va por el pool propio de Métricas: la caja nunca espera a este reporte.
 */
import {
  BadRequestException, Body, Controller, Delete, Get, Inject, Injectable, Module, NotFoundException,
  Param, ParseIntPipe, Patch, Post, Put, Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min,
  ValidateNested,
} from 'class-validator';
import { and, eq, sql } from 'drizzle-orm';
import { Auth, Permiso, type Sesion } from '../auth/auth.decoradores';
import { hoyAr } from '../cafeteria/cuenta';
import { DRIZZLE, Database } from '../db/drizzle';
import {
  auditoria, bienesUso, empleadoSueldos, empleados, gananciasEscalas, gastoCategorias, resultadosConfig,
  resultadosObjetivos, resultadosTasas, sucursales,
} from '../db/schema';
import { reporteIva } from '../metricas/iva';
import { MetricasModule, MetricasService } from '../metricas/metricas.module';
import { leerCatalogos, leerHechos, leerObjetivos } from './datos';
import { ADMINISTRACION, SIN_LOCAL, armarEstado } from './estado';
import { PERMISO_RESULTADOS } from './permiso';
import { MES_RE, diasDelMes, mesesEntre, r2, sumarMeses, totalDeducciones } from './reglas';

/** El período más largo que se deja pedir (Ganancias suma desde enero del primer año). */
const MAX_MESES = 36;
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
const PAPELES = ['normal', 'sueldos', 'iibb', 'municipalidad', 'comisiones', 'financiero', 'ganancias', 'fuera'] as const;
const NOMBRE_PAPEL: Record<string, string> = {
  normal: 'Gasto del negocio', sueldos: 'Sueldos (cede ante la planilla)', iibb: 'Pago de Ingresos Brutos',
  municipalidad: 'Pago de la tasa municipal', comisiones: 'Comisiones del posnet', financiero: 'Financiero',
  ganancias: 'Impuesto a las Ganancias (no entra)', fuera: 'No es gasto del resultado',
};
const pesos = (n: number) => `$${(Number(n) || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (n: number) => `${(Number(n) || 0).toLocaleString('es-AR', { maximumFractionDigits: 3 })} %`;

/* --------------------------------- DTOs --------------------------------- */

class TasaDto {
  @IsIn(['iibb', 'municipalidad', 'tarjeta']) concepto!: 'iibb' | 'municipalidad' | 'tarjeta';
  @IsOptional() @IsInt() sucursalId?: number | null;
  @IsOptional() @IsIn(['tarjeta_debito', 'tarjeta_credito']) medio?: string | null;
  @IsNumber() @Min(0) @Max(30) porcentaje!: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1e10) minimo?: number;
  @Matches(MES_RE, { message: '«Vigente desde» va como AAAA-MM.' }) desde!: string;
}

class RubroDto {
  @IsOptional() @IsIn(PAPELES as unknown as string[]) resultado?: string;
  @IsOptional() @IsBoolean() reparte?: boolean;
  @IsOptional() @IsIn(['fijo', 'variable']) tipo?: 'fijo' | 'variable';
}

class ConfigDto {
  @IsOptional() @IsBoolean() amortizaciones?: boolean;
  @IsOptional() @IsIn(['facturado', 'todo']) gananciasBase?: 'facturado' | 'todo';
}

class TramoDto {
  @IsNumber() @Min(0) @Max(1e13) desde!: number;
  @IsNumber() @Min(0) @Max(1e13) fijo!: number;
  @IsNumber() @Min(0) @Max(100) pct!: number;
}
class DeduccionesDto {
  @IsNumber() @Min(0) @Max(1e12) gni!: number;
  @IsNumber() @Min(0) @Max(1e12) especial!: number;
  @IsNumber() @Min(0) @Max(1e12) cargasFamilia!: number;
  @IsNumber() @Min(0) @Max(1e12) otras!: number;
}
class EscalaDto {
  @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => TramoDto) tramos!: TramoDto[];
  @ValidateNested() @Type(() => DeduccionesDto) deducciones!: DeduccionesDto;
}

class ObjetivoMesDto {
  @Matches(MES_RE) mes!: string;
  @IsOptional() @IsNumber() @Min(-1e13) @Max(1e13) ventaNeta?: number | null;
  @IsOptional() @IsNumber() @Min(-1e13) @Max(1e13) resultado?: number | null;
}
class ObjetivosDto {
  @IsOptional() @IsInt() sucursalId?: number | null;
  @IsArray() @ArrayMaxSize(24) @ValidateNested({ each: true }) @Type(() => ObjetivoMesDto) meses!: ObjetivoMesDto[];
}

class EmpleadoDto {
  @IsOptional() @IsString() @MaxLength(120) nombre?: string;
  @IsOptional() @IsString() @MaxLength(20) cuil?: string;
  @IsOptional() @IsInt() sucursalId?: number | null;
  @IsOptional() @Matches(FECHA_RE, { message: 'El alta va como AAAA-MM-DD.' }) alta?: string;
  @IsOptional() @Matches(FECHA_RE, { message: 'La baja va como AAAA-MM-DD.' }) baja?: string | null;
  @IsOptional() @IsString() @MaxLength(300) observaciones?: string;
  /* Al dar de alta: su primer sueldo (desde el mes del alta). */
  @IsOptional() @IsNumber() @Min(0) @Max(1e10) bruto?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) cargas?: number;
}

class SueldoDto {
  @Matches(MES_RE, { message: '«Vigente desde» va como AAAA-MM.' }) desde!: string;
  @IsNumber() @Min(0) @Max(1e10) bruto!: number;
  @IsNumber() @Min(0) @Max(100) cargas!: number;
}

class BienDto {
  @IsOptional() @IsString() @MaxLength(120) nombre?: string;
  @IsOptional() @IsInt() sucursalId?: number | null;
  @IsOptional() @IsNumber() @Min(0.01) @Max(1e12) valor?: number;
  @IsOptional() @Matches(MES_RE, { message: 'El mes de alta va como AAAA-MM.' }) alta?: string;
  @IsOptional() @IsInt() @Min(1) @Max(600) vidaMeses?: number;
  @IsOptional() @Matches(FECHA_RE, { message: 'La baja va como AAAA-MM-DD.' }) baja?: string | null;
  @IsOptional() @IsString() @MaxLength(300) observaciones?: string;
}

/* -------------------------------- servicio -------------------------------- */

@Injectable()
export class ResultadosService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly metricas: MetricasService,
  ) {}

  private async auditar(s: Sesion, entidad: string, entidadId: number, ambito: string, detalle: string, cambios: [string, string, string][]) {
    if (!cambios.length) return;
    await this.db.insert(auditoria).values(cambios.map(([campo, antes, despues]) => ({
      usuarioId: s.usuarioId, entidad, entidadId, ambito, detalle, campo, antes, despues,
    })));
  }

  private async sucursalValida(id: number | null | undefined) {
    if (id == null) return null;
    const [x] = await this.db.select({ id: sucursales.id }).from(sucursales).where(eq(sucursales.id, id)).limit(1);
    if (!x) throw new BadRequestException('Sucursal inválida.');
    return x.id;
  }

  /* ============================ el reporte ============================ */

  async estado(q: { desde?: string; hasta?: string; foco?: string }) {
    const hoy = hoyAr();
    const mesHoy = hoy.slice(0, 7);
    const hasta = q.hasta && MES_RE.test(q.hasta) ? q.hasta : mesHoy;
    const desde = q.desde && MES_RE.test(q.desde) ? q.desde : hasta;
    if (hasta < desde) throw new BadRequestException('«Hasta» es anterior a «desde».');
    if (hasta > mesHoy) throw new BadRequestException('Todavía no hay resultados de meses que no empezaron.');
    const pedidos = mesesEntre(desde, hasta);
    /* Los avisos hablan de lo que se mira: desde `foco` (lo anterior se pide solo para comparar). */
    const foco = q.foco && MES_RE.test(q.foco) && q.foco >= desde && q.foco <= hasta ? q.foco : desde;
    if (pedidos.length > MAX_MESES) throw new BadRequestException(`El período puede ser de hasta ${MAX_MESES} meses.`);
    /* Ganancias se calcula por lo acumulado del año: hace falta desde enero. */
    const calculo = mesesEntre(`${desde.slice(0, 4)}-01`, hasta);
    const inicio = `${calculo[0]}-01`;
    const finEx = `${sumarMeses(hasta, 1)}-01`;
    const ultimoDia = hasta === mesHoy ? hoy : `${hasta}-${String(diasDelMes(hasta)).padStart(2, '0')}`;

    return this.metricas.leer(async (c) => {
      const empresa = await c.query(`select valor from configuracion where clave = 'empresa'`);
      const v: any = empresa.rows[0]?.valor ?? {};
      const [hechos, cat, objetivos, iva] = await Promise.all([
        leerHechos(c, inicio, finEx),
        leerCatalogos(c, Number(desde.slice(0, 4))),
        leerObjetivos(c, `${desde}-01`, finEx),
        reporteIva(c, { desde: `${desde}-01`, hasta: ultimoDia, sucursalId: null },
          { importe: Number(v.ivaSaldoInicial) || 0, mes: String(v.ivaSaldoMes ?? '') }),
      ]);
      const { meses, avisosGanancias } = armarEstado(hechos, cat, calculo, new Set(pedidos), foco);
      const ivaDe = new Map(iva.meses.map((m: any) => [m.mes, m]));
      const conIva = meses.map((m) => {
        const i: any = ivaDe.get(m.mes) ?? {};
        return {
          ...m,
          iva: {
            debito: r2(i.debito ?? 0), credito: r2(i.credito ?? 0), percepciones: r2(i.percepciones ?? 0),
            posicion: r2((i.debito ?? 0) - (i.credito ?? 0) - (i.percepciones ?? 0)),
            saldoAnterior: r2(i.saldoAnterior ?? 0), aPagar: r2(i.aPagar ?? 0), saldoAFavor: r2(i.saldoAFavor ?? 0),
            sinFactura: r2(m.total.hechos.ivaSinFactura),
          },
        };
      });
      return {
        desde, hasta, mesEnCurso: hasta === mesHoy ? mesHoy : null, generado: new Date().toISOString(),
        sucursales: cat.sucursales,
        baldes: { sinLocal: SIN_LOCAL, administracion: ADMINISTRACION },
        rubros: cat.rubros,
        config: cat.config,
        planilla: { empleados: cat.empleados.length, bienes: cat.bienes.length },
        meses: conIva,
        objetivos,
        avisos: this.avisos(conIva.filter((m) => m.mes >= foco), cat, avisosGanancias, hasta === mesHoy),
      };
    });
  }

  /** Lo que el dueño tiene que saber para leer bien el número (sin repetir: por período). */
  private avisos(meses: any[], cat: any, avisosGanancias: string[], enCurso: boolean) {
    const out: { tono: 'warn' | 'info'; texto: string }[] = [];
    const nombreSuc = (id: number) => cat.sucursales.find((s: any) => s.id === id)?.nombre ?? `#${id}`;
    const nombreRubro = (id: string) => cat.rubros.find((r: any) => String(r.id) === id)?.nombre ?? `#${id}`;
    const suma = (f: (m: any) => number) => meses.reduce((a, m) => a + f(m), 0);
    if (enCurso) out.push({ tono: 'info', texto: 'El último mes está en curso: los números son hasta hoy.' });
    const sinCosto = suma((m) => m.total.hechos.sinCosto);
    if (sinCosto > 0) {
      out.push({ tono: 'warn', texto: `${sinCosto} renglón(es) vendidos sin costo cargado (${pesos(suma((m) => m.total.hechos.ventaSinCosto))} de venta): su costo no está en el costo de la mercadería vendida y el margen sale de más.` });
    }
    if (!cat.empleados.length) {
      out.push({ tono: 'warn', texto: meses.some((m) => m.origen.sueldos === 'gastos')
        ? 'No hay empleados cargados: los sueldos salen de lo cargado en el rubro Sueldos de Gastos (sin aguinaldo proporcional). Cargalos en Gastos › Gastos fijos y sueldos › Sueldos.'
        : 'No hay sueldos: ni empleados cargados ni gastos en el rubro Sueldos. El resultado sale mejor de lo que es. Cargalos en Gastos › Gastos fijos y sueldos › Sueldos.' });
    }
    const ignorados = suma((m) => m.info.sueldosIgnorados);
    if (ignorados > 0.009) out.push({ tono: 'info', texto: `${pesos(ignorados)} cargados en el rubro Sueldos de Gastos no se suman: manda la planilla de empleados (son los pagos; sumarlos sería contar dos veces).` });
    const sinSueldo = [...new Set(meses.flatMap((m) => m.info.empleadosSinSueldo))];
    if (sinSueldo.length) out.push({ tono: 'warn', texto: `Sin sueldo cargado para el período: ${sinSueldo.join(', ')}. Cuentan $0.` });
    const sinTasa = [...new Set(meses.flatMap((m) => m.info.sinTasaMunicipal))];
    if (sinTasa.length) out.push({ tono: 'warn', texto: `Sin tasa municipal cargada: ${sinTasa.map(nombreSuc).join(', ')}. Cargala en Configuración.` });
    const mpSinDato = suma((m) => m.info.mpSinDato);
    if (mpSinDato > 0) out.push({ tono: 'info', texto: `${mpSinDato} cobro(s) con QR de Mercado Pago sin el dato de su comisión: cuentan $0 de comisión.` });
    const excl: Record<string, number> = {};
    for (const m of meses) for (const [k, v] of Object.entries(m.info.excluidos as Record<string, number>)) excl[k] = (excl[k] ?? 0) + v;
    const ex = Object.entries(excl).filter(([, v]) => Math.abs(v) > 0.009);
    if (ex.length) out.push({ tono: 'info', texto: `No entran (por cómo está marcado su rubro): ${ex.map(([k, v]) => `${nombreRubro(k)} ${pesos(v)}`).join(' · ')}.` });
    for (const t of avisosGanancias) out.push({ tono: 'warn', texto: t });
    if (cat.config.amortizaciones && !cat.bienes.length) out.push({ tono: 'info', texto: 'Las amortizaciones están encendidas pero no hay bienes de uso cargados.' });
    return out;
  }

  /* ============================ configuración ============================ */

  async configuracion() {
    return this.metricas.leer(async (c) => {
      const cat = await leerCatalogos(c, Number(hoyAr().slice(0, 4)));
      return {
        tasas: cat.tasas, rubros: cat.rubros, sucursales: cat.sucursales, config: cat.config,
        escalas: cat.escalas.map((e) => ({ ...e, totalDeducciones: totalDeducciones(e.deducciones) })),
        papeles: PAPELES.map((p) => ({ id: p, nombre: NOMBRE_PAPEL[p] })),
      };
    });
  }

  async crearTasa(dto: TasaDto, s: Sesion) {
    const sucursalId = dto.concepto === 'municipalidad' ? await this.sucursalValida(dto.sucursalId) : null;
    if (dto.concepto === 'municipalidad' && sucursalId == null) throw new BadRequestException('La tasa municipal es de un local: elegí cuál.');
    const medio = dto.concepto === 'tarjeta' ? (dto.medio ?? null) : null;
    const minimo = dto.concepto === 'municipalidad' ? r2(dto.minimo ?? 0) : 0;
    const desde = `${dto.desde}-01`;
    /* El mismo concepto, local, medio y mes: se corrige (no se duplica). */
    const [previa] = await this.db.select().from(resultadosTasas).where(and(
      eq(resultadosTasas.concepto, dto.concepto),
      sucursalId == null ? sql`${resultadosTasas.sucursalId} is null` : eq(resultadosTasas.sucursalId, sucursalId),
      medio == null ? sql`${resultadosTasas.medio} is null` : eq(resultadosTasas.medio, medio),
      eq(resultadosTasas.desde, desde),
    )).limit(1);
    const valores = { porcentaje: r2(dto.porcentaje * 1000) / 1000, minimo, usuarioId: s.usuarioId };
    let id: number;
    if (previa) {
      await this.db.update(resultadosTasas).set(valores).where(eq(resultadosTasas.id, previa.id));
      id = previa.id;
    } else {
      const [n] = await this.db.insert(resultadosTasas).values({ concepto: dto.concepto, sucursalId, medio, desde, ...valores }).returning({ id: resultadosTasas.id });
      id = n.id;
    }
    await this.auditar(s, 'resultados_tasa', id, 'Resultados · Tasas', await this.nombreTasa(dto.concepto, sucursalId, medio), [
      [`Vigente desde ${dto.desde}`, previa ? `${pct(previa.porcentaje)}${previa.minimo ? ` (mín. ${pesos(previa.minimo)})` : ''}` : '',
        `${pct(valores.porcentaje)}${minimo ? ` (mín. ${pesos(minimo)})` : ''}`],
    ]);
    return this.configuracion();
  }

  private async nombreTasa(concepto: string, sucursalId: number | null, medio: string | null) {
    if (concepto === 'iibb') return 'Ingresos Brutos';
    if (concepto === 'tarjeta') return `Comisión del posnet${medio ? ` (${medio === 'tarjeta_debito' ? 'débito' : 'crédito'})` : ''}`;
    const [x] = sucursalId ? await this.db.select({ nombre: sucursales.nombre }).from(sucursales).where(eq(sucursales.id, sucursalId)).limit(1) : [];
    return `Tasa municipal · ${x?.nombre ?? 'local'}`;
  }

  async borrarTasa(id: number, s: Sesion) {
    const [t] = await this.db.select().from(resultadosTasas).where(eq(resultadosTasas.id, id)).limit(1);
    if (!t) throw new NotFoundException('Tasa inexistente.');
    await this.db.delete(resultadosTasas).where(eq(resultadosTasas.id, id));
    await this.auditar(s, 'resultados_tasa', id, 'Resultados · Tasas', await this.nombreTasa(t.concepto, t.sucursalId, t.medio), [
      [`Vigente desde ${String(t.desde).slice(0, 7)}`, pct(t.porcentaje), '(borrada)'],
    ]);
    return this.configuracion();
  }

  async editarRubro(id: number, dto: RubroDto, s: Sesion) {
    const [r] = await this.db.select().from(gastoCategorias).where(eq(gastoCategorias.id, id)).limit(1);
    if (!r) throw new NotFoundException('Rubro inexistente.');
    const patch: any = {};
    const cambios: [string, string, string][] = [];
    if (dto.resultado && dto.resultado !== r.resultado) {
      patch.resultado = dto.resultado;
      cambios.push(['Cómo entra', NOMBRE_PAPEL[r.resultado] ?? r.resultado, NOMBRE_PAPEL[dto.resultado]]);
    }
    if (dto.reparte != null && dto.reparte !== r.reparte) {
      patch.reparte = dto.reparte;
      const txt = (b: boolean) => (b ? 'Se reparte por ventas' : 'Queda en Administración');
      cambios.push(['Sin local', txt(r.reparte), txt(dto.reparte)]);
    }
    if (dto.tipo && dto.tipo !== r.tipo) { patch.tipo = dto.tipo; cambios.push(['Tipo', r.tipo, dto.tipo]); }
    if (Object.keys(patch).length) await this.db.update(gastoCategorias).set(patch).where(eq(gastoCategorias.id, id));
    await this.auditar(s, 'gasto_categoria', id, 'Resultados · Rubros', r.nombre, cambios);
    return this.configuracion();
  }

  async guardarConfig(dto: ConfigDto, s: Sesion) {
    const [fila] = await this.db.select().from(resultadosConfig).where(eq(resultadosConfig.id, 1)).limit(1);
    const antes: any = fila?.valor ?? {};
    const valor: any = { ...antes };
    const cambios: [string, string, string][] = [];
    if (dto.amortizaciones != null && dto.amortizaciones !== (antes.amortizaciones === true)) {
      valor.amortizaciones = dto.amortizaciones;
      cambios.push(['Amortizaciones', antes.amortizaciones ? 'Sí' : 'No', dto.amortizaciones ? 'Sí' : 'No']);
    }
    if (dto.gananciasBase && dto.gananciasBase !== (antes.gananciasBase ?? 'facturado')) {
      valor.gananciasBase = dto.gananciasBase;
      const txt = (b: string) => (b === 'todo' ? 'Todo el resultado' : 'Solo la parte facturada');
      cambios.push(['Base de Ganancias', txt(antes.gananciasBase ?? 'facturado'), txt(dto.gananciasBase)]);
    }
    await this.db.insert(resultadosConfig).values({ id: 1, valor })
      .onConflictDoUpdate({ target: resultadosConfig.id, set: { valor, actualizadoEn: new Date() } });
    await this.auditar(s, 'resultados_config', 1, 'Resultados · Configuración', '', cambios);
    return this.configuracion();
  }

  async guardarEscala(anio: number, dto: EscalaDto, s: Sesion) {
    if (!(anio >= 2020 && anio <= 2100)) throw new BadRequestException('Año inválido.');
    const tramos = [...dto.tramos].map((t) => ({ desde: r2(t.desde), fijo: r2(t.fijo), pct: r2(t.pct) })).sort((a, b) => a.desde - b.desde);
    if (!tramos.length || tramos[0].desde !== 0) throw new BadRequestException('El primer tramo de la escala arranca en $0.');
    for (let i = 1; i < tramos.length; i++) {
      if (tramos[i].desde === tramos[i - 1].desde) throw new BadRequestException('Hay dos tramos que arrancan en el mismo importe.');
      if (tramos[i].pct < tramos[i - 1].pct) throw new BadRequestException('Los porcentajes de la escala tienen que ir subiendo.');
    }
    const deducciones = {
      gni: r2(dto.deducciones.gni), especial: r2(dto.deducciones.especial),
      cargasFamilia: r2(dto.deducciones.cargasFamilia), otras: r2(dto.deducciones.otras),
    };
    await this.db.insert(gananciasEscalas).values({ anio, tramos, deducciones })
      .onConflictDoUpdate({ target: gananciasEscalas.anio, set: { tramos, deducciones, actualizadoEn: new Date() } });
    await this.auditar(s, 'ganancias_escala', anio, 'Resultados · Ganancias', `Escala ${anio}`, [
      ['Tramos', '', `${tramos.length} (último: ${pct(tramos[tramos.length - 1].pct)} desde ${pesos(tramos[tramos.length - 1].desde)})`],
      ['Deducciones', '', pesos(totalDeducciones(deducciones))],
    ]);
    return this.configuracion();
  }

  /* ============================ objetivos ============================ */

  async objetivos(anio: number, sucursalId: number | null) {
    const r = await this.db.select().from(resultadosObjetivos).where(and(
      sql`${resultadosObjetivos.mes} >= ${`${anio}-01-01`}::date and ${resultadosObjetivos.mes} < ${`${anio + 1}-01-01`}::date`,
      sucursalId == null ? sql`${resultadosObjetivos.sucursalId} is null` : eq(resultadosObjetivos.sucursalId, sucursalId),
    ));
    return r.map((o) => ({ mes: String(o.mes).slice(0, 7), ventaNeta: o.ventaNeta, resultado: o.resultado }));
  }

  async guardarObjetivos(dto: ObjetivosDto, s: Sesion) {
    const sucursalId = await this.sucursalValida(dto.sucursalId);
    const anios = new Set(dto.meses.map((m) => m.mes.slice(0, 4)));
    if (anios.size > 1) throw new BadRequestException('Los objetivos se guardan de a un año.');
    await this.db.transaction(async (tx) => {
      for (const m of dto.meses) {
        const mes = `${m.mes}-01`;
        const venta = m.ventaNeta == null ? null : r2(m.ventaNeta);
        const resultado = m.resultado == null ? null : r2(m.resultado);
        await tx.execute(sql`delete from resultados_objetivos where mes = ${mes}::date and coalesce(sucursal_id, 0) = ${sucursalId ?? 0}`);
        if (venta != null || resultado != null) {
          await tx.insert(resultadosObjetivos).values({ mes, sucursalId, ventaNeta: venta, resultado });
        }
      }
    });
    const anio = Number([...anios][0] ?? hoyAr().slice(0, 4));
    await this.auditar(s, 'resultados_objetivos', anio, 'Resultados · Objetivos', `${anio}${sucursalId ? ` · local #${sucursalId}` : ' · empresa'}`, [
      ['Meses', '', `${dto.meses.filter((m) => m.ventaNeta != null || m.resultado != null).length} con objetivo`],
    ]);
    return this.objetivos(anio, sucursalId);
  }

  /* ============================ empleados ============================ */

  async empleados() {
    const r = await this.metricas.leer((c) => leerCatalogos(c, Number(hoyAr().slice(0, 4))));
    const mes = hoyAr().slice(0, 7);
    return {
      sucursales: r.sucursales,
      rubroSueldos: r.rubros.find((x: any) => x.resultado === 'sueldos') ?? null,
      empleados: r.empleados.map((e: any) => {
        const vigente = [...e.sueldos].filter((x: any) => x.desde <= mes).pop() ?? null;
        return { ...e, vigente };
      }),
    };
  }

  async crearEmpleado(dto: EmpleadoDto, s: Sesion) {
    const nombre = (dto.nombre ?? '').trim();
    if (!nombre) throw new BadRequestException('Poné el nombre del empleado.');
    if (!dto.alta) throw new BadRequestException('Poné la fecha de alta.');
    if (dto.bruto == null) throw new BadRequestException('Poné el sueldo bruto.');
    if (dto.baja && dto.baja < dto.alta) throw new BadRequestException('La baja no puede ser anterior al alta.');
    const sucursalId = await this.sucursalValida(dto.sucursalId);
    const id = await this.db.transaction(async (tx) => {
      const [e] = await tx.insert(empleados).values({
        nombre, cuil: (dto.cuil ?? '').trim(), sucursalId, alta: dto.alta!, baja: dto.baja ?? null,
        observaciones: (dto.observaciones ?? '').trim(),
      }).returning({ id: empleados.id });
      await tx.insert(empleadoSueldos).values({
        empleadoId: e.id, desde: `${dto.alta!.slice(0, 7)}-01`, bruto: r2(dto.bruto!), cargas: r2(dto.cargas ?? 0), usuarioId: s.usuarioId,
      });
      return e.id;
    });
    await this.auditar(s, 'empleado', id, 'Resultados · Sueldos', nombre, [
      ['Alta', '', dto.alta!], ['Sueldo bruto', '', `${pesos(dto.bruto!)} + ${pct(dto.cargas ?? 0)} de cargas`],
    ]);
    return this.empleados();
  }

  async editarEmpleado(id: number, dto: EmpleadoDto, s: Sesion) {
    const [e] = await this.db.select().from(empleados).where(eq(empleados.id, id)).limit(1);
    if (!e) throw new NotFoundException('Empleado inexistente.');
    const patch: any = {};
    const cambios: [string, string, string][] = [];
    if (dto.nombre != null && dto.nombre.trim() && dto.nombre.trim() !== e.nombre) { patch.nombre = dto.nombre.trim(); cambios.push(['Nombre', e.nombre, patch.nombre]); }
    if (dto.cuil != null && dto.cuil.trim() !== e.cuil) { patch.cuil = dto.cuil.trim(); cambios.push(['CUIL', e.cuil, patch.cuil]); }
    if (dto.sucursalId !== undefined && (dto.sucursalId ?? null) !== (e.sucursalId ?? null)) {
      patch.sucursalId = await this.sucursalValida(dto.sucursalId);
      cambios.push(['Local', e.sucursalId ? `#${e.sucursalId}` : 'Varios / Administración', patch.sucursalId ? `#${patch.sucursalId}` : 'Varios / Administración']);
    }
    if (dto.alta && dto.alta !== e.alta) { patch.alta = dto.alta; cambios.push(['Alta', e.alta, dto.alta]); }
    if (dto.baja !== undefined && (dto.baja ?? null) !== (e.baja ?? null)) { patch.baja = dto.baja ?? null; cambios.push(['Baja', e.baja ?? '', dto.baja ?? '(sin baja)']); }
    if (dto.observaciones != null && dto.observaciones.trim() !== e.observaciones) patch.observaciones = dto.observaciones.trim();
    const alta = patch.alta ?? e.alta;
    const baja = patch.baja !== undefined ? patch.baja : e.baja;
    if (baja && baja < alta) throw new BadRequestException('La baja no puede ser anterior al alta.');
    if (Object.keys(patch).length) await this.db.update(empleados).set(patch).where(eq(empleados.id, id));
    await this.auditar(s, 'empleado', id, 'Resultados · Sueldos', patch.nombre ?? e.nombre, cambios);
    return this.empleados();
  }

  async borrarEmpleado(id: number, s: Sesion) {
    const [e] = await this.db.select().from(empleados).where(eq(empleados.id, id)).limit(1);
    if (!e) throw new NotFoundException('Empleado inexistente.');
    await this.db.delete(empleados).where(eq(empleados.id, id));
    await this.auditar(s, 'empleado', id, 'Resultados · Sueldos', e.nombre, [['Empleado', e.nombre, '(borrado con sus sueldos)']]);
    return this.empleados();
  }

  async guardarSueldo(empleadoId: number, dto: SueldoDto, s: Sesion) {
    const [e] = await this.db.select().from(empleados).where(eq(empleados.id, empleadoId)).limit(1);
    if (!e) throw new NotFoundException('Empleado inexistente.');
    const desde = `${dto.desde}-01`;
    const [previo] = await this.db.select().from(empleadoSueldos)
      .where(and(eq(empleadoSueldos.empleadoId, empleadoId), eq(empleadoSueldos.desde, desde))).limit(1);
    const valores = { bruto: r2(dto.bruto), cargas: r2(dto.cargas), usuarioId: s.usuarioId };
    if (previo) await this.db.update(empleadoSueldos).set(valores).where(eq(empleadoSueldos.id, previo.id));
    else await this.db.insert(empleadoSueldos).values({ empleadoId, desde, ...valores });
    await this.auditar(s, 'empleado', empleadoId, 'Resultados · Sueldos', e.nombre, [
      [`Sueldo desde ${dto.desde}`, previo ? `${pesos(previo.bruto)} + ${pct(previo.cargas)}` : '', `${pesos(valores.bruto)} + ${pct(valores.cargas)}`],
    ]);
    return this.empleados();
  }

  async borrarSueldo(sueldoId: number, s: Sesion) {
    const [x] = await this.db.select().from(empleadoSueldos).where(eq(empleadoSueldos.id, sueldoId)).limit(1);
    if (!x) throw new NotFoundException('Sueldo inexistente.');
    const [{ n }] = await this.db.select({ n: sql<number>`count(*)::int` }).from(empleadoSueldos).where(eq(empleadoSueldos.empleadoId, x.empleadoId));
    if (n <= 1) throw new BadRequestException('Es el único sueldo del empleado: cambialo en vez de borrarlo.');
    const [e] = await this.db.select({ nombre: empleados.nombre }).from(empleados).where(eq(empleados.id, x.empleadoId)).limit(1);
    await this.db.delete(empleadoSueldos).where(eq(empleadoSueldos.id, sueldoId));
    await this.auditar(s, 'empleado', x.empleadoId, 'Resultados · Sueldos', e?.nombre ?? '', [
      [`Sueldo desde ${String(x.desde).slice(0, 7)}`, `${pesos(x.bruto)} + ${pct(x.cargas)}`, '(borrado)'],
    ]);
    return this.empleados();
  }

  /* ============================ bienes de uso ============================ */

  async bienes() {
    const r = await this.metricas.leer((c) => leerCatalogos(c, Number(hoyAr().slice(0, 4))));
    const mes = hoyAr().slice(0, 7);
    return {
      sucursales: r.sucursales, activas: r.config.amortizaciones,
      bienes: r.bienes.map((b: any) => {
        const alta = b.alta.slice(0, 7);
        const fin = sumarMeses(alta, b.vidaMeses - 1);
        const tope = b.baja && b.baja.slice(0, 7) < mes ? b.baja.slice(0, 7) : mes;
        const corrido = tope < alta ? 0 : Math.min(b.vidaMeses, mesesEntre(alta, tope).length);
        return { ...b, cuota: r2(b.valor / b.vidaMeses), hasta: fin, amortizado: r2(b.valor / b.vidaMeses * corrido) };
      }),
    };
  }

  async crearBien(dto: BienDto, s: Sesion) {
    const nombre = (dto.nombre ?? '').trim();
    if (!nombre) throw new BadRequestException('Poné qué es el bien.');
    if (!dto.valor || !dto.alta || !dto.vidaMeses) throw new BadRequestException('Poné el valor, el mes de alta y la vida útil.');
    const sucursalId = await this.sucursalValida(dto.sucursalId);
    const [b] = await this.db.insert(bienesUso).values({
      nombre, sucursalId, valor: r2(dto.valor), alta: `${dto.alta}-01`, vidaMeses: dto.vidaMeses,
      baja: dto.baja ?? null, observaciones: (dto.observaciones ?? '').trim(),
    }).returning({ id: bienesUso.id });
    await this.auditar(s, 'bien_uso', b.id, 'Resultados · Bienes de uso', nombre, [
      ['Alta', '', `${pesos(dto.valor)} en ${dto.vidaMeses} meses desde ${dto.alta}`],
    ]);
    return this.bienes();
  }

  async editarBien(id: number, dto: BienDto, s: Sesion) {
    const [b] = await this.db.select().from(bienesUso).where(eq(bienesUso.id, id)).limit(1);
    if (!b) throw new NotFoundException('Bien inexistente.');
    const patch: any = {};
    if (dto.nombre != null && dto.nombre.trim()) patch.nombre = dto.nombre.trim();
    if (dto.sucursalId !== undefined) patch.sucursalId = await this.sucursalValida(dto.sucursalId);
    if (dto.valor != null) patch.valor = r2(dto.valor);
    if (dto.alta) patch.alta = `${dto.alta}-01`;
    if (dto.vidaMeses != null) patch.vidaMeses = dto.vidaMeses;
    if (dto.baja !== undefined) patch.baja = dto.baja ?? null;
    if (dto.observaciones != null) patch.observaciones = dto.observaciones.trim();
    const alta = patch.alta ?? b.alta;
    const baja = patch.baja !== undefined ? patch.baja : b.baja;
    if (baja && baja < alta) throw new BadRequestException('La baja no puede ser anterior al alta.');
    if (Object.keys(patch).length) await this.db.update(bienesUso).set(patch).where(eq(bienesUso.id, id));
    await this.auditar(s, 'bien_uso', id, 'Resultados · Bienes de uso', patch.nombre ?? b.nombre,
      Object.keys(patch).filter((k) => k !== 'observaciones').map((k) => [k, String((b as any)[k] ?? ''), String(patch[k] ?? '')]));
    return this.bienes();
  }

  async borrarBien(id: number, s: Sesion) {
    const [b] = await this.db.select().from(bienesUso).where(eq(bienesUso.id, id)).limit(1);
    if (!b) throw new NotFoundException('Bien inexistente.');
    await this.db.delete(bienesUso).where(eq(bienesUso.id, id));
    await this.auditar(s, 'bien_uso', id, 'Resultados · Bienes de uso', b.nombre, [['Bien', b.nombre, '(borrado)']]);
    return this.bienes();
  }
}

/* -------------------------------- controlador -------------------------------- */

@Controller('resultados')
@Permiso(PERMISO_RESULTADOS)
export class ResultadosController {
  constructor(private readonly svc: ResultadosService) {}

  @Get() estado(@Query() q: { desde?: string; hasta?: string; foco?: string }) { return this.svc.estado(q); }

  @Get('configuracion') configuracion() { return this.svc.configuracion(); }
  @Post('tasas') crearTasa(@Body() dto: TasaDto, @Auth() s: Sesion) { return this.svc.crearTasa(dto, s); }
  @Delete('tasas/:id') borrarTasa(@Param('id', ParseIntPipe) id: number, @Auth() s: Sesion) { return this.svc.borrarTasa(id, s); }
  @Patch('rubros/:id') editarRubro(@Param('id', ParseIntPipe) id: number, @Body() dto: RubroDto, @Auth() s: Sesion) {
    return this.svc.editarRubro(id, dto, s);
  }
  @Put('configuracion') guardarConfig(@Body() dto: ConfigDto, @Auth() s: Sesion) { return this.svc.guardarConfig(dto, s); }
  @Put('escalas/:anio') guardarEscala(@Param('anio', ParseIntPipe) anio: number, @Body() dto: EscalaDto, @Auth() s: Sesion) {
    return this.svc.guardarEscala(anio, dto, s);
  }

  @Get('objetivos') objetivos(@Query('anio') anio?: string, @Query('sucursalId') suc?: string) {
    const a = Number(anio) || Number(hoyAr().slice(0, 4));
    const sId = Number(suc);
    return this.svc.objetivos(a, Number.isInteger(sId) && sId > 0 ? sId : null);
  }
  @Put('objetivos') guardarObjetivos(@Body() dto: ObjetivosDto, @Auth() s: Sesion) { return this.svc.guardarObjetivos(dto, s); }

  @Get('empleados') empleados() { return this.svc.empleados(); }
  @Post('empleados') crearEmpleado(@Body() dto: EmpleadoDto, @Auth() s: Sesion) { return this.svc.crearEmpleado(dto, s); }
  @Patch('empleados/:id') editarEmpleado(@Param('id', ParseIntPipe) id: number, @Body() dto: EmpleadoDto, @Auth() s: Sesion) {
    return this.svc.editarEmpleado(id, dto, s);
  }
  @Delete('empleados/:id') borrarEmpleado(@Param('id', ParseIntPipe) id: number, @Auth() s: Sesion) { return this.svc.borrarEmpleado(id, s); }
  @Post('empleados/:id/sueldos') guardarSueldo(@Param('id', ParseIntPipe) id: number, @Body() dto: SueldoDto, @Auth() s: Sesion) {
    return this.svc.guardarSueldo(id, dto, s);
  }
  @Delete('sueldos/:id') borrarSueldo(@Param('id', ParseIntPipe) id: number, @Auth() s: Sesion) { return this.svc.borrarSueldo(id, s); }

  @Get('bienes') bienes() { return this.svc.bienes(); }
  @Post('bienes') crearBien(@Body() dto: BienDto, @Auth() s: Sesion) { return this.svc.crearBien(dto, s); }
  @Patch('bienes/:id') editarBien(@Param('id', ParseIntPipe) id: number, @Body() dto: BienDto, @Auth() s: Sesion) {
    return this.svc.editarBien(id, dto, s);
  }
  @Delete('bienes/:id') borrarBien(@Param('id', ParseIntPipe) id: number, @Auth() s: Sesion) { return this.svc.borrarBien(id, s); }
}

@Module({
  imports: [MetricasModule],
  controllers: [ResultadosController],
  providers: [ResultadosService],
})
export class ResultadosModule {}
