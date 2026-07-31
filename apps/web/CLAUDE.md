# apps/web

La app Next 15 (App Router) + React 19. Sirve las páginas públicas, el registro, el chat del tutor y el lado navegador del checkout de Paddle. **No** contiene lógica de dominio: acceso, cobro y el turno del tutor viven en `apps/api` desde PRD-003 y PRD-005; aquí queda el puente y el proxy.

Es un sibling propio desde PRD-006. Antes era la raíz del repositorio.

## Antes de tocar nada

- **`next.config.mjs` lleva `experimental: { externalDir: true }` y no es opcional.** Sin él, `next build` restringe el loader al directorio de la app y `packages/shared` no entra al grafo: webpack parsea TypeScript como JavaScript y el build muere en el primer `export type`. La razón está en `next/dist/build/webpack-config.js`, en el cálculo de `shouldIncludeExternalDirs`.
- **`tsconfig.json` mapea dos alias**: `@/*` a `./src/*` y `@shared/*` a `../../packages/shared/src/*`. El segundo **sin extensión**, para igualar la convención del primero. Que `next build` compile lo que hay ahí no depende del alias sino de `externalDir`.
- **`output: "standalone"` se construye y no se usa**: el arranque es `next start`, no `node .next/standalone/server.js`. Next avisa de la combinación en cada arranque. Es desperdicio conocido y declarado, no una regresión.

## Convenciones

- **Identificadores en inglés, comentarios en español.** Rige en todo el repositorio.
- **Las comprobaciones son scripts de `assert` bajo Node pelado**, en `scripts/`, sin framework. Node 22+ ejecuta TypeScript directo. Se invocan con las entradas `check:*` de este `package.json`.
- **Node pelado borra los tipos, no los comprueba.** Una invariante de tipos no se puede afirmar en `scripts/`: va como fixture con `@ts-expect-error` que typechequea `next build` — ver `src/lib/analytics.type-test.ts`, que existe para eso y **no lo importa nadie a propósito**.

## Trampas registradas

- **`src/lib/api-client.ts` llama a `resolveClientConfig()` a nivel de módulo**, y esa función lanza sin `AUTH_COOKIE_NAME` o sin `API_BASE_URL`. `next build` importa los módulos de página al recolectar rutas, así que el build **falla** sin las dos. CI las declara como literales no secretos.
- **`src/lib/tutor-turn.ts` arma un guarda en su ámbito de módulo** que impide arrancar este proceso con `ANTHROPIC_API_KEY` en el entorno: esa clave pertenece sólo a `apps/api`. `src/app/api/chat/route.ts` lo importa **por efecto** únicamente para armarlo. Si un refactor deja de importarlo, el guarda pasa a ser una función que nadie ejecuta — lo vigila `scripts/check-secrets.ts`.
- **`/`, `/registro` y `/chat` tienen que seguir siendo dinámicas.** Las dos primeras llaman `connection()` para salir del prerender de build; `/chat` lo es por leer cookies. `curriculumSlug()` lanza sin `CURRICULUM_SLUG`, y el cuerpo de un componente prerenderizado **se ejecuta en build**: una página nueva que lo llame sin salirse del prerender compila en local y falla en CI.
- **Un Client Component no puede importar `@shared/*` por valor.** `packages/shared/src/curriculum.ts` importa `db.ts`, que construye un `Pool` de `pg`. Los imports existentes en componentes `"use client"` son `import type` y tienen que seguir siéndolo; quitar el modificador es "sólo una línea de import" y arrastra la capa de base al bundle. Lo comprueba `scripts/check-boundaries.ts` desde la raíz.
- **El middleware corre en Edge.** No puede importar `pg` ni nada que lo arrastre.

## Fronteras

Importa de `packages/shared` con el alias `@shared/*`. **No puede importar de `apps/api` en ninguna dirección.**

## Dónde vive el resto

- Estado actual de **este** paquete: `docs/SYSTEM_ARTIFACT.md`. Los dominios que cruzan la frontera están partidos: cada mitad vive con el código que la implementa y referencia a la otra por nombre.
- Por qué está construido así: los PRD en `../../../specforge/`.
- Despliegue: Nixpacks desde la raíz del repositorio. Los scripts `build` y `start` de la raíz **delegan** aquí con `pnpm --filter web`; eso es lo que hace que la forma del repo no toque la configuración de Railway.
