/**
 * USUARIOS Y ROLES
 * ============================================================================
 * El rol es una FILA con su lista de permisos (no un enum): el superadmin los
 * crea y ajusta desde Gerencia sin tocar código. Reglas:
 *
 *   - superadmin: maneja todo (`['*']`). No se edita, no se borra, y siempre
 *     tiene que quedar al menos un usuario superadmin activo.
 *   - roles de sistema (admin, fraccionador, cajero): editables, no borrables.
 *   - usuarios: no se borran (están en historiales) — se desactivan.
 *
 * Contraseñas con scrypt de Node (`s2:<salt>:<hash>`): sin dependencias
 * nuevas, y `verificarPassword` queda listo para el login real.
 */
import {
  BadRequestException, Body, Controller, Delete, Get, Inject, Injectable,
  Module, NotFoundException, Param, ParseIntPipe, Patch, Post, UnauthorizedException,
} from '@nestjs/common';
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { and, eq, ne } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle';
import { roles, sucursales, usuarios } from '../db/schema';

/* ---------------- Catálogo de permisos (fuente de verdad) ---------------- */
/**
 * DOS NIVELES, un solo modelo:
 *
 *   - SECCIONES (`modulo.seccion`): qué PANTALLAS ve el rol. Un módulo sin
 *     ninguna sección asignada desaparece entero del menú — no muestra nada
 *     de nada. Las claves espejan el sub-menú real de cada módulo.
 *   - ACCIONES (claves simples históricas): qué OPERACIONES puede hacer dentro
 *     de lo que ve (registrar merma, preparar envíos, cobrar, etc.). Gatean
 *     botones, no pantallas.
 *
 * El frontend arma el editor de roles con ESTE catálogo: agregar una sección
 * o acción acá la hace aparecer sola en Gerencia.
 */
