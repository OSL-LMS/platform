// El grafo del reconciliador.
//
// `SubscriptionsRepository` SE PROVEE AQUÍ, y PRD-004 §7.1 lo pone en
// `WorkerModule`. Es una divergencia deliberada y la razón es de Nest, no de
// gusto: un provider declarado en `WorkerModule` NO es visible desde
// `ReconcileModule`. La resolución mira los providers del propio módulo, luego
// los `exports` de sus `imports`, y luego los módulos globales — `WorkerModule`
// no es ninguno de los tres desde aquí, así que `ReconcileService` moriría con
// `UnknownDependenciesException` al construir el contenedor. Se declara donde se
// consume; `WorkerModule` no lo repite (dos declaraciones serían dos instancias
// del mismo envoltorio sin estado, que es ruido, no seguridad).
//
// `AnalyticsModule` se importa aquí Y en `WorkerModule`, y eso no duplica nada:
// los módulos de Nest son singletons por contenedor, así que las dos
// importaciones comparten el mismo `AnalyticsService` — y con él el mismo lote
// pendiente de PostHog, que es justo lo que tiene que ocurrir para que
// `onModuleDestroy` lo vacíe una vez al cerrar el contexto (§8.2).
//
// `DrizzleModule` no aparece: es `@Global()` y exporta `DRIZZLE`.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { Module } from "@nestjs/common";

import { SubscriptionsRepository } from "../access/subscriptions.repository.ts";
import { AnalyticsModule } from "../analytics/analytics.module.ts";
import { paddleClientProvider } from "./paddle.client.ts";
import { ReconcileService } from "./reconcile.service.ts";

@Module({
  imports: [AnalyticsModule],
  providers: [ReconcileService, SubscriptionsRepository, paddleClientProvider],
  exports: [ReconcileService],
})
export class ReconcileModule {}
