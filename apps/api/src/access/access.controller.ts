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
import type { Access } from "./access.types.ts";

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
   *  `trial_started`, y un reintento del cliente tras un timeout tampoco. */
  @Post("trial")
  @HttpCode(HttpStatus.OK)
  ensureTrial(@Req() request: AuthenticatedRequest): Promise<Access> {
    return this.access.ensureTrial(request.user.email);
  }
}
