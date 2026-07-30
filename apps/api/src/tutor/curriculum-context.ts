// Costura hacia la composición del bloque de contexto de la raíz (PRD-005 §7).
//
// ponytail: import temporal a la raíz; lo cierra la fase de packages/shared, ver ADR-001 §7
//
// Trae `buildLessonContext` (de `curriculum-context.ts`) más `buildForest` y
// `lessonContextInputs` (de `curriculum-file.ts`). Las tres son el mismo trabajo
// —de filas planas al texto que entra al bloque de system— y viajan juntas por
// eso.
//
// POR QUÉ NO SE COPIA: `buildLessonContext` compone texto que ENTRA AL BLOQUE DE
// SYSTEM, y `CONTRIBUTING.md` indexa la puerta de revisión por destino del
// contenido, no por ruta de fichero. Duplicarlo permitiría que el bloque que
// recibe el tutor derive del que revisa `pnpm curriculum:check`, que mide la
// cota compuesta llamando a esta misma función (`curriculum-file.ts:460-472`).
//
// POR QUÉ NO SE RE-EXPORTA `src/lib/curriculum.ts`, que es donde vive la
// consulta: importa `./db.ts` (`curriculum.ts:11`) y traerlo abriría un TERCER
// pool de Postgres dentro de este proceso. La consulta se duplica —unas 15
// líneas en `curriculum.repository.ts`, con el `DRIZZLE` inyectado— y las
// funciones puras no.
//
// Regla de código: identificadores en inglés, comentarios en español.

export * from "../../../../src/lib/curriculum-context.ts";
export * from "../../../../src/lib/curriculum-file.ts";
