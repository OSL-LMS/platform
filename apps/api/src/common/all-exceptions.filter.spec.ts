// La rama `headersSent` del filtro global (PRD-005 §5.4).
//
// Cubre la fila 30 de PRD-005 §9.
//
// POR QUÉ ES UNITARIO Y NO E2E: lo que la fila afirma es una NEGACIÓN —"no llama
// a `status()` ni a `json()`"— y desde fuera del proceso las dos rutas son
// indistinguibles, porque en las dos el cliente ve la conexión cortada. El
// segundo error de Express (`ERR_HTTP_HEADERS_SENT`) nace DENTRO del manejador
// del primero y no llega a nadie. Aquí se ve; por el cable, no.
//
// Regla de código: identificadores en inglés, comentarios en español.

import type { ArgumentsHost } from "@nestjs/common";
import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { captureOutput } from "../../test/helpers.ts";
import { AllExceptionsFilter } from "./all-exceptions.filter.ts";

function responseDouble(headersSent: boolean) {
  const json = vi.fn();
  const response = {
    headersSent,
    status: vi.fn(() => ({ json })),
    json,
    destroy: vi.fn(),
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;
  return { response, json, host };
}

const filter = new AllExceptionsFilter();

/** Corre el filtro capturando la salida real de stdout/stderr. Lo que §8.3
 *  prohíbe es que el turno llegue a los logs, venga de donde venga. */
function catchWithOutput(exception: unknown, host: ArgumentsHost): string {
  const capture = captureOutput();
  try {
    filter.catch(exception, host);
  } catch (err: unknown) {
    // El filtro es lo último que atiende una petición: si lanzara, no habría
    // nadie detrás. Se restaura la salida antes de propagarlo para no dejar
    // `process.stdout.write` parcheado en el resto del fichero.
    capture.stop();
    throw err;
  }
  return capture.stop();
}

describe("AllExceptionsFilter con la respuesta ya empezada", () => {
  // -------------------------------------------------------------------------
  // Fila 30 — `headersSent` registra y destruye
  // -------------------------------------------------------------------------
  it("fila 30: con headersSent registra y destruye, sin tocar status() ni json()", () => {
    const { response, json, host } = responseDouble(true);
    const boom = new Error("el turno del estudiante decía: hola tutor");
    boom.name = "TutorStreamError";

    const output = catchWithOutput(boom, host);

    expect(response.destroy).toHaveBeenCalledTimes(1);
    // Éstas son la fila: sin la rama nueva, el filtro llamaría a las dos sobre
    // una respuesta ya empezada y Express lanzaría un segundo error dentro del
    // manejador del primero.
    expect(response.status).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();

    // Y se registra bajo las reglas de §8: `name` sí, `message` nunca.
    expect(output).toContain("name=TutorStreamError");
    expect(output).not.toContain("hola tutor");
    expect(output).not.toContain("message=");
  });

  it("fila 30: una HttpException a mitad de stream TAMBIÉN se registra", () => {
    // Es la única excepción a "las HttpException no se registran", y por eso la
    // rama `headersSent` va ANTES de la comprobación de tipo: con la respuesta ya
    // empezada, el cliente no recibe ningún cuerpo que las nombre, así que sin
    // esta línea serían invisibles.
    const { response, json, host } = responseDouble(true);

    const output = catchWithOutput(new ForbiddenException({ error: "Subscription required" }), host);

    expect(response.destroy).toHaveBeenCalledTimes(1);
    expect(json).not.toHaveBeenCalled();
    expect(output).toContain("name=ForbiddenException");
  });

  it("el `code` de la causa sí viaja: es lo que hace diagnosticable el corte", () => {
    const { host } = responseDouble(true);
    const err = new Error("da igual");
    err.name = "AggregateError";
    (err as Error & { cause?: unknown }).cause = { code: "ECONNRESET" };

    expect(catchWithOutput(err, host)).toContain("code=ECONNRESET");
  });
});

describe("AllExceptionsFilter sin cabeceras enviadas (control)", () => {
  // Sin este contraste la fila de arriba pasaría igual con un filtro que
  // destruyera SIEMPRE, que es un fallo peor: todo 401 y todo 403 dejarían de
  // tener cuerpo.
  it("con headersSent en false conserva el camino de siempre", () => {
    const { response, json, host } = responseDouble(false);

    filter.catch(new ForbiddenException({ error: "Subscription required" }), host);

    expect(response.destroy).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({ error: "Subscription required" });
  });

  it("y un error inesperado sigue saliendo como 500 con cuerpo estándar", () => {
    const { response, json, host } = responseDouble(false);

    filter.catch(new Error("fallo raro"), host);

    expect(response.destroy).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ statusCode: 500, message: "Internal Server Error" });
  });
});
