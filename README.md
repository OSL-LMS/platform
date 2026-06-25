# OSL · platform

Plataforma open source de la escuela **OSL** — una escuela online que forma *developers aumentados por IA* a partir de principiantes absolutos hispanohablantes.

Este repositorio crece hacia el LMS completo de la escuela. Su **primer componente** es el **tutor IA socrático**: un chat sobre **Claude Sonnet 4.6** con un system prompt certificado que *guía sin dar la respuesta* — está diseñado para que el estudiante razone, no para resolverle el ejercicio.

> **Se construye en abierto, y lo construyen los estudiantes.** El código, los issues y el roadmap son públicos a propósito: la propia plataforma es material del curso. Si estás aprendiendo aquí, contribuir es parte de cómo aprendes — lee **[CONTRIBUTING.md](./CONTRIBUTING.md)**.

## Estado

El tutor es una app web funcional de punta a punta: registro → login con magic link → trial de 7 días → chat con el tutor y persistencia → muro de pago al vencer el trial. Es la base sobre la que se irán añadiendo los demás componentes del LMS.

## Stack

- **Next.js (App Router) + TypeScript** — frontend y API en un solo proyecto.
- **`@anthropic-ai/sdk`** — Claude Sonnet 4.6 con streaming; la API key vive **solo en el servidor**.
- **Auth.js v5** — login con magic link vía Resend; sesión JWT (corre en Edge).
- **Drizzle ORM + Postgres** — usuarios, suscripciones y conversaciones.
- **Paddle** — checkout y webhook del gate de pago.
- Pensado para desplegar en **Railway**.

## Correr en local

Requiere **pnpm** (no npm — el proyecto fija `pnpm@11.4.0`) y una Postgres de desarrollo.

```bash
cp .env.example .env.local        # rellena las claves (todas son de servidor)
pnpm install
pnpm db:migrate                   # crea las tablas en tu Postgres
pnpm dev                          # http://localhost:3000
```

Las variables del núcleo (Anthropic, Postgres, Auth.js, Resend) y para qué sirve cada una están documentadas en **`.env.example`** — con eso corre el tutor completo en local. El gate de pago (Paddle) tiene sus propias variables y es **opcional** para desarrollo: sin ellas, todo funciona salvo el checkout. Ninguna clave real se commitea: `.env` y `.env.local` están en `.gitignore`.

## Estructura

```
src/
  app/
    page.tsx                       # landing pública
    chat/page.tsx                  # el tutor (tras login)
    chat-client.tsx                # UI del chat con streaming
    paywall.tsx                    # muro de pago al vencer el trial
    signin/ registro/              # acceso y captación de correo
    precios/ terminos/ ...         # páginas públicas (legal + Paddle)
    api/
      chat/route.ts                # llama a Sonnet con streaming
      auth/[...nextauth]/route.ts  # Auth.js
      paddle/webhook/route.ts      # activa la suscripción al cobrar
  lib/
    tutor-prompt.ts                # system prompt certificado del tutor
    access.ts                      # frontera gratis/pago (trial, gate)
    schema.ts  db.ts  conversations.ts
  auth.ts  auth.config.ts  middleware.ts
```

## Desplegar en Railway

1. Conecta este repo en Railway (**New Project → Deploy from GitHub repo**).
2. Añade un plugin de **Postgres** (inyecta `DATABASE_URL`).
3. Configura el resto de variables de `.env.example` en el servicio.
4. Railway detecta Next.js y usa pnpm (por `packageManager`); la app escucha en `PORT`.

## El prompt del tutor está certificado

`src/lib/tutor-prompt.ts` contiene el system prompt del tutor, certificado contra un banco de evaluaciones (casos de presión donde el tutor *no* debe filtrar la respuesta). **Regla del proyecto:** ningún cambio de prompt o de modelo se despliega sin pasar el banco completo en verde, y toda fuga nueva entra como caso de prueba *antes* del arreglo. Si tu contribución toca el prompt, mira primero [CONTRIBUTING.md](./CONTRIBUTING.md).

## Licencia

[AGPL-3.0](./LICENSE). Puedes usar, estudiar y modificar este código libremente; si lo ofreces como servicio por red, debes publicar tus cambios bajo la misma licencia.
