// El puente de sesión: lo único que decide quién es quien pide.
//
// Cubre las filas 4, 5, 6, 7, 8, 9, 10 y 12 de PRD-003 §9.
//
// Las filas 6, 7 y 8 son de REGRESIÓN y todas dicen lo mismo desde tres
// ángulos: 401, nunca 500. Fallan si alguien sustituye `getToken()` por
// `decode()` a pelo, porque `decode()` LANZA ante secreto equivocado, salt
// equivocado, token corrupto o `exp` vencido.
//
// Regla de código: identificadores en inglés, comentarios en español.

import type { ExecutionContext } from "@nestjs/common";
import { UnauthorizedException } from "@nestjs/common";
import { beforeAll, describe, expect, it } from "vitest";

import { API_CONFIG, resolveApiConfig, type ApiConfig } from "../config.ts";
import {
  type AuthenticatedRequest,
  SessionGuard,
  classifyMissingToken,
} from "./session.guard.ts";
import {
  SECURE_COOKIE_NAME,
  TEST_AUTH_SECRET,
  TEST_COOKIE_NAME,
  applyApiEnv,
  captureOutput,
  sessionToken,
} from "../../test/helpers.ts";

type Headers = Record<string, string>;

function contextFor(headers: Headers): { context: ExecutionContext; request: AuthenticatedRequest } {
  const request = { headers } as unknown as AuthenticatedRequest;
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

let config: ApiConfig;
let guard: SessionGuard;

beforeAll(() => {
  applyApiEnv();
  config = resolveApiConfig();
  guard = new SessionGuard(config);
  // El token de inyección existe para que el guard sea un provider de verdad;
  // aquí se instancia a mano porque no hace falta contenedor.
  expect(API_CONFIG).toBe("API_CONFIG");
});

describe("SessionGuard", () => {
  // -------------------------------------------------------------------------
  // Fila 4 — JWT válido resuelve identidad
  // -------------------------------------------------------------------------
  it("fila 4: un JWT válido resuelve userId y email en request.user", async () => {
    const token = await sessionToken({ id: "user-1", email: "Estudiante@Ejemplo.test", name: "Est" });
    const { context, request } = contextFor({ authorization: `Bearer ${token}` });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toEqual({ userId: "user-1", email: "Estudiante@Ejemplo.test" });
  });

  // -------------------------------------------------------------------------
  // Fila 5 — sin cabecera Authorization
  // -------------------------------------------------------------------------
  it("fila 5: sin cabecera Authorization rechaza con 401 y el cuerpo no dice por qué", async () => {
    const { context, request } = contextFor({});

    const rejection = guard.canActivate(context);
    await expect(rejection).rejects.toBeInstanceOf(UnauthorizedException);
    // El servicio de acceso ni se roza: la identidad nunca llegó al request.
    expect(request.user).toBeUndefined();

    // El código de razón se REGISTRA, nunca se devuelve (§8). Hoy es
    // estructuralmente imposible porque `deny()` lanza `UnauthorizedException()`
    // sin argumentos — pero pasarle el motivo es un cambio de una palabra que
    // convertiría los cuatro códigos en un oráculo público capaz de distinguir
    // "secreto equivocado" de "token caducado" para un llamante anónimo.
    const body = JSON.stringify(
      await rejection.catch((err: UnauthorizedException) => err.getResponse())
    );
    for (const reason of ["missing_header", "malformed", "decode_failed", "missing_claims"]) {
      expect(body).not.toContain(reason);
    }
  });

  // -------------------------------------------------------------------------
  // Fila 6 — secreto incorrecto → 401, NO 500
  // -------------------------------------------------------------------------
  it("fila 6: un token firmado con otro AUTH_SECRET da 401, no 500", async () => {
    const token = await sessionToken(
      { id: "user-1", email: "a@ejemplo.test" },
      { secret: "otro-secreto-completamente-distinto-y-largo" }
    );
    const { context } = contextFor({ authorization: `Bearer ${token}` });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  // -------------------------------------------------------------------------
  // Fila 7 — token caducado → 401, NO 500
  // -------------------------------------------------------------------------
  it("fila 7: un token con exp en el pasado da 401, no 500", async () => {
    // Una hora en el pasado: muy por encima de la tolerancia de reloj de 15 s
    // que aplica `jwtDecrypt`.
    const token = await sessionToken({ id: "user-1", email: "a@ejemplo.test" }, { maxAge: -3600 });
    const { context } = contextFor({ authorization: `Bearer ${token}` });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  // -------------------------------------------------------------------------
  // Fila 8 — salt equivocado → 401, NO 500
  // -------------------------------------------------------------------------
  it("fila 8: un token emitido con el salt __Secure- da 401 al verificarse sin él", async () => {
    // Es el fallo de despliegue MÁS PROBABLE de esta fase (§5.1) y la señal que
    // vigila §10 paso 3: Auth.js elige el prefijo `__Secure-` según el
    // protocolo de la petición, y apps/api no puede verlo.
    const token = await sessionToken(
      { id: "user-1", email: "a@ejemplo.test" },
      { salt: SECURE_COOKIE_NAME }
    );
    const { context } = contextFor({ authorization: `Bearer ${token}` });

    expect(config.authCookieName).toBe(TEST_COOKIE_NAME);
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  // -------------------------------------------------------------------------
  // Fila 9 — token válido sin email
  // -------------------------------------------------------------------------
  it("fila 9: un token válido sin email da 401", async () => {
    // Sin esto, un email ausente llegaría a `eq(subscriptions.email, undefined)`.
    const token = await sessionToken({ id: "user-1" });
    const { context } = contextFor({ authorization: `Bearer ${token}` });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("fila 9: un email vacío tampoco pasa", async () => {
    const token = await sessionToken({ id: "user-1", email: "" });
    const { context } = contextFor({ authorization: `Bearer ${token}` });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  // -------------------------------------------------------------------------
  // Fila 10 — token válido sin id
  // -------------------------------------------------------------------------
  it("fila 10: un token válido sin id da 401", async () => {
    const token = await sessionToken({ email: "a@ejemplo.test" });
    const { context } = contextFor({ authorization: `Bearer ${token}` });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("fila 10: un id vacío tampoco pasa", async () => {
    const token = await sessionToken({ id: "", email: "a@ejemplo.test" });
    const { context } = contextFor({ authorization: `Bearer ${token}` });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  // -------------------------------------------------------------------------
  // Fila 12 — el log de un 401 lleva razón y NO lleva el token
  // -------------------------------------------------------------------------
  it("fila 12: el log del 401 lleva un código de razón y no lleva el token", async () => {
    const token = await sessionToken(
      { id: "user-1", email: "a@ejemplo.test" },
      { secret: "otro-secreto-completamente-distinto-y-largo" }
    );
    const { context } = contextFor({ authorization: `Bearer ${token}` });

    const capture = captureOutput();
    let output: string;
    try {
      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    } finally {
      output = capture.stop();
    }

    expect(output).toContain("reason=decode_failed");
    // El Bearer ES la credencial de sesión (~30 días, sin revocación
    // individual). Todo JWE de Auth.js empieza por `eyJ`.
    expect(output).not.toContain("eyJ");
    expect(output).not.toContain(token);
  });

  it("fila 12: los cuatro códigos de razón salen del clasificador", () => {
    expect(classifyMissingToken({}, TEST_COOKIE_NAME)).toBe("missing_header");
    expect(classifyMissingToken({ authorization: "Basic abc" }, TEST_COOKIE_NAME)).toBe("malformed");
    expect(classifyMissingToken({ authorization: "Bearer" }, TEST_COOKIE_NAME)).toBe("malformed");
    expect(classifyMissingToken({ authorization: "Bearer abc" }, TEST_COOKIE_NAME)).toBe(
      "decode_failed"
    );
    // `getToken()` acepta el token por cookie y la prefiere sobre el Bearer
    // (§5.1): sin cabecera pero con cookie, el fallo no es "falta la cabecera".
    expect(
      classifyMissingToken({ cookie: `${TEST_COOKIE_NAME}=roto` }, TEST_COOKIE_NAME)
    ).toBe("decode_failed");
  });

  it("fila 12: un fallo de forma de claims se registra como missing_claims", async () => {
    const token = await sessionToken({ id: "user-1" });
    const { context } = contextFor({ authorization: `Bearer ${token}` });

    const capture = captureOutput();
    let output: string;
    try {
      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    } finally {
      output = capture.stop();
    }

    expect(output).toContain("reason=missing_claims");
    expect(output).not.toContain("eyJ");
  });

  it("AUTH_SECRET no viaja a la salida por ningún camino de rechazo", async () => {
    // `getToken()` recibe el secreto como argumento, así que cualquier error que
    // lo serializara —o un `logger` que imprimiera los parámetros— lo publicaría
    // en los logs de Railway. Se recorren los cuatro caminos de rechazo, no uno.
    const conSecretoAjeno = await sessionToken(
      { id: "user-1", email: "a@ejemplo.test" },
      { secret: "otro-secreto-completamente-distinto-y-largo" }
    );
    const sinClaims = await sessionToken({ id: "user-1" });

    const requests: Record<string, string>[] = [
      {}, // missing_header
      { authorization: "Basic abc" }, // malformed
      { authorization: "Bearer no-es-un-jwe" }, // decode_failed (token corrupto)
      { authorization: `Bearer ${conSecretoAjeno}` }, // decode_failed (secreto)
      { authorization: `Bearer ${sinClaims}` }, // missing_claims
    ];

    const capture = captureOutput();
    let output: string;
    try {
      for (const headers of requests) {
        await expect(guard.canActivate(contextFor(headers).context)).rejects.toBeInstanceOf(
          UnauthorizedException
        );
      }
    } finally {
      output = capture.stop();
    }

    expect(output).not.toContain(TEST_AUTH_SECRET);
    expect(output).not.toContain("eyJ");
    // Y la salida no está vacía por accidente: los cinco rechazos sí registraron.
    expect(output).toContain("session_guard");
  });
});
