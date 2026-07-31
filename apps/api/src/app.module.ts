// Regla de código: identificadores en inglés, comentarios en español.

import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerModule } from "@nestjs/throttler";

import { BridgeThrottlerGuard } from "./common/bridge-throttler.guard.ts";
import { DEFAULT_THROTTLE, EVIDENCE_OUTBOUND_THROTTLE } from "./throttle.ts";
import { AccessModule } from "./access/access.module.ts";
import { AnalyticsModule } from "./analytics/analytics.module.ts";
import { BillingModule } from "./billing/billing.module.ts";
import { ConfigModule } from "./config.module.ts";
import { DrizzleModule } from "./db/drizzle.module.ts";
import { EvidenceModule } from "./evidence/evidence.module.ts";
import { HealthController } from "./health/health.controller.ts";
import { SessionModule } from "./session/session.module.ts";
import { TutorModule } from "./tutor/tutor.module.ts";

@Module({
  imports: [
    // DOS throttlers, no uno. El segundo es el eje GLOBAL de salida de PRD-007
    // §5.4 y TIENE QUE ESTAR AQUÍ: una clave nueva en un decorador no
    // sobrescribe nada si el throttler no está registrado, y el endpoint se
    // quedaría con la cota por defecto sin que nada se pusiera rojo — la trampa
    // que `tutor.controller.ts:29-33` ya dejó anotada.
    //
    // Sus otros dos campos load-bearing (`getTracker` y `skipIf`) y los tres
    // modos de fallo silencioso que cubren viven documentados en `throttle.ts`,
    // junto al número. Filas 45 y 46 de §9 lo detectan por los dos lados.
    ThrottlerModule.forRoot([DEFAULT_THROTTLE, EVIDENCE_OUTBOUND_THROTTLE]),
    ConfigModule,
    DrizzleModule,
    AnalyticsModule,
    SessionModule,
    AccessModule,
    BillingModule,
    TutorModule,
    EvidenceModule,
  ],
  controllers: [HealthController],
  // Global y no por controlador: un endpoint nuevo nace acotado en vez de nacer
  // abierto y esperar a que alguien se acuerde. Las excepciones se declaran con
  // decorador donde toca (`@SkipThrottle` en /health, `@Throttle` en el webhook).
  //
  // `BridgeThrottlerGuard` y no `ThrottlerGuard` a secas: contar por IP haría de
  // `/v1/access*` un cubo único para todo el producto, porque el único llamante
  // legítimo es el servidor de Next. Ver el fichero del guard.
  providers: [{ provide: APP_GUARD, useClass: BridgeThrottlerGuard }],
})
export class AppModule {}
