// Regla de código: identificadores en inglés, comentarios en español.

import { Module } from "@nestjs/common";

import { SessionGuard } from "./session.guard.ts";

@Module({
  providers: [SessionGuard],
  exports: [SessionGuard],
})
export class SessionModule {}
