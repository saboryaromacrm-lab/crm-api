# Deploy — Sabor y Aroma CRM

Runbook del VPS. Cubre los tres repos porque el servidor es uno solo:

| Repo | Qué es | Cómo corre |
| --- | --- | --- |
| `crm-api` | NestJS + Postgres | servicio systemd |
| `crm-dashboard` | React + Vite | **estático**: nginx sirve `dist/` |
| `saboryaroma-web` | Next.js (tienda) | diferida — puertos reservados, sin scripts todavía |

---

## 1. Tres entornos, no dos

Esto define todo lo demás, así que va primero.

| Entorno | Dónde | Para qué |
| --- | --- | --- |
| **local** | tu máquina (`:3000` + `:3001`) | programar |
| **dev** | VPS, `dev.crm.TUDOMINIO.com` | ensayo general |
| **producción** | VPS, `crm.TUDOMINIO.com` | el negocio |

El dev del VPS **no es** un segundo taller: para eso ya está tu máquina. Existe
para las tres cosas que tu máquina no puede hacer:

1. **Probar el deploy.** Lo que se rompe casi nunca es el código: es una
   variable que falta, una migración que no corre, un build que sale distinto.
2. **Que el equipo pruebe** desde la sucursal, sin riesgo.
3. **Probar migraciones contra datos reales.** Tu base local tiene datos de
   prueba; producción tiene años de historia, y una migración que anda en una
   base limpia puede fallar contra datos viejos.

## 2. El mapa

| | producción | dev |
| --- | --- | --- |
| Carpeta | `/srv/crm/prod/` | `/srv/crm/dev/` |
| Rama | `main` | `dev` |
| Base | `crm_prod` | `crm_dev` |
| Usuario de base | `crm_prod` | `crm_dev` |
| API | `127.0.0.1:3001` | `127.0.0.1:4001` |
| Tienda (futuro) | `127.0.0.1:3002` | `127.0.0.1:4002` |
| Dominio | `crm.TUDOMINIO.com` | `dev.crm.TUDOMINIO.com` |
| Entrada | pública (con login de la app) | `auth_basic` de nginx |

Las dos bases van en el **mismo cluster de Postgres** —ahorra memoria y no hay
razón para dos— pero con **usuario y contraseña distintos**. Eso no es
prolijidad: es el candado contra el accidente clásico, que es un `.env` mal
copiado y un `npm run db:reset` de dev corriendo contra producción. Con
credenciales separadas, dev no *puede* conectarse a prod.

## 3. Antes de publicar nada

- [ ] **Autenticación en la API. BLOQUEANTE.** Hoy no hay login del lado del
      servidor: cualquiera que llegue a la API lee y escribe todo — costos,
      precios, stock, ventas. Las dos etapas publicadas sin esto no son dos
      ambientes, son dos copias del sistema abiertas en internet.
- [ ] `HOST=127.0.0.1` en los dos `.env` del VPS. Sin esto Node escucha en
      todas las interfaces y se lo alcanza en `IP:3001` **saltando nginx**: se
      saltea el TLS y el `X-Forwarded-For` se vuelve falsificable.
      (En local queda `0.0.0.0`: la sync de coffit y las cajas consumen la API
      desde otras máquinas de la red.)
- [ ] Firewall: solo 22, 80 y 443. Ni 3001, ni 4001, ni 5432.
- [ ] `helmet` en la API (todavía falta).
- [ ] Cambiar la contraseña inicial `1234` del usuario Cafetería, en
      **Gerencia › Usuarios y roles**.

## 4. Instalación, una sola vez

```bash
# --- sistema ---
sudo apt update && sudo apt install -y nginx postgresql git curl apache2-utils
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs

# --- usuario propio, sin shell: si alguien entra por la app, no entra al server ---
sudo useradd --system --create-home --shell /usr/sbin/nologin crm

# --- bases y roles (una contraseña distinta por etapa) ---
sudo -u postgres psql <<'SQL'
CREATE ROLE crm_prod LOGIN PASSWORD 'PONER_UNA_LARGA';
CREATE ROLE crm_dev  LOGIN PASSWORD 'OTRA_DISTINTA';
CREATE DATABASE crm_prod OWNER crm_prod;
CREATE DATABASE crm_dev  OWNER crm_dev;
SQL

# --- código ---
sudo mkdir -p /srv/crm/{prod,dev} && sudo chown -R crm:crm /srv/crm
for E in prod dev; do
  R=$([ "$E" = prod ] && echo main || echo dev)
  sudo -u crm git clone -b "$R" https://github.com/saboryaromacrm-lab/crm-api.git       "/srv/crm/$E/crm-api"
  sudo -u crm git clone -b "$R" https://github.com/saboryaromacrm-lab/crm-dashboard.git "/srv/crm/$E/crm-dashboard"
done
```

Después, el `.env` de cada etapa (**nunca en git**):

```bash
# /srv/crm/prod/crm-api/.env
DATABASE_URL=postgres://crm_prod:LA_LARGA@localhost:5432/crm_prod
PORT=3001
HOST=127.0.0.1
CORS_ORIGINS=

# /srv/crm/dev/crm-api/.env
DATABASE_URL=postgres://crm_dev:LA_OTRA@localhost:5432/crm_dev
PORT=4001
HOST=127.0.0.1
CORS_ORIGINS=
```