export const CATALOGO_PERMISOS = [
  {
    grupo: 'General',
    modulo: null,
    secciones: [
      { clave: 'dashboard', nombre: 'Dashboard' },
      { clave: 'manual', nombre: 'Info de sistema' },
    ],
    acciones: [],
  },
  {
    grupo: 'Compras',
    modulo: 'compras',
    secciones: [
      { clave: 'compras.dashboard', nombre: 'Dashboard de compras' },
      { clave: 'compras.productos', nombre: 'Productos' },
      { clave: 'compras.catalogos', nombre: 'Catálogos' },
      { clave: 'compras.proveedores', nombre: 'Proveedores' },
      { clave: 'compras.lecturas', nombre: 'Facturas por procesar (bandeja de papeles subidos)' },
      { clave: 'compras.facturacion', nombre: 'Facturación' },
      { clave: 'compras.pagos', nombre: 'Pagos en sucursal (plata a cuenta de proveedores)' },
      { clave: 'compras.historial', nombre: 'Historial' },
    ],
    acciones: [
      { clave: 'facturas', nombre: 'Cargar comprobantes de compra' },
      /*
       * Permiso APARTE del de facturas, y a propósito. La liquidación es la
       * mitad que el proveedor entrega sin factura: es un documento no fiscal y
       * quién lo ve es decisión del dueño, no una consecuencia de poder cargar
       * compras. Arranca solo para admin y superadmin — aflojarlo después es
       * fácil, apretarlo una vez que todos lo vieron no.
       */
      { clave: 'liquidaciones', nombre: 'Cargar y ver liquidaciones (la mitad sin factura)' },
      { clave: 'precios', nombre: 'Precios, márgenes y actualizaciones' },
      { clave: 'etiquetas', nombre: 'Imprimir etiquetas' },
    ],
  },
  {
    grupo: 'Ventas',
    modulo: 'ventas',
    secciones: [
      { clave: 'ventas.pos', nombre: 'Punto de venta' },
      { clave: 'ventas.ordenes', nombre: 'Órdenes web (bandeja de pedidos del sitio)' },
      { clave: 'ventas.presupuestos', nombre: 'Presupuestos' },
      { clave: 'ventas.clientes', nombre: 'Clientes' },
      { clave: 'ventas.cobranzas', nombre: 'Cobranzas' },
      { clave: 'ventas.caja', nombre: 'Caja' },
      { clave: 'ventas.listas', nombre: 'Formato de venta' },
      { clave: 'ventas.ofertas', nombre: 'Ofertas' },
      { clave: 'ventas.cambios', nombre: 'Cambios de precio' },
      { clave: 'ventas.configuracion', nombre: 'Configuración de ventas' },
    ],
    acciones: [
      { clave: 'ventas', nombre: 'Cobrar en caja' },
      { clave: 'presupuestos', nombre: 'Cotizar presupuestos' },
      { clave: 'devoluciones', nombre: 'Devoluciones' },
      { clave: 'diferencias', nombre: 'Diferencias de caja' },
      { clave: 'ofertas', nombre: 'Crear y editar ofertas' },
    ],
  },
  {
    grupo: 'Almacén',
    modulo: 'almacen',
    secciones: [
      { clave: 'almacen.existencias', nombre: 'Existencias' },
      { clave: 'almacen.fraccionamiento', nombre: 'Fraccionamiento' },
      { clave: 'almacen.transferencias', nombre: 'Transferencias' },
      { clave: 'almacen.operaciones', nombre: 'Operaciones' },
      { clave: 'almacen.incidencias', nombre: 'Incidencias' },
      { clave: 'almacen.cafeteria', nombre: 'Cafetería (envíos a coffit)' },
      /*
       * La pantalla DE la cafetería: armar el pedido a la distribuidora. Es la
       * única sección del rol Cafetería — sin ninguna otra clave, ese usuario
       * no ve nada más del CRM (sin sección = módulo invisible).
       *
       * NO va para administración (la 0049 se la quitó a admin y superadmin):
       * es el café pidiendo, no la distribuidora mandando. Para mandar sin
       * pedido detrás está "+ Nuevo envío" en `almacen.cafeteria`.
       */
      { clave: 'almacen.cafeteria-pedidos', nombre: 'Pedido a la distribuidora (SOLO para el rol Cafetería)' },
    ],
    acciones: [
      { clave: 'pedidos', nombre: 'Pedir y recibir mercadería' },
      { clave: 'preparar', nombre: 'Preparar envíos (lista Enteros)' },
      { clave: 'fraccionar', nombre: 'Fraccionar granel (y su lista en envíos)' },
      { clave: 'inventario', nombre: 'Ajustes de inventario' },
      { clave: 'merma', nombre: 'Registrar mermas' },
      { clave: 'defectuoso', nombre: 'Marcar defectuosos' },
      { clave: 'incidencia_crear', nombre: 'Crear incidencias' },
    ],
  },
  {
    grupo: 'Web',
    modulo: 'web',
    secciones: [
      { clave: 'web.productos', nombre: 'Productos del sitio' },
      { clave: 'web.ofertas', nombre: 'Ofertas del sitio' },
      { clave: 'web.contenido', nombre: 'Contenido (banners e imágenes)' },
      { clave: 'web.estadisticas', nombre: 'Estadísticas del sitio' },
      { clave: 'web.configuracion', nombre: 'Configuración del sitio (logo, contacto, redes)' },
    ],
    acciones: [],
  },
  {
    grupo: 'Gastos',
    modulo: 'gastos',
    secciones: [
      { clave: 'gastos.gastos', nombre: 'Gastos (carga de comprobantes)' },
      { clave: 'gastos.pagos', nombre: 'Cuentas a pagar' },
      { clave: 'gastos.pagos_proveedor', nombre: 'Pagos a proveedores (bandeja y aplicación)' },
      { clave: 'gastos.fijos', nombre: 'Gastos fijos' },
      { clave: 'gastos.categorias', nombre: 'Rubros de gasto' },
      { clave: 'gastos.proveedores', nombre: 'Proveedores de gastos' },
      { clave: 'gastos.resumen', nombre: 'Resumen de gastos' },
    ],
    acciones: [
      { clave: 'gastos_pagar', nombre: 'Registrar y revertir pagos de gastos' },
      { clave: 'gastos_anular', nombre: 'Anular gastos' },
      // Pagar es del cajero (le da la plata al proveedor); imputar es del
      // administrador (decide contra qué factura se descuenta). Van separadas
      // a propósito: son dos responsabilidades distintas.
      { clave: 'gastos_pagar_proveedor', nombre: 'Pagar a un proveedor desde la caja' },
      { clave: 'gastos_imputar', nombre: 'Aplicar pagos a facturas y gastos' },
    ],
  },
  {
    grupo: 'Gerencia',
    modulo: 'gerencia',
    secciones: [
      { clave: 'gerencia.usuarios', nombre: 'Usuarios y roles' },
      { clave: 'gerencia.reportes', nombre: 'Reportes de ventas' },
      { clave: 'gerencia.rentabilidad', nombre: 'Rentabilidad' },
      { clave: 'gerencia.valorizacion', nombre: 'Valorización de stock' },
      { clave: 'gerencia.auditoria', nombre: 'Auditoría' },
      { clave: 'gerencia.configuracion', nombre: 'Configuración' },
    ],
    acciones: [],
  },
  {
    grupo: 'Sistema',
    modulo: 'sistema',
    secciones: [
      { clave: 'sistema.empresa', nombre: 'Empresa' },
      { clave: 'sistema.impresion', nombre: 'Impresión' },
      { clave: 'sistema.respaldos', nombre: 'Respaldos' },
    ],
    acciones: [],
  },
];

