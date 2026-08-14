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

**Un subdominio para cada uno** (decidido 14/8/2026):

```
api.saboryaroma.com   →  crm-api:3001        (Path /, Strip Path apagado)
crm.saboryaroma.com   →  crm-dashboard:8080  (Path /)
saboryaroma.com       →  la tienda, cuando entre
```

La alternativa era un solo dominio con la API en `/api`, que ahorra CORS. Se
eligió el subdominio propio porque **la API va a servir a dos frentes**: el
dashboard y, más adelante, la tienda — que vive en el dominio raíz y sería un
origen distinto igual. Mejor una sola regla que dos casos.

Ojo con dos consecuencias, que son las que rompen si se olvidan:

1. **`CORS_ORIGINS` deja de ir vacía.** Tiene que listar el origen del
   dashboard (y el de la tienda cuando entre), o el navegador bloquea cada
   llamada. El token de sesión viaja en `Authorization`, no en una cookie, así
   que cruzar orígenes es seguro; lo que hay que hacer es permitirlo.
2. **El dashboard necesita la URL ABSOLUTA horneada en el build**, vía el Build
   Arg `VITE_API_BASE_URL` (§4). Su default `/api` es relativo y apuntaría a sí
   mismo.

Y el detalle que confunde: la API publica todas sus rutas bajo `/api`
(`setGlobalPrefix`), así que la URL de salud es `api.saboryaroma.com/**api**/health`.
Se ve repetido y está bien. Por eso mismo, **Strip Path va APAGADO**: si Traefik
recorta el prefijo, a la API le llega `/health` y todo devuelve 404, con el
servicio sano y sin una línea de error en los logs.

## 2. Antes de publicar nada

- [ ] **La contraseña de `Lucas`. ES EL PRIMER PASO DESPUÉS DEL PRIMER DEPLOY,
      antes que cualquier otra cosa.**

      La migración `0019_usuarios_roles.sql` crea a **`Lucas`, superadmin, con
      contraseña `1234`**. No es la semilla: es una migración, así que **toda
      base nueva lo tiene**, se corra o no `db:seed`. Y el repositorio es
      público, o sea que el hash y el comentario que dice la contraseña se leen
      desde GitHub. El desplegable del login (`GET /auth/opciones`) es público
      también, así que el nombre de usuario tampoco es secreto.

      En criollo: desde el instante en que la API es alcanzable, cualquiera
      entra como superadmin. Entrá vos primero y cambiala desde **Gerencia ›
      Usuarios y roles**.

      Si además corriste `db:seed`, sumá `Ana`, `Bruno` y `Carla`, con la misma.
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
CORS_ORIGINS=https://crm.saboryaroma.com
# COFFIT_TOKEN=   (recién cuando se coordine con la cafetería)
```

Cuando entre la tienda, se le suma su origen separado por coma y **sin espacios
de más** (se recortan, pero es fácil equivocarse):
`https://crm.saboryaroma.com,https://saboryaroma.com`

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

**`CORS_ORIGINS`.** Con la API en su propio subdominio, cada llamada del
dashboard es de origen cruzado y el navegador la bloquea salvo que la API diga
que ese origen está permitido. Va el origen COMPLETO y con esquema
(`https://crm.saboryaroma.com`), sin barra final.

El dashboard no lleva variables de entorno, pero sí **un Build Arg**:
`VITE_API_BASE_URL=https://api.saboryaroma.com/api`. Las `VITE_*` se hornean al
compilar, así que cambiarlo no es reiniciar el contenedor: es reconstruirlo.
Si el arg no se pasa, el valor queda en **cadena vacía** (el `ENV` del
Dockerfile siempre define la variable), y por eso `env.js` usa `||` y no `??`:
una cadena vacía tiene que contar como "no configurada" y caer al default.

## 4. Puesta en marcha

1. **Base**: Database → PostgreSQL. Anotá host interno, usuario, clave y nombre.
2. **`crm-api`**: Application → Git (`crm-api`, rama `main`), Build Type
   **Dockerfile**. Cargá las variables de §3. Dominio `api.saboryaroma.com`,
   path `/`, **Strip Path apagado**, puerto `3001`, HTTPS con Let's Encrypt.
   **No** publiques el puerto al host.
3. **`crm-dashboard`**: Application → Git (`crm-dashboard`, rama `main`), Build
   Type **Dockerfile**, con el **Build Arg**
   `VITE_API_BASE_URL=https://api.saboryaroma.com/api`. Dominio
   `crm.saboryaroma.com`, path `/`, puerto `8080`, HTTPS.

> **El DNS va antes que el deploy.** Cada subdominio necesita su registro **A**
> apuntando a la IP del VPS *antes* de encender HTTPS: Let's Encrypt valida
> contra el DNS real, y si no resuelve, el certificado no se emite.
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
   Consecuencia: un valor agregado a un enum con `ALTER TYPE … ADD VALUE` **no
   se puede usar como literal de ese enum en ninguna migración posterior**, por
   más que estén en archivos distintos. Para Postgres siguen siendo la misma
   transacción y todavía no está confirmado.

   **Esto no se ve en desarrollo.** Una base que creció migración por migración
   aplicó cada una en su propia corrida, así que el valor sí estaba confirmado.
   Solo aparece levantando la base **desde cero**, que es exactamente lo que
   hace un deploy nuevo. Pasó en el primero (14/8/2026), con la 0046 usando
   `tipo = 'envio_cafeteria'` que la 0035 había agregado.

   La salida barata es comparar como texto (`tipo::text = 'envio_cafeteria'`):
   el literal nunca se convierte al enum y el chequeo no se dispara. La cara es
   recrear el tipo.

   **Antes de cada deploy con migraciones nuevas, probalas desde cero:**

   ```bash
   createdb crm_cero && DATABASE_URL=postgres://…/crm_cero npm run db:migrate
   ```

   Es la única forma de ver lo que va a ver el servidor. Editar una migración
   vieja para esto **no rompe las bases ya migradas**: drizzle decide qué correr
   por la fecha del journal, no por el contenido del archivo (verificado: 63
   migraciones antes y después de la corrección).

4. **La versión de Postgres del servidor tiene que ser la misma que la de
   desarrollo.** Hoy no lo es —18 en la máquina, 16 en el VPS— y esa diferencia
   fue la que escondió el problema de arriba: PostgreSQL 18 permite usar un valor
   de enum recién agregado dentro de la misma transacción, y 16 lo rechaza. Todo
   pasaba en verde en local y fallaba en el deploy. Cualquier par de versiones
   sirve mientras sean **la misma**.

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
