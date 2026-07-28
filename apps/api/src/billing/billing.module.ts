// Regla de código: identificadores en inglés, comentarios en español.

import { Module } from "@nestjs/common";

import { AccessModule } from "../access/access.module.ts";
import { AnalyticsModule } from "../analytics/analytics.module.ts";
import { BillingController } from "./billing.controller.ts";

@Module({
  imports: [AccessModule, AnalyticsModule],
  controllers: [BillingController],
})
export class BillingModule {}
