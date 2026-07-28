// Healthcheck de Railway.
//
// NO consulta Postgres, y es una invariante (PRD-003 §5.2): es el único endpoint
// sin token ni firma, y hacerle verificar la base entregaría a un llamante
// anónimo un viaje a Postgres, vaciando el goal 3. Fila 23 de §9.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { Controller, Get } from "@nestjs/common";

@Controller("health")
export class HealthController {
  @Get()
  check(): { status: "ok" } {
    return { status: "ok" };
  }
}
