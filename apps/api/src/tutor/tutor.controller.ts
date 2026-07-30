// `POST /v1/tutor/turn` — la respuesta del tutor en streaming (PRD-005 §5.1).
//
// Autenticado por `SessionGuard`, el mismo de `access.controller.ts` y por el
// mismo canal: **Bearer, nunca cookie**. La identidad sale del token y de ningún
// otro sitio; el `email` del cuerpo, si alguien lo manda, es 400 por
// `forbidNonWhitelisted` y ni siquiera llega aquí.
//
// POR QUÉ `@Res()` Y NO UN INTERCEPTOR DE STREAMING (§Design Decisions): el
// turno tiene que poder escribir la primera respuesta antes de saber si habrá
// una segunda. Con `@Res()` la mecánica es explícita —`setHeader`, `write`,
// `end`— y lo único que se rompe (una excepción con la respuesta ya empezada) lo
// cubre la rama `headersSent` del filtro global. Un interceptor con `Observable`
// escondería exactamente ese caso.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { Body, Controller, HttpCode, HttpStatus, Post, Req, Res, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";

import { type AuthenticatedRequest, SessionGuard } from "../session/session.guard.ts";
import { TUTOR_THROTTLE } from "../throttle.ts";
import { TurnDto } from "./turn.dto.ts";
import { TutorService, type TurnWriter } from "./tutor.service.ts";

// Cota propia, la más baja del servicio: cada petición aquí cuesta una llamada
// FACTURADA a Anthropic. Ver `throttle.ts` para el número y su razón.
//
// La forma es `@Throttle({ default: … })` y no `@Throttle(…)` a secas, que es lo
// que ya usa `billing.controller.ts:56`: el throttler está registrado SIN NOMBRE
// (`app.module.ts:19`), o sea bajo la clave `default`, y un decorador que declare
// otra clave no sobrescribe nada — el endpoint se quedaría con los 120/min
// globales sin que nada se ponga rojo.
@Throttle({ default: TUTOR_THROTTLE })
@Controller("v1/tutor")
@UseGuards(SessionGuard)
export class TutorController {
  constructor(private readonly tutor: TutorService) {}

