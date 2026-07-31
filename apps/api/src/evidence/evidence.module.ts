// El grafo de la evidencia por lección (PRD-007 §7).
//
// `CurriculumModule` se importa —no se redeclara `CurriculumRepository`— porque
// `TutorModule` lo importa también y redeclarar el provider daría DOS instancias
// del mismo repositorio. Es la razón entera de que PRD-007 §7.1 lo sacara de
// `TutorModule` a un módulo propio con `exports:`.
//
// `SessionModule` por el `@UseGuards(SessionGuard)` del controlador: un guard
// referenciado por clase se resuelve del contenedor, así que tiene que ser
// visible desde este módulo.
//
// `AnalyticsModule` NO APARECE, y es una decisión de §8.5, no un olvido. Ver la
// cabecera de `evidence.service.ts`.
//
// `DrizzleModule` y `ConfigModule` tampoco: los dos son `@Global()` y exportan
// sus tokens (`DRIZZLE`, `API_CONFIG`).
//
// Regla de código: identificadores en inglés, comentarios en español.

import { Module } from "@nestjs/common";

import { CurriculumModule } from "../curriculum/curriculum.module.ts";
import { SessionModule } from "../session/session.module.ts";
import { EvidenceController } from "./evidence.controller.ts";
import { EvidenceRepository } from "./evidence.repository.ts";
import { EvidenceService } from "./evidence.service.ts";
import { EvidenceVerifier } from "./evidence-verifier.ts";

@Module({
  imports: [CurriculumModule, SessionModule],
  controllers: [EvidenceController],
  providers: [EvidenceService, EvidenceRepository, EvidenceVerifier],
})
export class EvidenceModule {}
