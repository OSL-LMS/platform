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

import type { Access } from "@shared/access";
import type { EvidenceItem } from "@shared/evidence";

export type ApiResult = Access | { error: true };

export type ClientConfig = {
  authCookieName: "authjs.session-token" | "__Secure-authjs.session-token";
  apiBaseUrl: string;
  accessTimeoutMs: number;
  tutorTimeoutMs: number;
};

// Orden importa: §5.1 exige probar el prefijo `__Secure-` PRIMERO. Se usa tal
// cual como orden de iteración en resolveSessionCookie(); resolveClientConfig()
// solo lo usa como conjunto de pertenencia, donde el orden es indiferente.
const VALID_COOKIE_NAMES = [
  "__Secure-authjs.session-token",
  "authjs.session-token",
] as const;

const DEFAULT_ACCESS_TIMEOUT_MS = 2000;

// PRD-005 §5.3. Es otro orden de magnitud que el de acceso y no comparten
// variable a propósito: éste NO acota el turno, acota la espera hasta la
// PRIMERA CABECERA de apps/api. Ver streamTutorTurn() para por qué eso obliga
// a AbortController + clearTimeout y descarta AbortSignal.timeout().
const DEFAULT_TUTOR_TIMEOUT_MS = 10_000;

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

  return {
    authCookieName: authCookieName as ClientConfig["authCookieName"],
    apiBaseUrl,
    accessTimeoutMs: positiveMsOr(
      process.env.ACCESS_TIMEOUT_MS,
      DEFAULT_ACCESS_TIMEOUT_MS
    ),
    tutorTimeoutMs: positiveMsOr(
      process.env.TUTOR_TIMEOUT_MS,
      DEFAULT_TUTOR_TIMEOUT_MS
    ),
  };
}

