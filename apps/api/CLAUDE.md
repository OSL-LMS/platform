# apps/api

Servicio NestJS. Sirve el dominio de acceso y cobro (`/v1/access*`, webhook de Paddle), el turno del tutor en streaming (`/v1/tutor/turn`), y un segundo entrypoint para el reconciliador que corre por cron.

Es un sibling propio desde PRD-006. Comparte repositorio con `apps/web` y `packages/shared`, pero no comparte stack, runner de tests, sistema de módulos ni artefacto de despliegue con ninguno de los dos.

## Antes de tocar nada

Lee **`tsconfig.json`**. Su encabezado no es documentación, es normativo, y empieza diciendo "NO la 'simplifiques'". Tres cosas son load-bearing y romper cualquiera de ellas da un fallo que no se ve hasta el arranque en producción:

1. `allowImportingTsExtensions` y `rewriteRelativeImportExtensions` van **juntos**. El primero solo da `TS5096` en cuanto hay emit, y aquí hay que emitir porque NestJS necesita `emitDecoratorMetadata`.
2. **No hay `rootDir`, y es a propósito.** El inferido es la raíz del repositorio, así que el árbol emitido es `dist/apps/api/src/main.js` más `dist/packages/shared/src/*.js`. Poner `rootDir: "./src"` da `TS6059` sobre el import cruzado a `packages/shared`. El `CMD` de los dos Dockerfiles depende de esa forma.
3. **`package.json` no declara `"type": "module"`.** Con ESM compila limpio y revienta al arrancar con `SyntaxError` sobre el esquema: `tsc` elige el formato por el `package.json` más cercano al **fuente** y Node por el más cercano a la **salida**, y el import cruzado es donde divergen. Por lo mismo el manifiesto de la raíz tampoco lo declara.

## Convenciones

- **Identificadores en inglés, comentarios en español.** Rige en todo el repositorio.
- **Tests con Vitest**, no con el estilo de asserts de `scripts/`. `unplugin-swc` no es opcional: el transformador por defecto de Vitest no emite metadatos de decorador y sin ellos la DI de NestJS no resuelve ningún provider.
- Los e2e exigen `API_TEST_DATABASE_URL`, abortan si falta y se niegan a correr si coincide con `DATABASE_URL` — comparación sobre la URL **parseada**, no sobre la cadena.
- Cada fichero de test declara en su cabecera qué filas del §9 de su PRD cubre, y cada `it()` lleva el número de fila en el nombre.

## Trampas registradas

- **`Test.createTestingModule().compile()` instala un logger que anula `log` y `warn`.** Un test que capture salida y afirme sobre un `log` está afirmando sobre una cadena vacía, y pasa por vacuidad. Acompaña toda aserción negativa con una positiva que falle si la captura está vacía.
- **Dos variables tumban el arranque a propósito, en direcciones opuestas**: el servicio HTTP se niega a arrancar **con** `PADDLE_API_KEY` presente (`src/config.ts`), y el worker se niega a arrancar **con** `ANTHROPIC_API_KEY` presente (`src/worker-config.ts`). No son higiene: el `CMD` de la imagen equivocada arranca aparentando éxito.
- **El pool de `pg` lleva un listener `error`** (`src/db/drizzle.module.ts`). Sin él, un cliente **ocioso** caído es una excepción no capturada que tumba el proceso — el único camino que no pasa por el filtro global, porque no nace dentro de una petición.

## Fronteras

Puede importar de `packages/shared` **por ruta relativa con extensión**, que es lo que `rewriteRelativeImportExtensions` reescribe al emitir. Un especificador desnudo rompe ese mecanismo.

**No puede importar de `apps/web` en ninguna dirección.** Lo comprueba `scripts/check-boundaries.ts` desde la raíz.

## Dónde vive el resto

- Estado actual de **este** paquete: `docs/SYSTEM_ARTIFACT.md`. Los dominios que cruzan la frontera están partidos: cada mitad vive con el código que la implementa y referencia a la otra por nombre.
- Por qué está construido así: los PRD en `../../../specforge/`.
- Despliegue: `Dockerfile` (servicio HTTP) y `Dockerfile.worker` (cron). La duplicación entre los dos es deliberada y su razón está escrita en el segundo.