const CLAVES_VALIDAS = new Set(
  CATALOGO_PERMISOS.flatMap((g) => [...g.secciones, ...g.acciones].map((p) => p.clave)),
);

/**
 * Claves del catálogo viejo que ya no se muestran pero se siguen aceptando:
 * un rol guardado con ellas no puede volverse ineditable por una clave que
 * dejó de existir. No dan acceso a nada nuevo — solo pasan la validación.
 */
const CLAVES_LEGADAS = new Set(['ver', 'config', 'usuarios']);

/* ---------------- Contraseñas (scrypt, sin dependencias) ---------------- */

export function hashPassword(pw: string): string {
  const salt = randomBytes(16).toString('hex');
  return `s2:${salt}:${scryptSync(pw, salt, 64).toString('hex')}`;
}

export function verificarPassword(pw: string, hash: string): boolean {
  const [v, salt, h] = (hash || '').split(':');
  if (v !== 's2' || !salt || !h) return false;
  const calc = scryptSync(pw, salt, 64);
  const guardado = Buffer.from(h, 'hex');
  return calc.length === guardado.length && timingSafeEqual(calc, guardado);
}

/** Usuario sin secretos, con su rol resuelto: lo que viaja al frontend. */
function publico(u: any, r: any) {
  return {
    id: u.id, nombre: u.nombre, activo: u.activo, rolId: u.rolId,
    rolClave: r?.clave ?? '', rolNombre: r?.nombre ?? '',
    permisos: r?.permisos ?? [],
    tienePassword: !!u.passwordHash,
  };
}