  // 200, NO EL 201 QUE NEST PONE POR DEFECTO EN UN `@Post()`, y con `@Res()` no
  // basta con no devolver nada: `router-execution-context.js:43` llama a
  // `setStatus(res, httpStatusCode)` ANTES de invocar el handler, así que el 201
  // ya está en la respuesta cuando llega el primer `res.write()`. §5.1 dice 200.
  // Mismo remedio que `access.controller.ts` para `POST /v1/access/trial`.
  @Post("turn")
  @HttpCode(HttpStatus.OK)
  async turn(
    @Req() request: AuthenticatedRequest,
    @Body() turn: TurnDto,
    @Res() response: Response
  ): Promise<void> {
    // `t=0` del goal 9, fijado en la ENTRADA AL HANDLER. Sin ese punto común, la
    // línea base del paso A y esta medida no son la misma magnitud y el corte
    // parecería una mejora que no existe.
    const startedAt = performance.now();

    // BANDERA DE "YA CERRÉ", y es lo que impide abortar un turno completado.
    //
    // Medido en este repositorio contra Express 5 + body-parser: `res` emite
    // `close` en los DOS finales —al terminar bien (justo tras `res.end()`, con
    // `writableEnded === true`) y al irse el cliente (`writableEnded === false`)—
    // así que el evento por sí solo no distingue uno de otro. Sin la bandera se
    // llamaría `abort()` sobre un turno ya entregado y ya persistido. Fila 10 de
    // §9, que además exige esperar al `close` REAL: comprobarlo antes la haría
    // pasar por vacuidad.
    //
    // DESVIACIÓN DECLARADA respecto a la letra de §5.4, que dice `req.on("close")`:
    // desde Node 16 `IncomingMessage` emite `close` cuando la PETICIÓN se ha
    // completado, no cuando cae el socket. Medido aquí: para este POST con cuerpo
    // JSON dispara a los 0 ms, en cuanto body-parser termina de leer, o sea
    // ANTES del primer token. Atado ahí, la bandera todavía estaría en `false` y
    // se abortaría el stream de Anthropic en TODOS los turnos. El evento que
    // tiene la semántica que §5.4 describe —"también dispara al terminar con
    // normalidad"— es el de `res`.
    let finished = false;
    const abandoned = new AbortController();
    response.on("close", () => {
      if (finished) return;
      abandoned.abort();
    });

    // Las cabeceras se ponen al escribir el primer byte, no al entrar: un 403 o
    // un 500 salen por el filtro global, y `res.json()` de Express NO sobrescribe
    // un `Content-Type` ya puesto — un error acabaría etiquetado `text/plain`.
    //
    // Y NO HAY `res.flushHeaders()`, que es una omisión DECIDIDA y no un olvido.
    // Node retiene las cabeceras hasta el primer `write()`, así que sin ese
    // flush explícito las cabeceras y el primer `text_delta` salen juntos.
    // Medido aquí con un primer token a 400 ms: sin flush, cabeceras y primer
    // chunk a los 436 ms; con flush, cabeceras a los 6 ms y primer chunk a los
    // 407 ms.
    //
    // Lo que decide es que `flushHeaders()` pone `headersSent` a `true` AL
    // INSTANTE, y §5.4 ata a esa bandera la rama del filtro global. Con el flush,
    // un fallo entre la cabecera y el primer delta saldría por `destroy()`
    // —conexión cortada, sin cuerpo— y §5.1 dice lo contrario para ese caso
    // exacto: "500 | Fallo inesperado ANTES del primer byte | {statusCode,
    // message} del filtro global", que es lo que prueba la fila 6 de §9. La
    // línea divisoria del PRD es el primer BYTE, no la cabecera lógica.
    //
    // Y HAY UNA CONSECUENCIA PEOR, comprobada poniendo el flush aquí y corriendo
    // la suite: **el muro de pago deja de funcionar**. `ensureTrial` corre DENTRO
    // de `runTurn`, así que con las cabeceras ya enviadas el `200` viaja por el
    // cable antes de saber si hay acceso; la `ForbiddenException` de §5.1 llega
    // al filtro con `headersSent` en `true` y sale como conexión cortada sobre
    // una respuesta que el cliente ya leyó como 200. Las filas 16 y 18 se ponen
    // rojas con `expected 200 to be 403`, y `chat-client.tsx:110-114` —que lee el
    // 403 para pintar el aviso de suscripción— mostraría una respuesta vacía del
    // tutor a quien no ha pagado. Cuatro filas de §9 lo vigilan: 5, 6, 16 y 18.
    //
    // CONSECUENCIA QUE HAY QUE SABER, y que cruza a §5.3: el `fetch` del proxy
    // resuelve cuando llegan las CABECERAS, así que `TUTOR_TIMEOUT_MS` mide de
    // hecho "hasta el primer token" y no "hasta que apps/api empieza a
    // responder". Con 10 000 ms de defecto y `max_tokens: 1024` sobra, pero
    // quien baje ese número estaría acortando el presupuesto de Anthropic, no el
    // del transporte.
    let started = false;
    const begin = (): void => {
      if (started) return;
      started = true;
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
    };

    const writer: TurnWriter = {
      write(text) {
        begin();
        response.write(text);
      },
      end() {
        // El orden importa: la bandera ANTES de `end()`, porque `close` puede
        // emitirse en cuanto la respuesta se cierra.
        finished = true;
        // Un turno sin un solo `text_delta` sigue siendo un 200 con las
        // cabeceras de §5.1, no un 200 con las de por defecto.
        begin();
        response.end();
      },
    };

    await this.tutor.runTurn(request.user, turn, writer, {
      startedAt,
      signal: abandoned.signal,
    });
  }
}
