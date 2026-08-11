#!/usr/bin/env bash
#
# DEPLOY DE LA API — uso: ./deploy.sh prod | dev
#
# Se corre EN EL VPS. Es idempotente: volver a correrlo con el mismo commit no
# cambia nada. Ver DEPLOY.md para la instalación por primera vez.
#
set -euo pipefail

ETAPA="${1:-}"
case "$ETAPA" in
  prod) RAMA=main; RAIZ=/srv/crm/prod ;;
  dev)  RAMA=dev;  RAIZ=/srv/crm/dev  ;;
  *) echo "uso: $0 prod|dev" >&2; exit 2 ;;
esac

APP="$RAIZ/crm-api"
SERVICIO="crm-api@$ETAPA"

cd "$APP"

# El .env vive SOLO en el servidor y no está en git. Sin él, el servicio
# arrancaría sin DATABASE_URL y moriría con un error mucho menos claro.
[ -f .env ] || { echo "FALTA $APP/.env — copiá .env.example y completalo." >&2; exit 1; }

# Con qué commit venía andando: es a lo que se vuelve si la migración falla.
ANTERIOR="$(git rev-parse HEAD)"
echo "== $ETAPA · rama $RAMA · venía en ${ANTERIOR:0:8}"

git fetch --prune origin
git checkout "$RAMA"
# `reset --hard`: el servidor es un DESTINO, no un lugar donde editar. Si
# alguien tocó un archivo acá, el deploy se lo lleva — y está bien que sea así.
git reset --hard "origin/$RAMA"
NUEVO="$(git rev-parse HEAD)"
echo "== ahora en ${NUEVO:0:8}"

if [ "$ANTERIOR" = "$NUEVO" ]; then
  echo "== sin cambios en el código; se recompila igual por si cambió una dependencia"
fi

# `npm ci` y no `install`: instala EXACTAMENTE el package-lock. `install` puede
# resolver una versión nueva y desplegar algo que nunca se probó.
npm ci
npm run build

# ---------------------------------------------------------------------------
# LA MIGRACIÓN, QUE ES LA PARTE DELICADA
#
# Se apaga el servicio ANTES de migrar. Migrar en caliente deja una ventana en
# la que el código viejo habla con el esquema nuevo — en un sistema que corre
# la caja, esa ventana es una venta mal grabada. Diez segundos de corte a la
# noche son más baratos.
#
# `db:migrate` corre todo en UNA transacción: si falla, la base queda intacta.
# Lo que NO queda intacto es el servicio, que quedó apagado — así que si falla
# se vuelve al commit anterior y se levanta con el código que funcionaba.
# ---------------------------------------------------------------------------
echo "== apagando $SERVICIO para migrar"
sudo systemctl stop "$SERVICIO"

if ! npm run db:migrate; then
  echo "" >&2
  echo "!! LA MIGRACIÓN FALLÓ. La base NO se tocó (corre en una sola transacción)." >&2
  echo "!! Volviendo a ${ANTERIOR:0:8} para dejar el servicio andando." >&2
  git reset --hard "$ANTERIOR"
  npm ci && npm run build
  sudo systemctl start "$SERVICIO"
  echo "!! Servicio arriba con el código anterior. Revisá la migración y volvé a intentar." >&2
  exit 1
fi

sudo systemctl start "$SERVICIO"

# Que arrancó no es lo mismo que que ande: systemd da "active" en cuanto el
# proceso vive, aunque no pueda conectarse a la base.
sleep 2
PUERTO="$(grep -E '^PORT=' .env | cut -d= -f2 | tr -d '[:space:]' || true)"
PUERTO="${PUERTO:-3001}"
if curl -fsS --max-time 10 "http://127.0.0.1:$PUERTO/api/sucursales" >/dev/null; then
  echo "== OK: $ETAPA responde en :$PUERTO (${NUEVO:0:8})"
else
  echo "!! El servicio arrancó pero la API no contesta en :$PUERTO" >&2
  echo "!! Mirá el log:  journalctl -u $SERVICIO -n 50 --no-pager" >&2
  exit 1
fi
