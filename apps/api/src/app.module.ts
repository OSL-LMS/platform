// Regla de código: identificadores en inglés, comentarios en español.

import { Module } from "@nestjs/common";

import { AccessModule } from "./access/access.module.ts";
import { AnalyticsModule } from "./analytics/analytics.module.ts";
import { BillingModule } from "./billing/billing.module.ts";
import { ConfigModule } from "./config.module.ts";
import { DrizzleModule } from "./db/drizzle.module.ts";
import { HealthController } from "./health/health.controller.ts";
import { SessionModule } from "./session/session.module.ts";

@Module({
  imports: [ConfigModule, DrizzleModule, AnalyticsModule, SessionModule, AccessModule, BillingModule],
  controllers: [HealthController],
})
export class AppModule {}
