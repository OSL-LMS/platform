// `POST /v1/evidence` y `GET /v1/evidence` (PRD-007 §5.1 y §5.2).
//
// Los dos tras `SessionGuard`, la única puerta de identidad del servicio. El
// control de "un estudiante no puede tocar la evidencia de otro" es
// ESTRUCTURAL, no una comprobación (§8.1):
//
//  - el `POST` declara `@Body() dto` con exactamente dos campos bajo
//    `forbidNonWhitelisted`, así que un `userId` en el cuerpo es 400;
//  - el `GET` no declara `@Query()` ni `@Param()`: no hay forma de pedir las de
//    otro.
//
// El `user_id` de toda escritura y lectura sale de `request.user`.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";

import { type AuthenticatedRequest, SessionGuard } from "../session/session.guard.ts";
import { EVIDENCE_THROTTLE } from "../throttle.ts";
import { EvidenceDto } from "./evidence.dto.ts";
import { EvidenceService, type EvidenceList } from "./evidence.service.ts";
import type { EvidenceItem } from "../../../../packages/shared/src/evidence.ts";

// EL NOMBRE DE ESTA CLASE ES LOAD-BEARING. El `skipIf` del throttler global de
// salida compara `context.getClass().name` contra el literal
// `"EvidenceController"` (`throttle.ts`), y compara por nombre y no por clase
// para no crear un ciclo de importación con este fichero. Renombrarla sin tocar
// aquello deja el tope de 60/min aplicándose al SERVICIO ENTERO, webhook de
// Paddle incluido — silenciosamente. Fila 46 de §9.
@Controller("v1/evidence")
@UseGuards(SessionGuard)
export class EvidenceController {
  constructor(private readonly evidence: EvidenceService) {}

  // 200, NO EL 201 QUE NEST PONE POR DEFECTO EN UN `@Post()`. Es lo que ya
  // mordió a `access.controller.ts:65` y `tutor.controller.ts:46`. Fila 44.
  //
  // `@Throttle` VA EN EL HANDLER, NO EN LA CLASE. Aplicarlo a la clase, que es
  // lo que hace el único precedente (`tutor.controller.ts:34-37`), daría al
  // `GET` de abajo los 5/min de las escrituras (§5.2). Fila 47 de §9.
  //
  // Y LA FORMA ES `@Throttle({ default: … })`, no `@Throttle(…)` a secas: el
  // throttler por defecto está registrado SIN NOMBRE (`app.module.ts`), o sea
  // bajo la clave `default`, y un decorador que declare otra clave no
  // sobrescribe nada — el endpoint se quedaría con los 120/min globales sin que
  // nada se pusiera rojo.
  @Post()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: EVIDENCE_THROTTLE })
  submit(
    @Req() request: AuthenticatedRequest,
    @Body() dto: EvidenceDto
  ): Promise<EvidenceItem> {
    return this.evidence.submit(request.user, dto);
  }

  /** Las filas DEL PROPIO ESTUDIANTE, bajo la cota global de 120/min. */
  @Get()
  list(@Req() request: AuthenticatedRequest): Promise<EvidenceList> {
    return this.evidence.list(request.user);
  }
}