@Injectable()
export class UsuariosService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /* ---------------- Roles ---------------- */

  async listRoles() {
    const [rs, us] = await Promise.all([
      this.db.select().from(roles).orderBy(roles.id),
      this.db.select().from(usuarios),
    ]);
    return rs.map((r) => ({ ...r, usuarios: us.filter((u) => u.rolId === r.id).length }));
  }

  catalogoPermisos() { return CATALOGO_PERMISOS; }

  private validarPermisos(permisos: any): string[] {
    if (!Array.isArray(permisos)) throw new BadRequestException('Permisos inválidos.');
    const limpios = [...new Set(permisos.map((p) => String(p)))];
    const raros = limpios.filter((p) => p !== '*' && !CLAVES_VALIDAS.has(p) && !CLAVES_LEGADAS.has(p));
    if (raros.length) throw new BadRequestException(`Permisos desconocidos: ${raros.join(', ')}.`);
    return limpios;
  }

  async crearRol(o: any) {
    const nombre = (o?.nombre ?? '').trim();
    if (!nombre) throw new BadRequestException('Poné el nombre del rol.');
    const clave = nombre.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '')
      .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (!clave) throw new BadRequestException('El nombre no genera una clave válida.');
    const [ya] = await this.db.select().from(roles).where(eq(roles.clave, clave)).limit(1);
    if (ya) throw new BadRequestException(`Ya existe un rol con la clave "${clave}".`);
    const permisos = this.validarPermisos(o?.permisos ?? ['ver']);
    const [r] = await this.db.insert(roles).values({
      clave, nombre, descripcion: (o?.descripcion ?? '').trim(), permisos, esSistema: false,
    }).returning();
    return { ok: true, id: r.id };
  }

  async editarRol(id: number, o: any) {
    const [r] = await this.db.select().from(roles).where(eq(roles.id, id)).limit(1);
    if (!r) throw new NotFoundException('Rol inexistente.');
    if (r.clave === 'superadmin') throw new BadRequestException('El superadmin maneja todo: no se edita.');
    const patch: any = {};
    if (o?.nombre != null) {
      const n = String(o.nombre).trim();
      if (!n) throw new BadRequestException('El nombre no puede quedar vacío.');
      patch.nombre = n;
    }
    if (o?.descripcion != null) patch.descripcion = String(o.descripcion).trim();
    if (o?.permisos != null) patch.permisos = this.validarPermisos(o.permisos);
    if (Object.keys(patch).length) await this.db.update(roles).set(patch).where(eq(roles.id, id));
    return { ok: true };
  }

  async borrarRol(id: number) {
    const [r] = await this.db.select().from(roles).where(eq(roles.id, id)).limit(1);
    if (!r) throw new NotFoundException('Rol inexistente.');
    if (r.esSistema) throw new BadRequestException('Los roles del sistema no se borran.');
    const usados = await this.db.select().from(usuarios).where(eq(usuarios.rolId, id)).limit(1);
    if (usados.length) throw new BadRequestException('Hay usuarios con ese rol: reasignalos primero.');
    await this.db.delete(roles).where(eq(roles.id, id));
    return { ok: true };
  }

  /* ---------------- Usuarios ---------------- */

  async listUsuarios() {
    const [us, rs] = await Promise.all([
      this.db.select().from(usuarios).orderBy(usuarios.id),
      this.db.select().from(roles),
    ]);
    const rolDe = new Map(rs.map((r) => [r.id, r]));
    return us.map((u) => publico(u, rolDe.get(u.rolId)));
  }

  async crearUsuario(o: any) {
    const nombre = (o?.nombre ?? '').trim();
    if (!nombre) throw new BadRequestException('Poné el nombre del usuario.');
    const [r] = await this.db.select().from(roles).where(eq(roles.id, Number(o?.rolId))).limit(1);
    if (!r) throw new BadRequestException('Elegí un rol válido.');
    const password = String(o?.password ?? '');
    if (password.length < 4) throw new BadRequestException('La contraseña necesita al menos 4 caracteres.');
    const [u] = await this.db.insert(usuarios).values({
      nombre, rolId: r.id, passwordHash: hashPassword(password), activo: o?.activo !== false,
    }).returning();
    return { ok: true, id: u.id };
  }

  /* ---------------- Login ---------------- */

  /**
   * Entrada al sistema: usuario + contraseña + LA SUCURSAL con la que se va a
   * operar (la elección del login es el contexto de trabajo de toda la sesión).
   * Los mensajes distinguen el caso "sin contraseña definida" del "contraseña
   * incorrecta": el primero se arregla pidiéndosela al superadmin, no reintentando.
   */
  async login(o: any) {
    const [u] = await this.db.select().from(usuarios).where(eq(usuarios.id, Number(o?.usuarioId))).limit(1);
    if (!u) throw new UnauthorizedException('Elegí un usuario válido.');
    if (!u.activo) throw new UnauthorizedException('Ese usuario está desactivado — hablá con el superadmin.');
    if (!u.passwordHash) throw new UnauthorizedException(`${u.nombre} no tiene contraseña definida — el superadmin se la asigna desde Gerencia.`);
    if (!verificarPassword(String(o?.password ?? ''), u.passwordHash)) {
      throw new UnauthorizedException('Contraseña incorrecta.');
    }
    const [suc] = await this.db.select().from(sucursales).where(eq(sucursales.id, Number(o?.sucursalId))).limit(1);
    if (!suc) throw new UnauthorizedException('Elegí la sucursal con la que vas a operar.');
    const [r] = await this.db.select().from(roles).where(eq(roles.id, u.rolId)).limit(1);
    return { ok: true, usuario: publico(u, r), sucursal: { id: suc.id, nombre: suc.nombre } };
  }

  /** Nunca puede quedar el sistema sin UN superadmin activo: sería quedarse afuera. */
  private async esUltimoSuperadmin(u: any, r: any) {
    if (r?.clave !== 'superadmin') return false;
    const otros = await this.db.select({ id: usuarios.id }).from(usuarios)
      .innerJoin(roles, eq(roles.id, usuarios.rolId))
      .where(and(eq(roles.clave, 'superadmin'), eq(usuarios.activo, true), ne(usuarios.id, u.id)));
    return otros.length === 0;
  }

  async editarUsuario(id: number, o: any) {
    const [u] = await this.db.select().from(usuarios).where(eq(usuarios.id, id)).limit(1);
    if (!u) throw new NotFoundException('Usuario inexistente.');
    const [rolActual] = await this.db.select().from(roles).where(eq(roles.id, u.rolId)).limit(1);

    const patch: any = {};
    if (o?.nombre != null) {
      const n = String(o.nombre).trim();
      if (!n) throw new BadRequestException('El nombre no puede quedar vacío.');
      patch.nombre = n;
    }
    if (o?.rolId != null && Number(o.rolId) !== u.rolId) {
      const [r] = await this.db.select().from(roles).where(eq(roles.id, Number(o.rolId))).limit(1);
      if (!r) throw new BadRequestException('Elegí un rol válido.');
      if (await this.esUltimoSuperadmin(u, rolActual)) {
        throw new BadRequestException('Es el último superadmin activo: primero nombrá otro.');
      }
      patch.rolId = r.id;
    }
    if (o?.activo != null && !!o.activo !== u.activo) {
      if (!o.activo && await this.esUltimoSuperadmin(u, rolActual)) {
        throw new BadRequestException('Es el último superadmin activo: primero nombrá otro.');
      }
      patch.activo = !!o.activo;
    }
    if (o?.password != null && o.password !== '') {
      const pw = String(o.password);
      if (pw.length < 4) throw new BadRequestException('La contraseña necesita al menos 4 caracteres.');
      patch.passwordHash = hashPassword(pw);
    }
    if (Object.keys(patch).length) await this.db.update(usuarios).set(patch).where(eq(usuarios.id, id));
    return { ok: true };
  }
}

