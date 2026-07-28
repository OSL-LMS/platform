// Puente hacia apps/api para el dominio de acceso y cobro (PRD-003 fase 1,
// §5.3). Aquí vive la política de degradación, y sin este módulo la política
// no existe: `fetch` en Node no tiene timeout por defecto, así que un
// apps/api que acepta la conexión y no responde (reinicio de despliegue, pool
// agotado) colgaría el render de /chat indefinidamente en vez de degradar.
//
// El módulo se parte en dos, exactamente en la costura que fija §5.3:
//  - readSessionToken(): lo único que toca `next/headers`. NO testable bajo
//    Node pelado.
//  - fetchAccess() / fetchAccessTrial(): fetch + AbortSignal.timeout + mapeo
//    a Access | {error:true}, más las decisiones puras de status/telemetría
//    de cada call site (resolveClientConfig, resolveSessionCookie,
//    decideTutorTurn). SÍ testables bajo Node pelado — por eso
//    scripts/check-access-bridge.ts importa este fichero por ruta relativa
//    CON extensión (mismo patrón que src/lib/db.ts, ver PRD-002 §9): no
//    necesita nada de Next si recibe el token y la URL como argumentos.
//
// La costura no puede trazarse un paso más arriba, con un `mapResponse` que
// reciba una respuesta ya obtenida: un AbortSignal.timeout que dispara hace
// que `fetch` RECHACE, así que nunca llegaría a `mapResponse`, y el control
// más cargado de esta sección (fila 34 de §9) se quedaría sin verificar por
// ningún lado.
//
// Regla de código: identificadores en inglés, comentarios en español.

import type { Access } from "./access";

export type ApiResult = Access | { error: true };

export type ClientConfig = {
  authCookieName: "authjs.session-token" | "__Secure-authjs.session-token";
  apiBaseUrl: string;
  accessTimeoutMs: number;
};

// Orden importa: §5.1 exige probar el prefijo `__Secure-` PRIMERO. Se usa tal
// cual como orden de iteración en resolveSessionCookie(); resolveClientConfig()
// solo lo usa como conjunto de pertenencia, donde el orden es indiferente.
const VALID_COOKIE_NAMES = [
  "__Secure-authjs.session-token",
  "authjs.session-token",
] as const;

const DEFAULT_ACCESS_TIMEOUT_MS = 2000;

// Configuración de servidor, sin valores por defecto salvo el timeout (§5.3,
// §9 filas 37-38). Se llama al importar el módulo (abajo) y también desde cada
// call site, que ya tiene el `config` delante.
export function resolveClientConfig(): ClientConfig {
  const authCookieName = process.env.AUTH_COOKIE_NAME;
  if (
    !authCookieName ||
    !VALID_COOKIE_NAMES.includes(authCookieName as (typeof VALID_COOKIE_NAMES)[number])
  ) {
    throw new Error(
      'AUTH_COOKIE_NAME debe ser "authjs.session-token" o ' +
        `"__Secure-authjs.session-token" (ver .env.example). Valor actual: ${
          authCookieName ?? "(ausente)"
        }`
    );
  }

  const apiBaseUrl = process.env.API_BASE_URL;
  if (!apiBaseUrl) {
    throw new Error(
      "Falta API_BASE_URL: es obligatoria y no tiene defecto (ver .env.example)."
    );
  }

  const rawTimeout = process.env.ACCESS_TIMEOUT_MS;
  const parsedTimeout = rawTimeout ? Number(rawTimeout) : NaN;
  const accessTimeoutMs =
    Number.isFinite(parsedTimeout) && parsedTimeout > 0
      ? parsedTimeout
      : DEFAULT_ACCESS_TIMEOUT_MS;

  return {
    authCookieName: authCookieName as ClientConfig["authCookieName"],
    apiBaseUrl,
    accessTimeoutMs,
  };
}

// Goal 5: la validación corre AL CARGAR EL MÓDULO, no en la primera petición.
// Si falta una variable, el proceso no llega a levantar y Railway conserva el
// despliegue anterior — en vez de que resolveClientConfig() lance DENTRO del
// render de /chat, donde tumbaría error.tsx para TODOS los estudiantes (rompe
// el goal 8: la política de degradación de fetchAccess no atrapa esto, porque
// {error:true} solo cubre lo que pasa dentro de fetchAccess/fetchAccessTrial).
//
// Aviso: `next build` importa los módulos de página al recolectar datos de
// cada ruta, así que sin API_BASE_URL (o AUTH_COOKIE_NAME) el fallo aparece ya
// en el build, con el mismo mensaje de arriba — es correcto (falla todavía más
// temprano), no un fallo de build misterioso. Por lo mismo,
// scripts/check-access-bridge.ts tiene que fijar las dos variables ANTES de
// importar este módulo.
resolveClientConfig();

