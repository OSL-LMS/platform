// Endpoints de acceso. La identidad sale del token y de NINGÚN otro sitio.
//
// EL CONTROL ES ESTRUCTURAL (PRD-003 §5.1, goal 4): ningún parámetro de método
// se liga a entrada del llamante. Estos handlers NO declaran `@Body()`,
// `@Query()` ni `@Param()`, así que el cuerpo y el query string se ignoran por
// completo y `email` solo puede salir de `request.user`, que puebla
// `SessionGuard`.
//
// No es una precaución genérica: las funciones portadas reciben el correo como
// argumento, así que cablear un `@Query('email')` hacia ellas es un error de una
// línea y del todo natural — y daría a cualquier estudiante con sesión válida
// lectura y escritura sobre la fila de suscripción de cualquier otro, siendo
// `subscriptions.email` la llave única. Con la red privada degradada a
// endurecimiento opcional (§1.1), esta es la única defensa. La fila 19 de §9
// existe para eso.
//
// El `ValidationPipe` que monta `main.ts` es defensa en profundidad para DTOs
// FUTUROS: solo actúa sobre parámetros decorados y tipados contra un DTO, así
// que hoy no se ejecuta y no está protegiendo de nada. Quien crea lo contrario
// podría añadir un `@Query() dto` para hacerlo disparar, que es exactamente lo
// opuesto a lo que se quiere.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from "@nestjs/common";

import { type AuthenticatedRequest, SessionGuard } from "../session/session.guard.ts";
import { AccessService } from "./access.service.ts";
import type { Access } from "../../../../packages/shared/src/access.ts";

@Controller("v1/access")
@UseGuards(SessionGuard)
export class AccessController {
  constructor(private readonly access: AccessService) {}

  /** Solo lee. Nunca crea trial: entrar a mirar no gasta la prueba. */
  @Get()
  getAccess(@Req() request: AuthenticatedRequest): Promise<Access> {
    return this.access.getAccess(request.user.email);
  }

  /** Crea el trial si no existe y devuelve el acceso. Idempotente en dos
   *  sentidos: una segunda llamada del usuario no reinserta ni reemite
   *  `trial_started`, y un reintento del cliente tras un timeout tampoco.
   *
   *  SIN LLAMANTE DESDE EL PASO E DE PRD-005 §10, Y SE QUEDA A PROPÓSITO.
   *  Su único consumidor era `fetchAccessTrial()` desde el handler local de
   *  `/api/chat`, que ese paso retiró: hoy el trial lo crea `TutorService` en
   *  proceso, y §8.4 registra que `POST /v1/access/trial` dejó de ser el único
   *  creador de la fila. §10 pedía decidir entre retirarlo o dejar escrito por
   *  qué no; esto es lo segundo, con dos razones:
   *
   *  1. NO CONCEDE NADA NUEVO. Permite a una sesión válida crear SU PROPIO
   *     trial — exactamente lo que ese mismo estudiante consigue mandándole un
   *     mensaje al tutor. La superficie es de más, el privilegio no.
   *  2. RETIRARLO SERÍA DERIVA CONTRA UN DOCUMENTO CONGELADO. Las filas 21 y 22
   *     de PRD-003 §9 lo prueban, y PRD-003 está `Implemented`: borrar el
   *     endpoint borra parte de su plan de pruebas, que es justo lo que la
   *     regla de snapshots frozen existe para no permitir.
   *
   *  Lo que sí queda dicho para el siguiente que pase: si algún día hace falta
   *  recortar superficie de `apps/api`, éste es el primer candidato, y el
   *  trabajo correcto es un PRD que supersede a PRD-003, no un borrado suelto. */
  @Post("trial")
  @HttpCode(HttpStatus.OK)
  ensureTrial(@Req() request: AuthenticatedRequest): Promise<Access> {
    return this.access.ensureTrial(request.user.email);
  }
}
