# Deploy — Sabor y Aroma CRM (Dokploy)

Runbook del VPS: **Ubuntu 24 + Dokploy**, o sea Docker por abajo y **Traefik**
como única puerta de entrada.

| Repo | Qué es | Cómo corre |
| --- | --- | --- |
| `crm-api` | NestJS + Postgres | contenedor Node (`Dockerfile` en la raíz) |
| `crm-dashboard` | React + Vite | contenedor nginx con el `dist/` adentro |
| `sitio-web` | Next.js (tienda) | **fuera de esta ronda** |

> **Sobre los archivos vecinos.** `crm-api@.service`, `nginx-crm-prod.conf`,
> `nginx-crm-dev.conf` y `deploy.sh` son del **otro** camino: Node como proceso
> del host, con nginx delante. No se usan con Dokploy y quedan porque describen
> una instalación válida. Si algún día se vuelve a ese modelo, lo que cambia es
> `TRUST_PROXY` y `HOST` (ver §3).

---

## 1. El mapa

Con Dokploy, un **proyecto** agrupa los servicios. Para esta ronda son tres:

| Servicio | Tipo en Dokploy | Rama | Puerto interno |
| --- | --- | --- | --- |
| base | Database → PostgreSQL | — | 5432 (interno) |
| `crm-api` | Application → Git + Dockerfile | `main` | 3001 |
| `crm-dashboard` | Application → Git + Dockerfile | `main` | 8080 |

**Un solo dominio para los dos**, y el ruteo por path:

```
crm.TUDOMINIO.com/api   →  crm-api:3001
crm.TUDOMINIO.com/      →  crm-dashboard:8080
```

No es capricho: el dashboard pide la API en `/api` **relativo** (el default de
`src/core/config/env.js`). Mismo origen significa cero CORS, y el token de
sesión —que vive en el `localStorage` del navegador— nunca cruza a otro dominio.
La API ya publica todas sus rutas bajo `/api` (`setGlobalPrefix`), así que
Traefik no tiene que reescribir nada: el path que entra es el que la API espera.

## 2. Antes de publicar nada

- [ ] **Las cuatro contraseñas de la semilla.** `db:seed` crea `Lucas`
      (**superadmin**), `Ana`, `Bruno` y `Carla`, todos con **`1234`**. En un
      sistema alcanzable desde internet eso no puede durar ni una hora. Dos
      caminos: no correr la semilla en producción, o correrla y cambiar las
      cuatro desde **Gerencia › Usuarios y roles** antes de publicar el dominio.
- [ ] **`TRUST_PROXY=1`** en la API (§3). Con el default `loopback`, Traefik no
      es reconocido como proxy y el freno del login contaría a todos los
      visitantes como uno solo.
- [ ] **No publicar el puerto de la API al host.** Es la condición que hace que
      `TRUST_PROXY=1` sea seguro. Traefik le llega por la red de Docker; nadie
      más tiene que poder.
- [ ] **Firewall: solo 22, 80 y 443.** Ni 3001, ni 8080, ni 5432.
- [ ] **`BACKUP_REMOTO` configurado** (§6). Sin eso el respaldo vive en el mismo
      disco que la base y no cubre el caso más probable: perder el VPS.
- [ ] **Permisos del servidor, el pase de LECTURA — pendiente conocido.** Los
      siete módulos ya exigen permiso para escribir, y las lecturas están
      cerradas módulo por módulo. Lo que falta es la pasada transversal que
      confirme que ningún `GET` quedó más abierto que su pantalla.
- [ ] **Sucursales por usuario — pendiente conocido.** Hoy el empleado elige su
      sucursal en el login y el servidor **no valida que sea la suya**. Todo el
      candado de "la sucursal la decide el servidor" se apoya en ese dato.

## 3. Las variables de la API

En Dokploy, en el servicio `crm-api` → Environment:

```env
DATABASE_URL=postgres://USUARIO:CLAVE@HOST_INTERNO:5432/BASE
PORT=3001
HOST=0.0.0.0
TZ=America/Argentina/Buenos_Aires
TRUST_PROXY=1
CORS_ORIGINS=
# COFFIT_TOKEN=   (recién cuando se coordine con la cafetería)
```