`CORS_ORIGINS` va **vacío**: el dashboard sale del mismo origen que la API
(nginx la publica en `/api`), así que no hay cruce. Solo se llena si algún día
un cliente externo consume la API desde otro dominio.

Y el resto:

```bash
sudo cp /srv/crm/prod/crm-api/deploy/crm-api@.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable crm-api@prod crm-api@dev

# nginx: copiá los dos .conf, cambiá TUDOMINIO, y después el TLS
sudo htpasswd -c /etc/nginx/.htpasswd-dev equipo
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d crm.TUDOMINIO.com -d dev.crm.TUDOMINIO.com

# el deploy necesita reiniciar SU servicio y nada más
echo 'crm ALL=(root) NOPASSWD: /bin/systemctl start crm-api@*, /bin/systemctl stop crm-api@*, /bin/systemctl restart crm-api@*' \
  | sudo tee /etc/sudoers.d/crm-deploy

# backup diario de producción, 3 de la mañana
echo '0 3 * * * crm /srv/crm/prod/crm-api/deploy/backup.sh prod' | sudo tee /etc/cron.d/crm-backup
```

## 5. El día a día

```bash
# 1. se trabaja en dev (local) y se sube
git push origin dev

# 2. se despliega dev y se mira en dev.crm.TUDOMINIO.com
/srv/crm/dev/crm-api/deploy/deploy.sh dev
/srv/crm/dev/crm-dashboard/deploy/deploy.sh dev

# 3. si está bien, se libera — FUERA DEL HORARIO DE CAJA
git checkout main && git merge --ff-only dev && git push origin main
/srv/crm/prod/crm-api/deploy/deploy.sh prod
/srv/crm/prod/crm-dashboard/deploy/deploy.sh prod
```

`merge --ff-only`: si no puede avanzar derecho es porque alguien commiteó en
`main`, y eso hay que mirarlo, no resolverlo con un merge automático.

**Si producción se rompe:** rama desde `main`, arreglo, merge a `main` **y de
vuelta a `dev`**. Si te olvidás del segundo, el próximo merge de dev revive el
bug.

**La API antes que el dashboard.** El dashboard nuevo puede pedirle a la API
algo que la API vieja no tiene; al revés, la API nueva sigue contestando lo que
el dashboard viejo pide.

## 6. Migraciones: tres reglas que no se negocian

Las migraciones de Drizzle son archivos numerados **más un snapshot encadenado y
un `_journal.json`**.

1. **Nacen solo en `dev`, y de a una.** Dos ramas que agregan `0055_…` generan
   un conflicto que git no puede resolver: el journal y la cadena de snapshots
   no se mergean.
2. **Una migración ya aplicada en producción es inmutable.** Renumerarla o
   editarla rompe la cadena.
3. **`db:migrate` corre todo en UNA transacción.** Bueno: si falla, la base
   queda intacta. Consecuencia: no se puede agregar un valor a un enum y usarlo
   en la misma migración —Postgres no lo permite— hay que recrear el tipo.

`db:seed` y `db:reset` **no existen** en el camino de producción.

## 7. Backups, y el paso que todos se olvidan

`backup.sh` hace el `pg_dump`. Los papeles de facturas viven **dentro de la
base** (`factura_archivos.data`, base64), así que el dump los incluye y la base
crece del orden de **1 GB por año**.

Un dump en el mismo disco que la base **no es un backup**: no cubre el caso más
probable, que es perder el VPS. Falta sacarlo de la máquina (hay un `rclone`
comentado al final del script).

**Y probar el restore.** Un backup no probado es una creencia:

```bash
sudo -u postgres createdb crm_prueba
pg_restore -d crm_prueba --no-owner /var/backups/crm/prod/crm_prod-XXXX.dump
psql crm_prueba -c 'select count(*) from productos, ventas;'
sudo -u postgres dropdb crm_prueba
```

## 8. Cuando algo no anda

```bash
journalctl -u crm-api@prod -n 80 --no-pager   # el log de la API
systemctl status crm-api@prod
sudo nginx -t                                 # sintaxis de nginx
tail -f /var/log/nginx/crm-prod.error.log
```

| Síntoma | Casi siempre es |
| --- | --- |
| 502 en `/api` | el servicio está caído: mirá `journalctl` |
| 413 al subir una factura | falta `client_max_body_size 6m` en ese bloque |
| F5 en `/almacen` da 404 | falta el `try_files … /index.html` |
| La caja carga la versión vieja | `index.html` quedó cacheado |
| El dashboard pega a la API equivocada | alguien puso `VITE_API_BASE_URL` absoluto |
| `dev` escribió en producción | un `DATABASE_URL` mal copiado — revisá los dos `.env` |

## 9. Lo que todavía no está

- Autenticación en la API (**bloqueante**, ver §3).
- `helmet`.
- CI: hoy el deploy se corre a mano por SSH. Cuando esté la autenticación, un
  GitHub Actions con un deploy key por push a `main`/`dev`.
- La tienda (`saboryaroma-web`): puertos y bloque de nginx reservados, sin
  scripts hasta que se despliegue de verdad.