// Resuelve la cookie de sesión a partir de un mapa nombre→valor ya extraído
// (así es pura y testable sin next/headers — §9 fila 35). Prueba el prefijo
// `__Secure-` primero.
//
// Dos fallos posibles, y §5.3 exige tratarlos distinto:
//  (a) Cookie TROCEADA (`<nombre>.0`): Auth.js la partió por tamaño. Lanza en
//      vez de reenviar un token truncado, que daría un 401 indistinguible de
//      un fallo de secreto (§11, diferido: el reensamblado no está
//      implementado en esta fase).
//  (b) El nombre resuelto no coincide con `configuredName`: registra
//      ruidosamente y devuelve `{error:true}` — NUNCA lanza, porque "nunca
//      lanza" es lo que sostiene toda la política de degradación de
//      fetchAccess. Saca el desajuste de salt (§5.1, el fallo más probable)
//      del agregado ciego de 401.
export function resolveSessionCookie(
  jar: ReadonlyMap<string, string>,
  configuredName: string
): string | { error: true } {
  for (const name of VALID_COOKIE_NAMES) {
    if (jar.has(`${name}.0`)) {
      throw new Error(
        `La cookie de sesión "${name}" llegó troceada (Auth.js la partió por ` +
          'tamaño); el reensamblado no está implementado en esta fase (PRD-003 ' +
          "§11). Enviar un token truncado daría un 401 indistinguible de un " +
          "fallo de secreto."
      );
    }
    const value = jar.get(name);
    if (value !== undefined) {
      if (name !== configuredName) {
        console.error(
          `api-client: la cookie de sesión resuelta ("${name}") no coincide ` +
            `con AUTH_COOKIE_NAME ("${configuredName}") — descartando token ` +
            "(PRD-003 §5.1, desajuste de salt)."
        );
        return { error: true };
      }
      return value;
    }
  }
  return { error: true };
}

// Lo único de este módulo que toca `next/headers`. Prueba `__Secure-` primero
// y delega toda la decisión en resolveSessionCookie() (§9 fila 35). NO
// testable bajo Node pelado — se verifica manualmente en §10 paso 3.
//
// El import de "next/headers" es DINÁMICO y no estático a propósito: Node
// pelado no resuelve el mapa de `exports` de Next del mismo modo que el
// bundler (comprobado: un `import ... from "next/headers"` estático revienta
// con "Cannot find module" bajo `node scripts/…`). Con el import diferido
// dentro de la función, scripts/check-access-bridge.ts puede importar el
// resto de este fichero (fetchAccess, resolveClientConfig…) sin arrastrar
// next/headers, porque nunca llama a readSessionToken().
export async function readSessionToken(): Promise<string | { error: true }> {
  const { cookies } = await import("next/headers");
  const store = await cookies();
  const jar = new Map(store.getAll().map((c) => [c.name, c.value] as const));
  const { authCookieName } = resolveClientConfig();
  return resolveSessionCookie(jar, authCookieName);
}

function isAccess(body: unknown): body is Access {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.allowed === "boolean" &&
    (b.status === "none" ||
      b.status === "trial" ||
      b.status === "active" ||
      b.status === "canceled") &&
    (b.trialDaysLeft === null || typeof b.trialDaysLeft === "number")
  );
}

// Regla positiva, no enumeración (§5.3): SOLO un 200 cuyo cuerpo valide contra
// `Access` produce un `Access`; todo lo demás, sin excepción —400, 401, 404,
// 413, 5xx, JSON no parseable, o un 200 con forma distinta— es
// `{error:true}`. Nunca lanza: timeout, conexión rechazada o cualquier otro
// fallo de red caen en el mismo `catch`.
async function requestAccess(
  token: string | { error: true },
  baseUrl: string,
  timeoutMs: number,
  path: "/v1/access" | "/v1/access/trial",
  method: "GET" | "POST"
): Promise<ApiResult> {
  if (typeof token !== "string") return { error: true };

  const base = baseUrl.replace(/\/+$/, "");

  try {
    const res = await fetch(`${base}${path}`, {
      method,
      // No reenviamos la cabecera Cookie: tendría precedencia sobre el
      // Bearer dentro de getToken(), abriendo un segundo canal de
      // credencial no declarado (§5.1).
      headers: { Authorization: `Bearer ${token}` },
      // Sin esto, un apps/api que acepta la conexión y no responde colgaría
      // el render de /chat indefinidamente.
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.status !== 200) return { error: true };

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { error: true };
    }

    return isAccess(body) ? body : { error: true };
  } catch {
    // Timeout, conexión rechazada, DNS, o cualquier otro fallo de red.
    return { error: true };
  }
}

// GET /v1/access — solo lee (call site: src/app/chat/page.tsx). Nunca crea
// trial.
//
// `timeoutMs` es obligatorio y viaja como argumento — NUNCA se relee
// `process.env.ACCESS_TIMEOUT_MS` aquí dentro. Antes había dos lecturas
// independientes (esta y la de resolveClientConfig()): coincidían hoy, pero
// el campo que la fila 38 de §9 prueba no era el que el fetch usaba, así que
// un cambio futuro al defecto de resolveClientConfig() se habría quedado sin
// probar en la mitad que de verdad importa. `resolveClientConfig()` es la
// única fuente: los call sites ya tienen `config` delante.
export function fetchAccess(
  token: string | { error: true },
  baseUrl: string,
  timeoutMs: number
): Promise<ApiResult> {
  return requestAccess(token, baseUrl, timeoutMs, "/v1/access", "GET");
}

// POST /v1/access/trial — crea el trial si no existe (call site:
// src/app/api/chat/route.ts).
export function fetchAccessTrial(
  token: string | { error: true },
  baseUrl: string,
  timeoutMs: number
): Promise<ApiResult> {
  return requestAccess(token, baseUrl, timeoutMs, "/v1/access/trial", "POST");
}

export type TutorTurnDecision =
  | { ok: true; access: Access }
  | { ok: false; status: 503 | 403 };

// Decisión de status para POST /api/chat (§5.3, §9 fila 41). Vive junto a
// fetchAccess para que sea pura y testable sin next/headers: un
// `{error:true}` da 503 ANTES de que el call site llegue a emitir
// `tutor_message_sent` — el evento con el que §10 paso 3 lee el embudo, que
// un turno denegado corrompería.
export function decideTutorTurn(result: ApiResult): TutorTurnDecision {
  if ("error" in result) return { ok: false, status: 503 };
  if (!result.allowed) return { ok: false, status: 403 };
  return { ok: true, access: result };
}
