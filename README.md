# crm-api

API del CRM/ERP. **NestJS + Drizzle ORM + PostgreSQL**. Sirve el subsistema de
inventario (Compras + Almacén): catálogo de productos, proveedores, sucursales,
usuarios, existencias, movimientos, transferencias e incidencias.

Forma parte del monorepo informal en `CRM system/`:

```
CRM system/
├── crm-dashboard/   # Frontend React + Vite (el CRM)  → github.com/saboryaromacrm-lab/crm-dashboard
├── crm-api/         # ← este proyecto (API + base de datos)
└── (tienda online Next.js — más adelante)
```

> **Los dos proyectos se clonan en la misma carpeta.** La API tiene que estar
> corriendo antes de levantar el CRM: el frontend carga todo desde `/api/bootstrap`.

## Puesta en marcha rápida

```bash
git clone https://github.com/saboryaromacrm-lab/crm-api.git
cd crm-api
npm install
cp .env.example .env          # y editá DATABASE_URL con tu password de postgres
npm run db:create             # crea la base "crm"
npm run db:migrate            # crea las 28 tablas
npm run db:seed               # datos de ejemplo
npm run start:dev             # http://localhost:3001/api
```

El detalle de cada paso está más abajo.

## Requisitos

- Node.js ≥ 20
- **PostgreSQL 14+** corriendo localmente (o un connection string a un Postgres remoto)

## 1. Instalar PostgreSQL (local, Windows)

1. Descargá el instalador desde https://www.postgresql.org/download/windows/ (EDB).
2. Durante la instalación, definí una contraseña para el usuario `postgres` (recordala).
3. Dejá el puerto por defecto **5432**.
4. Al terminar, creá la base de datos `crm`. Con **SQL Shell (psql)** o **pgAdmin**:

   ```sql
   CREATE DATABASE crm;
   ```

   (o desde la terminal, si `psql` quedó en el PATH: `createdb -U postgres crm`)

## 2. Configurar el proyecto

```bash
cd "CRM system/crm-api"
copy .env.example .env      # en PowerShell/CMD  (o: cp .env.example .env)
```

Editá `.env` y poné tu contraseña de `postgres` en `DATABASE_URL`:

```
DATABASE_URL=postgres://postgres:TU_PASSWORD@localhost:5432/crm
PORT=3001
CORS_ORIGINS=http://localhost:3000,http://localhost:5173
```

Instalá dependencias (ya hecho si clonaste con node_modules):

```bash
npm install
```

## 3. Crear la base, migrar y cargar datos de ejemplo

```bash
npm run db:create      # crea la base "crm" si no existe (no hace falta psql)
npm run db:migrate     # crea las tablas aplicando las migraciones
npm run db:seed        # carga los datos de ejemplo
```

Otros scripts:

| Script | Qué hace |
|--------|----------|
| `npm run db:create` | Crea la base indicada en `DATABASE_URL` si no existe |
| `npm run db:migrate` | Aplica las migraciones pendientes de `drizzle/` |
| `npm run db:seed` | Vacía las tablas de datos y carga el ejemplo (respeta la configuración guardada) |
| `npm run db:reset` | Vacía todas las tablas, sin insertar nada |
| `npm run db:generate` | Regenera las migraciones SQL desde `src/db/schema.ts` (tras cambiar el esquema) |

### Archivos de base de datos

La carpeta `database/` tiene un volcado listo para usar, por si preferís cargar
la base directamente en vez de correr las migraciones:

| Archivo | Contenido |
|---------|-----------|
| `database/schema.sql` | Estructura completa: 20 tipos enumerados, 28 tablas, índices y claves foráneas. **Sin datos.** |
| `database/seed-ejemplo.sql` | Solo los datos de ejemplo (sucursales, productos, proveedores, clientes, comprobantes). Se carga **después** del esquema. |

```bash
# Restaurar desde los volcados (alternativa a db:migrate + db:seed)
createdb -U postgres crm
psql -U postgres -d crm -f database/schema.sql
psql -U postgres -d crm -f database/seed-ejemplo.sql
```

En Windows, si `psql` no está en el PATH, está en
`C:\Program Files\PostgreSQL\18\bin\psql.exe`.

