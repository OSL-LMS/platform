// El grafo del tutor (PRD-005 §7).
//
// `AccessModule` se importa porque `ensureTrial` pasa a ser una llamada EN
// PROCESO y ya no un salto por el puente: `AccessModule` exporta `AccessService`
// (`access.module.ts:15`), así que no hace falta declarar nada suyo aquí.
//
// `SessionModule` por el `@UseGuards(SessionGuard)` del controlador — un guard
// referenciado por clase se resuelve del contenedor, así que tiene que ser
// visible desde este módulo.
//
// `CurriculumModule` desde PRD-007 §7.1: `CurriculumRepository` se declaraba
// AQUÍ y sin `exports:`, o sea invisible fuera. Ahora vive en su propio módulo
// y se IMPORTA, no se declara: redeclarar el provider daría dos instancias del
// mismo repositorio, una por módulo.
//
// `DrizzleModule` y `ConfigModule` no aparecen: los dos son `@Global()` y
// exportan sus tokens (`DRIZZLE`, `API_CONFIG`).
//
// Regla de código: identificadores en inglés, comentarios en español.

import { Module } from "@nestjs/common";

import { AccessModule } from "../access/access.module.ts";
import { AnalyticsModule } from "../analytics/analytics.module.ts";
import { CurriculumModule } from "../curriculum/curriculum.module.ts";
import { SessionModule } from "../session/session.module.ts";
import { anthropicClientProvider } from "./anthropic.client.ts";
import { ConversationsRepository } from "./conversations.repository.ts";
import { TutorController } from "./tutor.controller.ts";
import { TutorService } from "./tutor.service.ts";

@Module({
  imports: [AccessModule, AnalyticsModule, CurriculumModule, SessionModule],
  controllers: [TutorController],
  providers: [TutorService, ConversationsRepository, anthropicClientProvider],
})
export class TutorModule {}
