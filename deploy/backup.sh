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

ETAPA="${1:-prod}"
case "$ETAPA" in
  prod) BASE=crm_prod; GUARDAR_DIAS=30 ;;
  dev)  BASE=crm_dev;  GUARDAR_DIAS=7  ;;
  *) echo "uso: $0 prod|dev" >&2; exit 2 ;;
esac

DESTINO="/var/backups/crm/$ETAPA"
mkdir -p "$DESTINO"

# UTC en el nombre para que ordene alfabéticamente igual que cronológicamente.
SELLO="$(date -u +%Y%m%d-%H%M)"
ARCHIVO="$DESTINO/$BASE-$SELLO.dump"

# -Fc = formato custom: comprimido y restaurable con pg_restore tabla por tabla.
pg_dump -Fc --no-owner --no-privileges "$BASE" -f "$ARCHIVO"

# Un dump de 0 bytes es peor que ninguno: da la sensación de estar cubierto.
[ -s "$ARCHIVO" ] || { echo "!! El dump salió vacío: $ARCHIVO" >&2; exit 1; }
echo "OK $ARCHIVO ($(du -h "$ARCHIVO" | cut -f1))"

find "$DESTINO" -name "$BASE-*.dump" -mtime "+$GUARDAR_DIAS" -delete

# ---------------------------------------------------------------------------
# ESTO TODAVÍA NO ES UN BACKUP.
# Un dump que vive en el mismo disco que la base no protege del caso más
# probable: que el disco o el VPS se pierdan. Falta el paso de sacarlo de la
# máquina — rclone a un Drive, scp a otra máquina, o el object storage que uses.
# Descomentá y completá:
#
# rclone copy "$ARCHIVO" "remoto:crm-backups/$ETAPA/" --no-traverse
# ---------------------------------------------------------------------------
