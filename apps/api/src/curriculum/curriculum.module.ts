// El seam del currículo, ahora módulo propio y EXPORTADO (PRD-007 §7.1).
//
// POR QUÉ EXISTE. `CurriculumRepository` vivía dentro de `TutorModule`, que lo
// declaraba SIN `exports:`, así que era invisible fuera de ese módulo: importar
// `TutorModule` no daba nada y redeclarar el provider daría DOS instancias.
// `EvidenceModule` necesita el mismo repositorio, y la única forma de que sea
// el mismo es que su módulo lo exporte.
//
// El shim `curriculum-context.ts` se traslada CON el repositorio y no se queda
// en `tutor/`: `curriculum.repository.ts` lo importa, y dejarlo atrás pondría a
// `curriculum/` importando de `tutor/`, la flecha contraria a la del diagrama
// de §7. Con el traslado, `tutor.service.ts` importa de aquí y la dirección es
// `TutorModule → CurriculumModule`.
//
// `DrizzleModule` y `ConfigModule` no aparecen: los dos son `@Global()` y
// exportan sus tokens (`DRIZZLE`, `API_CONFIG`).
//
// Regla de código: identificadores en inglés, comentarios en español.

import { Module } from "@nestjs/common";

import { CurriculumRepository } from "./curriculum.repository.ts";

@Module({
  providers: [CurriculumRepository],
  exports: [CurriculumRepository],
})
export class CurriculumModule {}
