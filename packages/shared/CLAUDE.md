# packages/shared

Los nueve módulos que consumen dos o más paquetes: el esquema Drizzle y el pool, el prompt certificado del tutor, el parser del currículo con su control de URLs, la ventana de contexto, y los tipos de dominio.

Es un sibling propio desde PRD-006, y el que más fácil se malinterpreta.

## No es un paquete de pnpm, y es deliberado

**Sin `package.json`, sin build propio, y fuera de `packages:` en `pnpm-workspace.yaml`.** Es una carpeta de fuentes. La decisión está razonada en PRD-006 § Design Decisions y no se revierte por comodidad:

- Un especificador desnudo rompe `rewriteRelativeImportExtensions` en `apps/api`, que sólo reescribe especificadores **relativos**. Consumir un `dist` precompilado añadiría un tercer paso de build cuyo modo de fallo es un `dist` viejo arrancando el servicio con un esquema desactualizado, sin que nada se ponga rojo.
- `transpilePackages` de Next tampoco sirve: resuelve directorios de paquete con `require.resolve`, y esto no lo es. Por eso `apps/web` usa `experimental.externalDir`.

## Dónde resuelve sus dependencias, que no es donde uno supondría

Un módulo de aquí que importa `pg` resuelve caminando hacia arriba desde **su propia** ubicación: `packages/shared/node_modules` (ausente) → `packages/node_modules` (ausente) → `<repo>/node_modules`. Es decir, **contra el manifiesto de la raíz** — no hereda las del paquete que lo importó.

De ahí que la raíz declare `drizzle-orm`, `pg` y `next-auth` aunque no los use directamente, y con especificador `catalog:` en los tres manifiestos. Quien lea "la carpeta usa las dependencias de quien la importa" concluirá que la raíz ya no las necesita, las quitará, y romperá los builds de los dos servicios. Pasó una vez con `next-auth`, y se descubrió ejecutando.

## Convenciones

- **Identificadores en inglés, comentarios en español.**
- **Imports internos relativos y con extensión `.ts`.** No es estilo: estos módulos se importan desde `scripts/` bajo Node pelado, que no conoce los `paths` de ningún `tsconfig`.
- Quien consume decide cómo: `apps/api` por ruta relativa con extensión, `apps/web` por el alias `@shared/*`, `scripts/` por ruta relativa, `drizzle.config.ts` por ruta de configuración.

## Lo que NO puede hacer

**Importar de `apps/`, en ninguna dirección.** Es la frontera más importante de las tres, porque este código lo cargan los **dos** servicios: un módulo de aquí que alcance `apps/web` arrastra código local de una app al proceso de la otra. Y el accidente probable no es una ruta relativa de cuatro niveles —esa se ve en una revisión— sino el alias `@/lib/x`, que se lee como un import cualquiera y resuelve igual. Lo comprueba `scripts/check-boundaries.ts`.

## Tres archivos que se tocan con cuidado

- **`curriculum-file.ts`** — 575 líneas, y una parte sustancial es el único control que impide que un enlace hostil entre al bloque de system del tutor. `stripUrlNoise`, el `URL_LIKE` con `[/\\]{2}` y la lista cerrada de esquemas peligrosos **hay que pensarlos juntos**: cada carácter que el parser de URL del navegador descarta y el detector no es un bypass. Catorce formas de evasión son casos de prueba en `scripts/check-curriculum.ts`.
- **`tutor-prompt.ts`** — el prompt lo certifica un banco de 35 evals. Ningún cambio se despliega sin pasarlo.
- **`curriculum-context.ts`** — el bloque que acompaña al prompt. Protegido por `CODEOWNERS` en pareja con el anterior, y esa pareja no se separa.

## Dónde vive el resto

- Estado actual de **este** paquete: `docs/SYSTEM_ARTIFACT.md`. Los dominios que cruzan la frontera están partidos: cada mitad vive con el código que la implementa y referencia a la otra por nombre.
- Por qué está construido así: los PRD en `../../../specforge/`, y ADR-001 para la forma general.
