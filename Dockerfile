# syntax=docker/dockerfile:1

################################################################################
# CRM API — imagen de producción
# ==============================================================================
# Dos etapas: una compila y la otra corre. La imagen final NO lleva el código
# TypeScript, ni el compilador, ni las dependencias de desarrollo — solo `dist`,
# las migraciones y lo que hace falta para ejecutar.
#
# TRES COSAS QUE SE DECIDEN ACÁ Y SE EXPLICAN ABAJO:
#   1. las migraciones corren al arrancar, antes de escuchar;
#   2. la imagen trae la base de zonas horarias (alpine viene sin ella);
#   3. `reset.js` no viaja.
################################################################################

# ---------------------------- 1) Construcción -------------------------------
FROM node:22-alpine AS builder
WORKDIR /app

# Las dependencias primero y solas. Mientras `package*.json` no cambie, Docker
# reusa esta capa y el deploy no vuelve a bajar node_modules entero.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN npm run build

# ------------------------------ 2) Ejecución --------------------------------
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# LA ZONA HORARIA, Y POR QUÉ ESTÁ ACÁ Y NO SOLO EN LAS VARIABLES DE DOKPLOY.
#
# Un VPS nuevo corre en UTC. El sistema calcula "cuántos días faltan para el
# vencimiento" y "qué gastos vencen hoy" con la fecha del proceso, así que en
# UTC, después de las 21:00 hora argentina, "hoy" ya es mañana para el servidor:
# lo que vence hoy se muestra como "vencido hace un día" y el contador del
# sidebar cuenta de más. Es la misma familia de trampa que el `<input date>`,
# pero del lado del servidor.
#
# `tzdata` es imprescindible: alpine viene SIN base de zonas horarias, y sin
# ella la variable TZ se ignora en silencio y el proceso se queda en UTC. Es el
# peor de los dos mundos — parece configurado y no lo está.
ENV TZ=America/Argentina/Buenos_Aires
RUN apk add --no-cache tzdata

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Las migraciones son DATOS, no código compilado: `drizzle-orm` lee esta carpeta
# en tiempo de ejecución (`migrationsFolder: './drizzle'`). Sin ella la imagen
# compila igual y explota al arrancar.
COPY drizzle ./drizzle

# `reset.js` borra la base entera. Es una herramienta de desarrollo y no tiene
# nada que hacer en la imagen que corre contra los datos reales: se cae del
# `dist` a propósito, para que no exista el día que alguien entre al contenedor
# a mirar algo. `migrate.js` sí queda — es lo que se ejecuta abajo.
RUN rm -f dist/db/reset.js dist/db/reset.js.map

# EL PUNTO DE MONTAJE DE LOS CERTIFICADOS DE ARCA — vacío, y a nombre de `node`.
#
# NO ES UN DETALLE DE PERMISOS, es lo que hace que el volumen funcione. Docker
# crea un volumen nuevo copiando el dueño y el modo de la carpeta que encuentra
# en la imagen; si la carpeta NO existe, el volumen nace de **root** — y el
# proceso corre como `node`, así que generar la clave falla con EACCES. Con
# `/certs` ya creada y de `node`, el volumen hereda eso al montarse la primera
# vez y no hay nada que ajustar a mano en el servidor.
#
# Adentro no va ningún certificado: `.dockerignore` bloquea *.key, *.crt, *.pem
# y `certs/`, y aunque no lo hiciera la imagen se reconstruye entera en cada
# deploy y se los llevaría puestos. Lo único que aporta la imagen es la carpeta.
RUN mkdir -p /certs && chown node:node /certs && chmod 700 /certs

# Sin privilegios: la imagen de node ya trae el usuario `node`.
USER node

EXPOSE 3001

# El chequeo lo usa Dokploy para saber si el contenedor quedó sano. `/api/health`
# es público a propósito (en ese momento todavía no hay ninguna sesión) y no
# dice nada del negocio: solo que el proceso está vivo.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/api/health || exit 1

# LAS MIGRACIONES ANTES DE ESCUCHAR, y encadenadas con `&&` a propósito.
#
# Si una migración falla, el proceso NO arranca y el contenedor queda en rojo.
# Es lo que se quiere: una API sirviendo contra un esquema viejo devuelve
# errores raros repartidos por todas las pantallas, y nadie relaciona eso con un
# deploy. Fallar entero es más ruidoso y mucho más barato de diagnosticar.
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/main.js"]
