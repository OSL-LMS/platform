# Imagen de apps/api.
#
# Existe porque Railway no honra NIXPACKS_START_CMD para servicios enlazados a
# un repositorio: usa el script `start` del package.json de la RAÍZ, que es
# `next start`. Con dos servicios saliendo del mismo repo, el que sirve la API
# necesita su propio arranque, y un Dockerfile es la única forma de fijarlo por
# servicio sin tocar la configuración del que sirve Next.
#
# Se selecciona con la variable RAILWAY_DOCKERFILE_PATH=apps/api/Dockerfile en
# el servicio `api`. El servicio `tutor-app` no la lleva y sigue con Nixpacks.
#
# El build corre desde la raíz del repositorio, no desde apps/api: las
# dependencias del workspace se resuelven arriba, y apps/api importa
# src/lib/schema.ts de la raíz mientras dure la deuda de PRD-003 (ADR-001 §7).
#
# ponytail: una sola etapa. La imagen carga devDependencies y las dependencias
# del servicio Next que apps/api no usa; a cambio el fichero cabe en una
# pantalla. Si el tamaño o el tiempo de build molestan, la salida es una etapa
# de build separada con `pnpm deploy --filter api` para el runtime.

FROM node:24-slim

WORKDIR /app

RUN corepack enable

# El lockfile y los manifiestos primero: mientras no cambien, Docker reutiliza
# la capa de instalación entre despliegues.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
RUN pnpm install --frozen-lockfile

COPY . .

# Emite a apps/api/dist. El árbol resultante lleva el import cruzado a la raíz,
# así que el entrypoint es dist/apps/api/src/main.js y NO dist/main.js — ver
# PRD-003 §Design Decisions.
RUN pnpm --filter api build

# Railway inyecta PORT; config.ts cae a 3001 si no está.
CMD ["node", "apps/api/dist/apps/api/src/main.js"]
