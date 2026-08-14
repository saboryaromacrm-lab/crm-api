#!/usr/bin/env bash
#
# BACKUP DE LA BASE — uso: ./backup.sh prod | dev
#
# Va por cron. El backup semanal que regala Hostinger es del servidor entero y
# es SEMANAL: perder una semana de ventas no es una opción.
#
# OJO CON EL TAMAÑO: los papeles de facturas se guardan DENTRO de la base
# (factura_archivos.data, base64), así que el dump los incluye. Con ~30 facturas
# al mes de hasta 2,5 MB, la base crece del orden de 1 GB por año. Por eso el
# formato es `-Fc` (comprimido) y no SQL plano.
#
set -euo pipefail

# EL DUMP ES LA BASE ENTERA: hashes de contraseña de todos los usuarios, el
# DNI/teléfono/dirección de cada cliente y los papeles de facturas. Con el umask
# que hereda de cron (022) quedaba en 644 y lo leía cualquier cuenta del
# servidor —www-data incluido— sin tocar Postgres. 077 = archivos 600 y
# directorios 700, solo para el dueño del cron.
umask 077

ETAPA="${1:-prod}"
case "$ETAPA" in
  prod) BASE=crm_prod; GUARDAR_DIAS=30 ;;
  dev)  BASE=crm_dev;  GUARDAR_DIAS=7  ;;
  *) echo "uso: $0 prod|dev" >&2; exit 2 ;;
esac

# Con Dokploy el nombre de la base lo elegiste al crear el servicio y no tiene
# por qué ser `crm_prod`: `PGDATABASE` lo pisa.
BASE="${PGDATABASE:-$BASE}"

DESTINO="/var/backups/crm/$ETAPA"
mkdir -p "$DESTINO"
# El umask solo alcanza a lo que se CREA: si los directorios venían de antes con
# 755, siguen abiertos. Se cierran los DOS —el padre también— porque con el
# padre abierto se leen los nombres de archivo aunque los dumps no se alcancen.
chmod 700 "$DESTINO" "$(dirname "$DESTINO")"

# UTC en el nombre para que ordene alfabéticamente igual que cronológicamente.
SELLO="$(date -u +%Y%m%d-%H%M)"
ARCHIVO="$DESTINO/$BASE-$SELLO.dump"

# SE ESCRIBE CON OTRO NOMBRE Y RECIÉN AL FINAL SE RENOMBRA.
#
# Si `pg_dump` se corta a la mitad, lo que queda en el disco es un archivo con
# nombre de dump bueno y contenido incompleto. Nadie lo mira hasta el día que
# hace falta restaurar, y ahí ya es tarde. Con el sufijo `.parcial`, un corte
# deja algo que no se puede confundir con un respaldo.
PARCIAL="$ARCHIVO.parcial"

# -Fc = formato custom: comprimido y restaurable con pg_restore tabla por tabla.
#
# DOS CAMINOS SEGÚN DÓNDE VIVA POSTGRES:
#   · sin `DOCKER_DB` — Postgres instalado en el host (el modelo con systemd).
#   · con `DOCKER_DB` — Postgres en un contenedor, que es el caso de Dokploy.
#     Ahí `pg_dump` ni siquiera existe en el host: hay que ejecutarlo ADENTRO y
#     traerse la salida por stdout.
if [ -n "${DOCKER_DB:-}" ]; then
  docker exec -i "$DOCKER_DB" \
    pg_dump -Fc --no-owner --no-privileges -U "${PGUSER:-postgres}" "$BASE" > "$PARCIAL"
else
  pg_dump -Fc --no-owner --no-privileges "$BASE" -f "$PARCIAL"
fi

# Un dump de 0 bytes es peor que ninguno: da la sensación de estar cubierto.
[ -s "$PARCIAL" ] || { echo "!! El dump salió vacío: $PARCIAL" >&2; exit 1; }
mv "$PARCIAL" "$ARCHIVO"
echo "OK $ARCHIVO ($(du -h "$ARCHIVO" | cut -f1))"

find "$DESTINO" -name "$BASE-*.dump" -mtime "+$GUARDAR_DIAS" -delete

# Y los restos de corridas que se cortaron. No los borra la línea de arriba
# —solo mira `*.dump`— así que sin esto se van apilando de a uno por cada noche
# que falle, hasta llenar el disco. Un día de gracia para poder mirarlos si la
# falla fue reciente.
find "$DESTINO" -name '*.parcial' -mtime +1 -delete

# ---------------------------------------------------------------------------
# SACARLO DE LA MÁQUINA. Un dump que vive en el mismo disco que la base no
# protege del caso más probable: que el disco o el VPS se pierdan.
#
# El destino NO está escrito acá porque depende de la cuenta de cada uno: se
# configura una vez con `rclone config` y se pone su nombre en la variable
# BACKUP_REMOTO del entorno del cron. Ejemplo con Postgres en un contenedor
# (Dokploy), que es el caso de este servidor:
#
#   DOCKER_DB=mi-postgres PGUSER=crm PGDATABASE=crm_prod \
#   BACKUP_REMOTO=drive:crm-backups   /ruta/al/backup.sh prod
#
# Y el equivalente con Postgres instalado en el host:
#
#   BACKUP_REMOTO=drive:crm-backups   /srv/crm/prod/crm-api/deploy/backup.sh prod
#
# Mientras la variable no esté, el script AVISA en cada corrida en vez de
# terminar en un "OK" que no dice toda la verdad.
# ---------------------------------------------------------------------------
FUERA=no
if [ -n "${BACKUP_REMOTO:-}" ]; then
  rclone copy "$ARCHIVO" "$BACKUP_REMOTO/$ETAPA/" --no-traverse
  echo "OK copia fuera del servidor: $BACKUP_REMOTO/$ETAPA/"
  FUERA=si
else
  echo "!! AVISO: BACKUP_REMOTO no está configurada — el dump quedó SOLO en este disco." >&2
fi

# TESTIGO: la fecha del último respaldo bueno, en un archivo que se puede mirar
# de un vistazo (y que la sección Respaldos va a leer cuando se construya). Sin
# esto, un cron que falla solo escribe a stderr, y sin correo configurado en el
# VPS ese aviso no llega a nadie: el respaldo se rompe en silencio.
printf 'fecha=%s\narchivo=%s\nfuera_del_servidor=%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ARCHIVO" "$FUERA" > "$DESTINO/ultimo-ok.txt"
