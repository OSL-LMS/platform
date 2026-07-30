// Filtro de excepciones GLOBAL. Es el control que cierra la fuga de PII a los
// logs descrita en PRD-003 §8.
//
// Tiene que ser global y no solo del webhook: `getAccess` y `ensureTrial`
// ejecutan las mismas consultas parametrizadas con el correo y NO capturan, así
// que el error se propaga a quien atienda la excepción — que por defecto no es
// código que escriba el implementador y por tanto no es código que piense en
// redactar.
//
// AVISO, y es la trampa: este filtro NO puede extender `BaseExceptionFilter` ni
// delegar en `super.catch()`. Ese es el patrón documentado de NestJS para
// conservar el formato de respuesta, y registra `exception.message` y
// `exception.stack` — o sea, reintroduce exactamente la fuga mientras se cree
// haber cumplido la regla. Filas 31 y 40 de §9 fallan si alguien lo "arregla".
//
// Regla de código: identificadores en inglés, comentarios en español.

import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import type { Response } from "express";
import { STATUS_CODES } from "node:http";

import { causeCode, errorName } from "./error-fields.ts";

/** Estado HTTP que el propio error declara, si declara uno válido.
 *
 *  Existe por la cota de cuerpo de §5.2: body-parser corre como middleware de
 *  Express, ANTES del router de Nest, y su `PayloadTooLargeError` no es una
 *  `HttpException` — llega aquí con `status: 413` en el objeto. Sin esto, la
 *  cota que §5.2 declara como 413 saldría como 500 y la fila 32 de §9 fallaría. */
function declaredHttpStatus(exception: unknown): number | null {
  const candidate = (exception as { status?: unknown; statusCode?: unknown } | null) ?? {};
  const status = typeof candidate.status === "number" ? candidate.status : candidate.statusCode;
  if (typeof status !== "number" || !Number.isInteger(status) || status < 400 || status > 599) {
    return null;
  }
  return status;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    // PRIMERA RAMA, Y TIENE QUE SERLO (PRD-005 §5.4). Con un endpoint de
    // streaming la respuesta puede haber empezado a viajar antes de que aparezca
    // el error: ahí no hay estado que poner ni cuerpo que enviar, porque el
    // cliente ya recibió el 200 y unos cuantos bytes. Sin esto el filtro llamaría
    // a `response.status().json()` sobre una respuesta ya empezada y Express
    // lanzaría un SEGUNDO error dentro del manejador del primero
    // (`ERR_HTTP_HEADERS_SENT`), que ya no atiende nadie.
    //
    // Vive en el filtro y no en el servicio del tutor a propósito: cualquier
    // endpoint de streaming futuro nace cubierto.
    //
    // Y es la ÚNICA excepción a la regla de abajo ("las HttpException no se
    // registran"), por eso va ANTES de esa comprobación: a mitad de un stream son
    // invisibles de cualquier otra forma, porque el cliente no recibe ningún
    // cuerpo que las nombre. Se registran bajo las mismas reglas de §8 de
    // PRD-003 — solo `name` y `cause.code`, nunca `message` ni el objeto.
    if (response.headersSent) {
      this.logger.error(
        `Excepción tras enviar cabeceras: name=${errorName(exception)} code=${causeCode(exception)}`
      );
      // `destroy()` y no `end()`: cortar el socket es la única señal de "esto no
      // está completo" que le queda a un cuerpo sin longitud declarada. Un `end()`
      // limpio le diría al cliente que la respuesta terminó bien.
      response.destroy();
      return;
    }

    // Las HttpException las construimos nosotros con literales sin PII (401 sin
    // cuerpo, "firma inválida", "sin evento"). Se devuelven con su forma y no
    // se registran: son fallos del cliente, esperados, y el SessionGuard ya
    // emite su propio código de razón para los 401 (§8).
    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }

    // Todo lo demás es inesperado. SOLO name y cause.code — nunca message,
    // nunca stack, nunca el objeto.
    this.logger.error(
      `Excepción no controlada: name=${errorName(exception)} code=${causeCode(exception)}`
    );

    // El cuerpo tampoco lleva el mensaje del error: `STATUS_CODES` es el texto
    // estándar del estado y no cuenta nada de la petición.
    const status = declaredHttpStatus(exception) ?? HttpStatus.INTERNAL_SERVER_ERROR;
    response.status(status).json({
      statusCode: status,
      message: STATUS_CODES[status] ?? "Internal Server Error",
    });
  }
}
