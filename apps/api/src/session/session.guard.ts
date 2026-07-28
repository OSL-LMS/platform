// La ÚNICA puerta de entrada de identidad de apps/api (PRD-003 §7).
//
// Verifica el JWT de sesión de Auth.js con `getToken()` y pone `{ userId, email }`
// en el request. No hay cabecera de identidad, no hay secreto compartido: o el
// token verifica, o la petición es 401 (§8 punto 1).
//
// Regla de código: identificadores en inglés, comentarios en español.

import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { getToken } from "@auth/core/jwt";
import type { Request } from "express";

import { API_CONFIG, type ApiConfig } from "../config.ts";

export type SessionUser = {
  userId: string;
  email: string;
};

export interface AuthenticatedRequest extends Request {
  user: SessionUser;
}

/** Códigos de razón de §8. Se REGISTRAN, nunca se devuelven al cliente: sin
 *  ellos, "vigilar la tasa de 401" (§10 paso 3) es mirar un agregado sin poder
 *  atribuir un pico, y el desajuste de salt —el fallo más probable de esta
 *  fase— es indistinguible de un token caducado. */
export type DenialReason = "missing_header" | "malformed" | "decode_failed" | "missing_claims";

/** Por qué no había token utilizable. Pura: la fila 12 de §9 la ejercita a
 *  través del guard, pero el criterio vive aquí y se lee de un vistazo. */
export function classifyMissingToken(
  headers: { authorization?: string; cookie?: string },
  cookieName: string
): DenialReason {
  const authorization = headers.authorization;

  if (!authorization) {
    // `getToken()` acepta el token por cookie y la PREFIERE sobre el Bearer
    // (§5.1). Nuestro cliente no la manda, pero el servicio está expuesto.
    return (headers.cookie ?? "").includes(`${cookieName}=`) ? "decode_failed" : "missing_header";
  }

  const [scheme, value] = authorization.split(" ");
  if (scheme !== "Bearer" || !value) return "malformed";

  return "decode_failed";
}

@Injectable()
export class SessionGuard implements CanActivate {
  private readonly logger = new Logger(SessionGuard.name);

  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    // `getToken()` y NO `decode()` a pelo: `decode()` devuelve null únicamente
    // si el token es falsy, y ante secreto equivocado, salt equivocado, token
    // corrupto o `exp` vencido `jwtDecrypt` LANZA. Especificarlo pelado
    // convertiría en 500 los casos que el goal 3 exige que sean 401 — incluido
    // el desajuste de salt. `getToken()` envuelve la decodificación en
    // try/catch, devuelve null al fallar y lee la cabecera Bearer por sí mismo.
    //
    // `getToken` solo lee `req.headers`; Express las tipa como
    // `string | string[] | undefined` y Auth.js como `string`, de ahí el cast.
    const token = await getToken({
      req: { headers: request.headers as Record<string, string> },
      secret: this.config.authSecret,
      salt: this.config.authCookieName,
      cookieName: this.config.authCookieName,
    });

    if (!token) {
      return this.deny(
        classifyMissingToken(
          {
            authorization: request.headers.authorization,
            cookie: request.headers.cookie,
          },
          this.config.authCookieName
        )
      );
    }

    // `getToken()` valida `exp`, `nbf` y el tag AEAD; no valida la FORMA de los
    // claims. Sin esto, un `email` ausente llegaría a
    // `eq(subscriptions.email, undefined)` — la invariante que hoy imponen los
    // call sites de Next (chat/route.ts:33, chat/page.tsx:20).
    const { id, email } = token;
    if (typeof id !== "string" || id === "" || typeof email !== "string" || email === "") {
      return this.deny("missing_claims");
    }

    request.user = { userId: id, email };
    return true;
  }

  /** SIEMPRE lanza. Registra el código de razón y NADA más: el Bearer ES la
   *  credencial de sesión (~30 días, sin revocación individual), y una cabecera
   *  `Authorization` la capturan de rutina los loggers de petición (§8). */
  private deny(reason: DenialReason): never {
    this.logger.warn(`401 session_guard reason=${reason}`);
    throw new UnauthorizedException();
  }
}