`HOST_INTERNO` es el que muestra la ficha de la base en Dokploy: los servicios
del proyecto se ven por nombre dentro de la red de Docker. **No** se usa
`localhost` — dentro del contenedor de la API, `localhost` es la API misma.

Las cuatro que importan y por qué:

**`HOST=0.0.0.0`.** Al revés que en el modelo con nginx en el host. Un
contenedor tiene su propia interfaz de red: si Node escuchara solo en su
localhost, Traefik no podría alcanzarlo. Acá la puerta la cierra **no publicar
el puerto**, no el bind.

**`TRUST_PROXY=1`.** Express tiene que saber en quién creer para decir de dónde
viene cada request; de ahí salen el cupo de la tienda y el freno de intentos del
login. El default `loopback` sirve cuando el proxy está en la misma máquina
(127.0.0.1). Traefik **es otro contenedor**, así que con `loopback` no le cree y
`req.ip` queda en la IP interna de la red — idéntica para todos los visitantes.
Con `1`, confía en un salto (Traefik) y toma la IP que Traefik escribió. Nunca
`true`: eso le cree al primer valor de la cadena, que lo escribe el cliente.

**`TZ`.** No es cosmético. El sistema decide "qué vence hoy" y "cuántos días
faltan" con la fecha del proceso. Un VPS nuevo corre en UTC y ahí, pasadas las
21:00 hora argentina, "hoy" ya es mañana para el servidor: lo que vence hoy sale
como vencido y el contador del sidebar cuenta de más. La imagen ya trae `tzdata`
y este default, porque alpine viene **sin** base de zonas horarias y sin ella la
variable se ignora en silencio.

**`CORS_ORIGINS` vacío.** Con dashboard y API en el mismo origen no hay cruce.
Solo se llena si algún día un cliente externo consume la API desde otro dominio.

El dashboard **no lleva variables**: las `VITE_*` se hornean en el build, y el
default `/api` es justamente lo correcto acá. Si alguna vez hiciera falta
cambiarlo, no alcanza con reiniciar — hay que reconstruir la imagen.

## 4. Puesta en marcha

1. **Base**: Database → PostgreSQL. Anotá host interno, usuario, clave y nombre.
2. **`crm-api`**: Application → Git (`crm-api`, rama `main`), Build Type
   **Dockerfile**. Cargá las variables de §3. Dominio `crm.TUDOMINIO.com` con
   path `/api`, puerto `3001`, HTTPS con Let's Encrypt. **No** publiques el
   puerto al host.
3. **`crm-dashboard`**: Application → Git (`crm-dashboard`, rama `main`), Build
   Type **Dockerfile**. Mismo dominio con path `/`, puerto `8080`, HTTPS.
4. **Deploy de la API primero.** Al arrancar corre las migraciones sola (§5) y
   recién después escucha. Verificá `https://crm.TUDOMINIO.com/api/health` →
   `{"status":"ok",…}`.
5. **Deploy del dashboard.** Entrá, y **probá recargar con F5 parado en una
   pantalla interna** (`/gastos`): tiene que seguir ahí, no dar 404. Eso prueba
   el `try_files` del `nginx.conf`.
6. **La semilla, si va**: `db:seed` desde una consola en el contenedor de la
   API, y acto seguido las cuatro contraseñas (§2).

**La API antes que el dashboard, siempre.** Un dashboard nuevo puede pedirle a
la API vieja algo que no existe; al revés, la API nueva sigue contestando lo que
el dashboard viejo pide.

## 5. Migraciones

**Corren solas al arrancar el contenedor**, antes de que la API escuche
(`CMD` del Dockerfile: `migrate && main`). Si una falla, el proceso no arranca y
el contenedor queda en rojo — que es lo que se quiere: una API sirviendo contra
un esquema viejo devuelve errores raros repartidos por todas las pantallas y
nadie los relaciona con el deploy.

Tres reglas que no se negocian:

1. **Nacen solo en `dev`, y de a una.** Dos ramas que agregan `0064_…` generan
   un conflicto que git no puede resolver: el `_journal.json` y la cadena de
   snapshots no se mergean.
2. **Una migración ya aplicada en producción es inmutable.** Renumerarla o
   editarla rompe la cadena.
3. **Todo corre en UNA transacción.** Bueno: si falla, la base queda intacta.
   Consecuencia: no se puede agregar un valor a un enum y usarlo en la misma
   migración — hay que recrear el tipo.