// Un timeout no numérico, cero o negativo cae al defecto en vez de dejar pasar
// un `AbortController` que aborta al instante (o nunca).
function positiveMsOr(raw: string | undefined, fallback: number): number {
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
// Dos fallos posibles, y los dos degradan igual — ruidosamente y sin lanzar:
//  (a) Cookie TROCEADA (`<nombre>.0`): Auth.js la partió por tamaño. No se
//      reensambla (PRD-003 §11, sigue diferido) y no se reenvía un token
//      truncado, que daría un 401 indistinguible de un fallo de secreto.
//      HASTA PRD-005 ESTA RAMA LANZABA, y era el único `throw` del módulo:
//      dentro del handler de /api/chat eso no es 401, es 500 (PRD-005 §5.3).
//      La condición la puede provocar un TERCERO —la cookie de sesión es
//      host-only, pero un subdominio puede plantar `<nombre>.0` con
//      `Domain=.contextia.io` y ese trozo sí llega al apex—, así que un
//      `throw` aquí es un 500 a demanda. Es preexistente y no lo introduce
//      PRD-005; lo que PRD-005 hace es convertir este módulo en el camino
//      donde duele. Ver §9 fila 38b.
//  (b) El nombre resuelto no coincide con `configuredName`: saca el desajuste
//      de salt (§5.1, el fallo más probable) del agregado ciego de 401.
//
// "NUNCA lanza" es lo que sostiene toda la política de degradación de
// fetchAccess, y ahora la afirmación del párrafo de arriba es cierta entera.
export function resolveSessionCookie(
  jar: ReadonlyMap<string, string>,
  configuredName: string
): string | { error: true } {
  for (const name of VALID_COOKIE_NAMES) {
    if (jar.has(`${name}.0`)) {
      console.error(
        `api-client: la cookie de sesión "${name}" llegó troceada (Auth.js la ` +
          "partió por tamaño); el reensamblado no está implementado (PRD-003 " +
          "§11) — descartando token. Enviar uno truncado daría un 401 " +
          "indistinguible de un fallo de secreto."
      );
      return { error: true };
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




// ---------------------------------------------------------------------------
// PRD-005 §5.3 — el proxy del turno del tutor.
// ---------------------------------------------------------------------------

export type TutorTurnOptions = {
  baseUrl: string;
  /** Espera hasta la PRIMERA CABECERA, no tope del turno. Ver abajo. */
  timeoutMs: number;
  /** `req.signal` del handler: el eslabón navegador → Next de goal 8. */
  clientSignal?: AbortSignal;
};

/**
 * Reenvía el turno a `POST /v1/tutor/turn` y devuelve la respuesta de arriba
 * con el cuerpo **por identidad**. `{error:true}` para todo lo que el handler
 * tiene que traducir a 503 (§9 filas 32-35c).
 *
 * `timeoutMs` y `baseUrl` viajan como argumentos y NUNCA se releen de
 * `process.env` aquí dentro — misma razón escrita en fetchAccess(): si esta
 * función llamara a resolveClientConfig() por dentro, las filas 32-35c dejarían
 * de correr bajo Node pelado.
 *
 * `body` es el cuerpo entrante YA SERIALIZADO. Se reenvía tal cual: la
 * validación de forma es de `turn.dto.ts` (§5.1), y un 400 del `ValidationPipe`
 * es exactamente lo que el cliente tiene que ver.
 */
export async function streamTutorTurn(
  token: string | { error: true },
  body: string,
  options: TutorTurnOptions
): Promise<Response | { error: true }> {
  if (typeof token !== "string") return { error: true };

  const base = options.baseUrl.replace(/\/+$/, "");

  // EL TIMEOUT ES DE CABECERAS, NO DE STREAM, y `AbortSignal.timeout` NO SIRVE
  // para eso. Copiar el patrón de fetchAccess() —`AbortSignal.timeout(ms)`
  // sobre la petición entera— es la lectura natural y produce un fallo
  // silencioso: abortar un `fetch` DESPUÉS de las cabeceras no es un no-op (el
  // algoritmo de la spec termina en "error response's body with error", o sea
  // que rompe el cuerpo a media lectura) y `AbortSignal.timeout()` no devuelve
  // ningún asa con la que desarmarlo. Traducido: con el patrón equivocado,
  // TODO turno que siga emitiendo al vencer TUTOR_TIMEOUT_MS se corta a media
  // frase, y el estudiante ve una respuesta truncada SIN NINGÚN ERROR, porque
  // el navegador ya pintó lo que llegó. Con `max_tokens: 1024` ése no es el
  // caso raro. Tampoco vale `AbortSignal.any([req.signal, timeout])`: la pata
  // del timeout sigue sin poder cancelarse.
  //
  // El `clearTimeout` TRAS EL `await fetch` es el mecanismo entero, y va en las
  // DOS ramas: sin él en el `catch` queda un temporizador vivo abortando un
  // controlador que ya nadie mira.
  const controller = new AbortController();

  // ORDEN DELIBERADO: la comprobación va ANTES de registrar el listener. Un
  // listener sobre una señal YA ABORTADA no dispara, y ése es justo el caso del
  // estudiante que se va entre el auth() y el fetch. Tirantes y cinturón: la
  // cancelación se propaga sola al destruir el stream devuelto (el cuerpo es el
  // socket hacia apps/api), y esto la cubre si esa propagación fallara. Sin
  // ninguno de los dos, el turno abandonado se sigue facturando en Anthropic
  // hasta terminar y el único síntoma es la factura (goal 8).
  if (options.clientSignal?.aborted) controller.abort();
  options.clientSignal?.addEventListener("abort", () => controller.abort());

  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const upstream = await fetch(`${base}/v1/tutor/turn`, {
      method: "POST",
      // LAS CABECERAS SE CONSTRUYEN, NO SE COPIAN, y el conjunto saliente es
      // EXACTAMENTE éste. Esparcir las cabeceras entrantes para dejar pasar un
      // Accept-Language o una traza se lleva la Cookie de paso —tendría
      // precedencia sobre el Bearer dentro de getToken(), abriendo un segundo
      // canal de credencial no declarado (§5.1)— y también el X-Forwarded-For
      // del cliente hacia un servicio con `trust proxy` puesto.
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body,
      signal: controller.signal,
      // `fetch` de Node sigue redirects por defecto, y undici retira
      // `authorization` SOLO si el redirect es cross-origin: uno same-origin
      // reenvía el Bearer a una ruta que nadie decidió, un 3xx cross-origin lo
      // descarta en silencio y apps/api responde 401 —el estudiante ve "tu
      // sesión expiró" con la sesión intacta— y un 302 convierte el POST en GET
      // y descarta el cuerpo. apps/api no tiene un solo redirect en su tabla de
      // rutas, así que un 3xx aquí es por definición inesperado.
      redirect: "manual",
    });
    clearTimeout(timer);

    // Con `redirect: "manual"` la respuesta filtrada de la spec llega como
    // `opaqueredirect` con status 0; undici puede además entregar el 3xx crudo.
    // Los dos son fallo de upstream → 503.
    if (
      upstream.type === "opaqueredirect" ||
      upstream.status === 0 ||
      (upstream.status >= 300 && upstream.status < 400)
    ) {
      await upstream.body?.cancel();
      return { error: true };
    }

    // EL CUERPO SE DEVUELVE TAL CUAL, SIN RELEERLO. Ni `await upstream.text()`,
    // ni un ReadableStream nuevo que copie chunks, ni un TextDecoder en medio:
    // cualquiera de los tres convierte el proxy en un buffer y el estudiante
    // recibe la respuesta entera de golpe — el tutor "funciona", sólo que sin
    // streaming, y ningún test unitario lo vería.
    //
    // El passthrough por identidad y la cancelación son la misma propiedad, no
    // dos: cuando el navegador se va, Next cancela este ReadableStream, que ES
    // `upstream.body`, y cancelarlo destruye el socket hacia apps/api. Por eso
    // "no releas el cuerpo" no es una regla de rendimiento, es una de
    // facturación.
    //
    // Hacia abajo las cabeceras también se construyen: `{ headers:
    // upstream.headers }` es lo natural en un proxy y arrastra Content-Length,
    // Content-Encoding y Transfer-Encoding de OTRA conexión HTTP a ésta
    // —hop-by-hop la última, y undici ya decodificó el cuerpo—, además de ser
    // la puerta por la que un Set-Cookie del upstream llegaría al navegador el
    // día que apps/api ponga uno. Van las dos de §5.1 y nada más; el
    // Content-Type se lee por nombre para que un 400 del ValidationPipe siga
    // llegando como JSON.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type":
          upstream.headers.get("content-type") ?? "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    // Timeout de cabeceras, conexión rechazada, DNS, cancelación del cliente o
    // cualquier otro fallo de red. Nunca lanza: el handler lo traduce a 503 y
    // apps/api no llegó a abrir el stream, así que no se persistió nada.
    clearTimeout(timer);
    return { error: true };
  }
}

// ---------------------------------------------------------------------------
// PRD-007 §5.3 — el puente de la evidencia por lección.
// ---------------------------------------------------------------------------

/**
 * §5.4. Por encima del presupuesto total de la comprobación en apps/api
 * (`EVIDENCE_TIMEOUT_MS` = 3000, que incluye DNS y saltos), con margen para el
 * salto de red y las dos escrituras.
 *
 * Viaja como ARGUMENTO a las dos funciones de abajo y nunca se lee desde
 * dentro, por la razón que fetchAccess() ya documenta: si lo releyeran por
 * dentro, las filas 61-63 de §9 no podrían fijar un tope corto y tendrían que
 * esperar seis segundos reales por caso.
 */
export const EVIDENCE_BRIDGE_TIMEOUT_MS = 6_000;

export type EvidenceResult = EvidenceItem | { error: true };
export type EvidenceListResult = { items: EvidenceItem[] } | { error: true };

function isEvidenceItem(body: unknown): body is EvidenceItem {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.lessonSlug === "string" &&
    typeof b.url === "string" &&
    (b.status === "declared" || b.status === "verified" || b.status === "failed") &&
    (b.checkedAt === null || typeof b.checkedAt === "string") &&
    (b.failureReason === null || typeof b.failureReason === "string")
  );
}

function isEvidenceList(body: unknown): body is { items: EvidenceItem[] } {
  if (!body || typeof body !== "object") return false;
  const items = (body as Record<string, unknown>).items;
  return Array.isArray(items) && items.every(isEvidenceItem);
}

/**
 * El viaje a `/v1/evidence`, común al `POST` y al `GET`.
 *
 * AQUÍ NO HAY STREAMING: la respuesta es JSON acotado, así que el timeout es
 * `AbortSignal.timeout()` como en fetchAccess() y NO el
 * `AbortController` + `clearTimeout` de streamTutorTurn() — ese baile existe
 * sólo porque abortar un `fetch` después de la primera cabecera rompe el cuerpo
 * a media lectura, y aquí no hay cuerpo que romper (§5.3).
 *
 * Devuelve el cuerpo ya parseado envuelto, o `{error:true}`: quien decide si la
 * FORMA sirve es cada llamante, para que la regla positiva se lea entera en un
 * solo sitio por endpoint.
 */
async function requestEvidence(
  token: string | { error: true },
  baseUrl: string,
  timeoutMs: number,
  method: "GET" | "POST",
  body?: string
): Promise<{ body: unknown } | { error: true }> {
  if (typeof token !== "string") return { error: true };

  const base = baseUrl.replace(/\/+$/, "");

  // LAS CABECERAS SE CONSTRUYEN, NO SE COPIAN, y el conjunto saliente es
  // EXACTAMENTE éste. Esparcir las entrantes se lleva la Cookie de paso
  // —tendría precedencia sobre el Bearer dentro de getToken(), abriendo un
  // segundo canal de credencial no declarado— y también el X-Forwarded-For del
  // cliente hacia un servicio con `trust proxy` puesto (§5.3, §8.2).
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  try {
    const res = await fetch(`${base}/v1/evidence`, {
      method,
      headers,
      body,
      // Sin esto, un apps/api que acepta la conexión y no responde colgaría el
      // envío del estudiante indefinidamente.
      signal: AbortSignal.timeout(timeoutMs),
      // Misma razón que streamTutorTurn(): undici retira `authorization` SÓLO
      // si el redirect es cross-origin, y un 302 convierte este POST en GET
      // descartando el cuerpo. apps/api no tiene un solo redirect en su tabla
      // de rutas, así que un 3xx aquí es por definición inesperado — y con
      // `manual` llega como status 0, que la regla positiva ya descarta.
      redirect: "manual",
    });

    if (res.status !== 200) return { error: true };

    try {
      return { body: await res.json() };
    } catch {
      return { error: true };
    }
  } catch {
    // Timeout, conexión rechazada, DNS, o cualquier otro fallo de red.
    return { error: true };
  }
}

/**
 * `POST /v1/evidence` — la entrega del estudiante (§5.1).
 *
 * REGLA POSITIVA, no enumeración (§5.3): SÓLO un 200 cuyo cuerpo tenga la forma
 * de `EvidenceItem` produce un resultado; todo lo demás —400 del
 * `ValidationPipe`, 401, 404, 409, 429, 503, JSON no parseable, o un 200 con
 * otra forma— es `{error:true}`. NUNCA LANZA.
 *
 * Un `status: "failed"` NO es un fallo de este puente: es un 200 con forma
 * válida y viaja como resultado. Que la comprobación no cuadre es un estado de
 * la fila, no un error de la petición (goal 4).
 *
 * `body` es el cuerpo entrante YA SERIALIZADO y se reenvía tal cual: la
 * validación de forma es de `evidence.dto.ts` (§5.1), no de aquí.
 */
export async function submitEvidence(
  token: string | { error: true },
  body: string,
  baseUrl: string,
  timeoutMs: number
): Promise<EvidenceResult> {
  const res = await requestEvidence(token, baseUrl, timeoutMs, "POST", body);
  if ("error" in res) return { error: true };
  return isEvidenceItem(res.body) ? res.body : { error: true };
}

/**
 * `GET /v1/evidence` — las filas del propio estudiante (§5.2). Misma regla
 * positiva: un `items` que no sea una lista de `EvidenceItem` es `{error:true}`,
 * no una lista a medias.
 */
export async function fetchEvidence(
  token: string | { error: true },
  baseUrl: string,
  timeoutMs: number
): Promise<EvidenceListResult> {
  const res = await requestEvidence(token, baseUrl, timeoutMs, "GET");
  if ("error" in res) return { error: true };
  return isEvidenceList(res.body) ? res.body : { error: true };
}
