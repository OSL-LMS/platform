// Regla de código: identificadores en inglés, comentarios en español.

import { Module } from "@nestjs/common";

import { AnalyticsModule } from "../analytics/analytics.module.ts";
import { SessionModule } from "../session/session.module.ts";
import { AccessController } from "./access.controller.ts";
import { AccessService } from "./access.service.ts";
import { SubscriptionsRepository } from "./subscriptions.repository.ts";

@Module({
  imports: [AnalyticsModule, SessionModule],
  controllers: [AccessController],
  providers: [AccessService, SubscriptionsRepository],
  exports: [AccessService],
})
export class AccessModule {}