`db:reset` **no está en la imagen de producción**: el Dockerfile lo borra a
propósito.

## 6. Respaldos

El respaldo semanal del hosting es del servidor entero y es **semanal**: perder
una semana de ventas no es una opción. `backup.sh` hace el `pg_dump` diario.

Con Dokploy la base vive en un contenedor, así que el script necesita saber
cuál: se le pasa por `DOCKER_DB`. En el VPS, una vez:

```bash
docker ps --format '{{.Names}}' | grep -i postgres     # el nombre del contenedor
rclone config                                          # el remoto (Drive, S3, lo que uses)
```

y después el cron (en `/etc/cron.d/crm-backup`, que **exige el campo de
usuario** — el `root` después de los asteriscos):

```
0 3 * * * root DOCKER_DB=NOMBRE_DEL_CONTENEDOR BACKUP_REMOTO=drive:crm-backups PGDATABASE=BASE PGUSER=USUARIO /ruta/al/backup.sh prod
```

La base crece del orden de **1 GB por año**: los papeles de facturas se guardan
**dentro** de la base (`factura_archivos.data`, en base64) y el dump los
incluye. Por eso el formato es `-Fc` (comprimido), no SQL plano.

El dump es la base **entera**: hashes de contraseña, datos de clientes y los
papeles. El script corre con `umask 077` y deja el directorio en `700`.

Mientras `BACKUP_REMOTO` no esté, cada corrida **avisa por stderr** en vez de
terminar con un "OK" que no dice toda la verdad. Y deja `ultimo-ok.txt` con la
fecha del último respaldo bueno y si salió o no del servidor: sin correo
configurado en el VPS, un cron que falla no le avisa a nadie.

**Y probar el restore.** Un backup no probado es una creencia:

```bash
docker exec -i NOMBRE_DEL_CONTENEDOR createdb -U USUARIO crm_prueba
docker exec -i NOMBRE_DEL_CONTENEDOR pg_restore -U USUARIO -d crm_prueba --no-owner < /var/backups/crm/prod/BASE-XXXX.dump
docker exec -i NOMBRE_DEL_CONTENEDOR psql -U USUARIO -d crm_prueba -c 'select count(*) from productos;'
docker exec -i NOMBRE_DEL_CONTENEDOR dropdb -U USUARIO crm_prueba
```

## 7. El día a día

```bash
# 1. se trabaja en dev y se sube
git push origin dev

# 2. se libera — FUERA DEL HORARIO DE CAJA
git checkout main && git merge --ff-only dev && git push origin main
```

Dokploy despliega solo si tiene el webhook configurado; si no, el botón Deploy.
**La API primero, el dashboard después.**

`merge --ff-only`: si no puede avanzar derecho es porque alguien commiteó en
`main`, y eso hay que mirarlo, no taparlo con un merge automático.

**Si producción se rompe:** rama desde `main`, arreglo, merge a `main` **y de
vuelta a `dev`**. Si te olvidás del segundo, el próximo merge de dev revive el
bug.

## 8. Cuando algo no anda

| Síntoma | Casi siempre es |
| --- | --- |
| El contenedor de la API reinicia en loop | una migración falló: mirá el log, arranca con `migrate` |
| 502 en `/api` | la API está caída o todavía no pasó el healthcheck |
| F5 en `/gastos` da 404 | el `nginx.conf` del dashboard no llegó a la imagen |
| La caja carga la versión vieja | `index.html` quedó cacheado (no debería: va con `no-store`) |
| El dashboard pega a `localhost:3001` | se coló un `.env` en el build — el `.dockerignore` lo excluye |
| El login bloquea a todos juntos | falta `TRUST_PROXY=1` |
| "Vence hoy" aparece como vencido | falta `TZ`, o la imagen quedó sin `tzdata` |
| 413 al subir una factura | el límite de body de Traefik: la API acepta 4 MB |

## 9. Lo que todavía no está

- **La tienda** (`sitio-web`): fuera de esta ronda. Cuando entre, va como tercer
  servicio con su propio dominio, y hay que revisar que su proxy **no**
  concatene `X-Forwarded-For`.
- **CI**: hoy el deploy lo dispara Dokploy por webhook o a mano. No hay tests
  automáticos corriendo antes de publicar.
- **Sucursales por usuario** y el pase de lectura de permisos (§2).