@Controller('roles')
export class RolesController {
  constructor(private readonly svc: UsuariosService) {}
  @Get() list() { return this.svc.listRoles(); }
  @Get('permisos') permisos() { return this.svc.catalogoPermisos(); }
  @Post() crear(@Body() body: any) { return this.svc.crearRol(body ?? {}); }
  @Patch(':id') editar(@Param('id', ParseIntPipe) id: number, @Body() body: any) { return this.svc.editarRol(id, body ?? {}); }
  @Delete(':id') borrar(@Param('id', ParseIntPipe) id: number) { return this.svc.borrarRol(id); }
}

@Controller('usuarios')
export class UsuariosController {
  constructor(private readonly svc: UsuariosService) {}
  @Get() list() { return this.svc.listUsuarios(); }
  @Post() crear(@Body() body: any) { return this.svc.crearUsuario(body ?? {}); }
  @Patch(':id') editar(@Param('id', ParseIntPipe) id: number, @Body() body: any) { return this.svc.editarUsuario(id, body ?? {}); }
}

@Controller('auth')
export class AuthController {
  constructor(private readonly svc: UsuariosService) {}
  @Post('login') login(@Body() body: any) { return this.svc.login(body ?? {}); }
}

@Module({
  controllers: [RolesController, UsuariosController, AuthController],
  providers: [UsuariosService],
  exports: [UsuariosService],
})
export class UsuariosModule {}
