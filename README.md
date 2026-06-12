# Tutor app (v0)

App web del tutor IA socrático de la escuela. Un chat sobre **Claude Sonnet 4.6** con el system prompt certificado (v0.2, 30/30 en el banco de evals). El tutor guía sin dar la respuesta.

> Esta es la v0: **chat + el tutor**. Login, gate de pago (Paddle) y persistencia llegan en los siguientes micro-pasos. Ver la spec en la bóveda: `30 Producto/Stack de la app del tutor.md`.

## Stack

- **Next.js (App Router) + TypeScript** — frontend y API en un solo proyecto.
- **`@anthropic-ai/sdk`** — Sonnet 4.6 con streaming; la clave vive **solo en el servidor**.
- Pensado para desplegar en **Railway** (`output: "standalone"`, `npm start` lee `PORT`).

## Correr en local

```bash
cp .env.example .env.local        # y pon tu ANTHROPIC_API_KEY
npm install
npm run dev                       # http://localhost:3000
```

## Desplegar en Railway

1. Sube este proyecto a un repo de GitHub.
2. En Railway: **New Project → Deploy from GitHub repo**.
3. Variable de entorno: `ANTHROPIC_API_KEY`.
4. Railway detecta Next.js y corre `npm run build` + `npm start`. La app escucha en `PORT` (Railway lo inyecta).

## Estructura

```
src/
  app/
    layout.tsx           # layout raíz
    page.tsx             # UI del chat (streaming)
    globals.css          # estilos
    api/chat/route.ts    # endpoint: llama a Sonnet con streaming
  lib/
    tutor-prompt.ts      # system prompt v0.2 (copia de la bóveda — mantener en sync)
```

## Próximos micro-pasos (ver PPA)

- Auth.js (magic link vía Resend) + Postgres de Railway → tabla `users`.
- Gate de pago: webhook de Paddle → tabla `subscriptions` → pantalla de trial.
- Memoria de conversación → tabla `conversations`.

## Nota de sincronización del prompt

`src/lib/tutor-prompt.ts` es una **copia** del prompt certificado en la bóveda (`90 Activos/tutor-v0/system-prompt.md`). Si cambia allí y pasa el banco de evals, actualiza esta copia. Ningún cambio de prompt se despliega sin pasar el banco.