> **Cuál es la fuente de verdad.** Las migraciones de `drizzle/` son las que
> mandan: se generan desde `src/db/schema.ts` y son las que se aplican en
> producción. Los archivos de `database/` son una **foto** para levantar rápido
> o para inspeccionar el esquema de un vistazo — si cambiás el esquema, hay que
> regenerarlos con `pg_dump`.

## 4. Levantar la API

```bash
npm run start:dev      # http://localhost:3001/api  (con recarga en caliente)
```

Probá que responde: abrí http://localhost:3001/api/health

## 5. Conectar el CRM (crm-dashboard) a la API

Creá `crm-dashboard/.env` con:

```
VITE_API_BASE_URL=http://localhost:3001/api
```

y levantá el CRM con `npm run dev` (queda en http://localhost:3000). El frontend
ya consume esta API: no hay datos de ejemplo locales, si la API no responde el
CRM muestra el error y un botón para reintentar.

## Endpoints

Base: `http://localhost:3001/api`

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/health` | Estado del servicio |
| GET | `/bootstrap` | Catálogo + existencias. **No** trae movimientos ni comprobantes (crecen sin techo) |
| GET/POST | `/productos` · `/productos/:id` | Catálogo de productos (con costo/precios computados) |
| PATCH/DELETE | `/productos/:id` | Editar / eliminar producto |
| PUT | `/productos/:id/presentaciones` | Reemplazar presentaciones (granel) |
| PUT | `/productos/:id/proveedores` | Reemplazar costos por proveedor + proveedor activo |
| PUT | `/productos/:id/listas` | Reemplazar listas de precio |
| GET/POST/PATCH/DELETE | `/proveedores` | CRUD de proveedores |
| GET/POST/PATCH/DELETE | `/sucursales` | CRUD de sucursales |
| GET/POST | `/usuarios` | Listar / crear usuarios |
| GET | `/stock` | Existencias (Producto × Sucursal × Presentación × Estado) |
| GET | `/movimientos?productoId=&sucursalId=&tipo=&limit=` | Historial paginado (ya NO viaja en /bootstrap) |
| POST | `/operaciones/compra` | Ingreso de mercadería (suma stock) |
| POST | `/operaciones/venta` | Venta (descuenta stock) |
| POST | `/operaciones/fraccionar` | Granel → paquetes |
| POST | `/operaciones/movimiento` | Devolución / ajuste / merma / vencido / defectuoso |
| GET/POST | `/transferencias` | Listar / crear transferencias |
| POST | `/transferencias/:id/avanzar` · `/cancelar` | Avanzar estado / cancelar |
| GET/POST | `/incidencias` | Listar / crear incidencias |
| POST | `/incidencias/:id/avanzar` · `/resolver` | A revisión / resolver |
| GET | `/comprobantes?proveedorId=&tipo=&estado=` | Comprobantes de compra (factura/remito/NC/ND/OC) |
| GET/POST | `/comprobantes` · `/comprobantes/:id` | Crear / ver comprobante (con ítems y totales) |
| GET | `/comprobantes/cuenta/:proveedorId` | Saldo de cuenta corriente del proveedor |
| POST | `/precios/costos` | Actualiza costo/descuento/flete y registra el historial (devuelve el lote) |
| POST | `/precios/margenes` | Actualiza ganancias de listas o recargos de presentaciones |
| GET | `/precios/historial?productoId=&proveedorId=&lote=` | Auditoría de cambios de costo |
| POST | `/precios/revertir/:lote` | Deshace una tanda; saltea lo que cambió después |

### Ventas

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/ventas/bootstrap` | Catálogos del módulo Ventas (clientes, config, sucursales, usuarios). **No** trae ventas ni cobranzas |
| GET/POST/PATCH/DELETE | `/clientes` · `/clientes/:id` | ABM de clientes (baja lógica si tienen historial) |
| POST | `/clientes/:id/reactivar` | Revertir una baja lógica |
| GET | `/ventas?clienteId=&sucursalId=&estado=&desde=&hasta=&limit=&incluirItems=` | Comprobantes de venta (límite por defecto 100, máx. 500) |
| GET/POST | `/ventas` · `/ventas/:id` | Crear / ver venta. Con `estado:'borrador'` queda **abierta** (sin número, sin stock, sin caja) |
| PUT | `/ventas/:id` | Reemplazar el contenido de una venta abierta (el POS manda el ticket completo) |
| POST | `/ventas/:id/confirmar` | Emitir: asigna número, descuenta stock y registra los pagos. `tipo:'ticket'` liquida, `tipo:'factura'` emite fiscal (la letra la resuelve el backend) |
| POST | `/ventas/:id/delegar` | Pasar la venta abierta a otro vendedor |
| DELETE | `/ventas/:id` | Descartar una venta abierta |
| GET | `/ventas/cuenta/:clienteId` | Cuenta corriente: saldo, crédito disponible y comprobantes impagos |
| POST | `/ventas/:id/anular` | Anular venta emitida (reingresa stock) |
| GET/POST | `/cobranzas` · `/cobranzas/:id` | Recibos de cobranza con medios de pago e imputaciones |
| POST | `/cobranzas/:id/anular` | Anular recibo (libera las imputaciones) |
| GET | `/ventas/catalogo?sucursalId=&lista=` | Todo lo vendible con precio de cada lista y stock por sucursal (catálogo del POS) |
| GET/PUT | `/configuracion/:clave` | Preferencias por área (`ventas`). El PUT es un merge parcial validado |

### Caja (punto de venta)

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/caja/actual/:sucursalId` | Turno abierto de la sucursal, o `null` |
| GET | `/caja?sucursalId=&estado=&limit=` | Historial de turnos |
| GET | `/caja/:id/arqueo` | Arqueo en vivo: totales por medio, movimientos y efectivo esperado |
| POST | `/caja/abrir` | Abrir turno con fondo inicial (uno solo por sucursal) |
| POST | `/caja/:id/cerrar` | Cerrar con el efectivo contado; calcula y guarda la diferencia |
| POST | `/caja/:id/movimiento` | Ingreso o egreso de dinero (retiros, refuerzo de cambio, **pago a un proveedor**) |

### Administración: gastos y pagos a proveedores

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET/POST/PATCH | `/gastos` · `/gastos/:id` | Comprobantes de gasto (lo que se paga y no es mercadería), imputados a rubro, sucursal y **negocio** (distribuidora/cafetería) |
| POST | `/gastos/:id/anular` · `/gastos/:id/pagar` | Anular / pagar (crea el pago y lo imputa en un paso) |
| GET | `/gastos/cuentas-a-pagar` · `/gastos/resumen` | Vencimientos y resumen por rubro |
| GET/POST/PATCH | `/gastos/categorias` · `/gastos/fijos` | Rubros y gastos fijos recurrentes |
| GET/POST | `/pagos-proveedor` | **El pago es DEL PROVEEDOR, no del documento**: la cajera paga desde su caja (egreso en el arqueo) y el pago queda a cuenta con `destino` mercadería/gastos |
| POST | `/pagos-proveedor/:id/imputar` | Aplicar a facturas de compra o gastos (polimórfico, con CHECK en la base). Aplicar **no vuelve a mover plata** |
| GET | `/pagos-proveedor/disponibles/:proveedorId?destino=` | Pagos a cuenta sin aplicar (la bandeja) |
| POST | `/pagos-proveedor/:id/anular` · PATCH `/:id/destino` | Anular (revierte el egreso si el turno sigue abierto) / corregir la bandeja |
| DELETE | `/pagos-proveedor/imputaciones/:id` | Desaplicar (no mueve plata) |

### Cafetería (puente con coffit)

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET/POST | `/cafeteria/envios` · `/cafeteria/envios/:id` | Envíos y devoluciones **a costo congelado** hacia el otro negocio del dueño (mismo CUIT). Renglones con destino `venta`/`uso` y snapshot (nombre, unidad, códigos) para el import de coffit |
| POST | `/cafeteria/envios/:id/anular` | Revierte el stock con la operación contraria |
| GET | `/cafeteria/resumen?desde=&hasta=` | Mercadería neta + gastos imputados al negocio cafetería = costo del período |

El CRM **no** lleva el stock del café: coffit es el dueño. Estos endpoints son
los que coffit va a leer en la fase de integración por API (con token acotado).

### Tienda y sitio público

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/tienda/catalogo` | Productos publicados con precio y stock (lo consume `sitio-web`) |
| POST | `/tienda/pedidos` | El checkout del sitio crea la **orden web** (aparece con alerta en el CRM) |
| POST | `/tienda/eventos` | Estadísticas propias del sitio |
| GET | `/tienda/imagenes/...` | Imágenes del catálogo |
| GET/PUT | `/web/*` | Administración del sitio desde el CRM (publicados, banners, configuración) |

> Los 4 endpoints de `/tienda` son los **únicos** que quedarán públicos cuando
> la API tenga autenticación (requisito previo al deploy). Con rate-limit
> propio por ruta y `trust proxy` ya activo.

## Arquitectura

- `src/db/schema.ts` — esquema Drizzle (28 tablas). Stock **sin lote**: Producto × Sucursal × Presentación × Estado.
- `src/db/db.module.ts` — pool de PostgreSQL + cliente Drizzle (global).
- `src/inventario/inventario.service.ts` — **motor**: operaciones, transferencias e incidencias, en transacciones. Réplica de la lógica del frontend. `ingresarStockItems` / `egresarStockItems` / `reingresarStockItems` son los ganchos que usan los documentos (comprobantes de compra, ventas).
- `src/{productos,proveedores,sucursales,usuarios,clientes}/` — recursos CRUD.
- `src/ventas/` — comprobantes de venta: tabla propia (numeración del sistema, CAE, libro IVA aparte), cuenta corriente, límite de crédito y catálogo del POS. Las **ventas abiertas** del punto de venta son filas con `estado=borrador`: no consumen numeración (el índice único de `numero` es parcial), no tocan stock y se pueden editar, delegar o descartar. `venta_extras` guarda los cargos que no son mercadería (envío, packaging).
- `src/precios/` — actualización de costos y márgenes. En este sistema el precio de venta NO se edita: se deriva de costo y margen, así que actualizar precios es mover una de esas palancas y dejar que los precios se recalculen. **No hay endpoint de simulación**: el frontend ya tiene costos y márgenes en memoria y previsualiza sin tocar la red; acá solo llegan los cambios aprobados. Todo cambio de costo queda en `producto_proveedor_costos` (append-only), lo que habilita la auditoría y el **deshacer por lote**.
- `src/inventario/pricing.ts` — el único lugar donde se derivan los precios, y donde vive el **redondeo de góndola**: se redondea el precio final **con IVA** (el que ve el cliente) y el neto se deriva hacia atrás. Está acá y no en el POS para que la etiqueta, la caja y el catálogo muestren siempre el mismo número.
- `src/caja/` — turnos del punto de venta. El turno se exige **solo al contado** (es la venta que mueve efectivo); una venta en cuenta corriente no frena por falta de caja pero se cuelga del turno abierto si lo hay.
- `src/cobranzas/` — recibos: N medios de pago + N imputaciones. El saldo de cada comprobante se recalcula **dentro** de la transacción para que dos cajas no cobren la misma factura.
- `src/configuracion/` — un JSON por área con catálogo de defaults; lo que no está en el catálogo se descarta al guardar.
- Prefijo global `/api`, validación con `class-validator`, CORS para el dev del CRM.

### Importes

Los precios se guardan **netos** (sin IVA) y el IVA se suma aparte, tanto en compras como en ventas.
Un solo criterio en todo el sistema evita descuadres de centavos entre los dos circuitos.

## Pendiente / próximos pasos

La lista viva y completa está en el CRM: **Info de sistema › Pendientes**. Los
grandes titulares:

- **Autenticación — BLOQUEANTE del deploy**: sesiones con token en toda la API
  salvo los 4 endpoints públicos de `/tienda`; Node escuchando solo en
  localhost detrás de nginx.
- **Nota de crédito** (compra y venta) con saldo acreditable.
- **Anular comprobante de compra** (debe liberar las imputaciones de pagos).
- **Facturación electrónica ARCA** (estado `pendiente_cae` ya previsto).
- **Cafetería fases 2 y 3**: importador de remitos del lado coffit y conexión
  por API con token acotado + confirmación de recepción.
- Importador masivo del catálogo de WooCommerce (~550 productos).
- Deploy en VPS de Hostinger.
