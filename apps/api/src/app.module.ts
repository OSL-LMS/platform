// Regla de código: identificadores en inglés, comentarios en español.

import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerModule } from "@nestjs/throttler";

import { BridgeThrottlerGuard } from "./common/bridge-throttler.guard.ts";
import { DEFAULT_THROTTLE } from "./throttle.ts";
import { AccessModule } from "./access/access.module.ts";
import { AnalyticsModule } from "./analytics/analytics.module.ts";
import { BillingModule } from "./billing/billing.module.ts";
import { ConfigModule } from "./config.module.ts";
import { DrizzleModule } from "./db/drizzle.module.ts";
import { HealthController } from "./health/health.controller.ts";
import { SessionModule } from "./session/session.module.ts";
import { TutorModule } from "./tutor/tutor.module.ts";

@Module({
  imports: [
    ThrottlerModule.forRoot([DEFAULT_THROTTLE]),
    ConfigModule,
    DrizzleModule,
    AnalyticsModule,
    SessionModule,
    AccessModule,
    BillingModule,
    TutorModule,
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
