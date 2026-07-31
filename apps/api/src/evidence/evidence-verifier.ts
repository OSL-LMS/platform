// La comprobación de alcanzabilidad de una URL entregada (PRD-007 §8.2).
//
// ES EL ÚNICO PUNTO DEL SISTEMA DONDE UNA ENTRADA DEL ESTUDIANTE DECIDE A DÓNDE
// ABRE UNA CONEXIÓN EL SERVIDOR. Todo lo de este fichero es ese control.
//
// LA COSTURA. `verifyEvidenceUrl` recibe la configuración Y las dependencias de
// red como ARGUMENTOS, y no lee `process.env` ni `dns.promises` por dentro: es
// lo que permite que las filas 9-30 de §9 corran sin levantar el módulo de Nest
// y sin tocar la red. El RESOLUTOR viaja por esa misma costura porque cinco
// filas (16, 17, 18, 26 y 27) necesitan respuestas guionizadas POR FAMILIA, y
// sin inyectarlo la única salida sería parchear `dns.promises` en caliente.
// `EvidenceVerifier`, al final, es la envoltura inyectable que ata la costura a
// la configuración real.
//
// LO QUE NO SE HACE, Y ESTÁ DECIDIDO: no se lee el cuerpo de la respuesta (§8.2
// control 7, D4), no viajan credenciales (control 6), y no se cierra el DNS
// rebinding residual (§8.2, riesgo declarado) porque exigiría declarar `undici`
// como dependencia directa para usar una API que Node no reexporta.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";

import { Inject, Injectable, Logger } from "@nestjs/common";

import { causeCode, errorName } from "../common/error-fields.ts";
import { API_CONFIG, type ApiConfig } from "../config.ts";
import type { EvidenceFailureReason } from "../../../../packages/shared/src/evidence.ts";

// ---------------------------------------------------------------------------
// La costura
// ---------------------------------------------------------------------------

/** Lo que el verificador necesita de un resolutor de DNS. Es la superficie de
 *  `dns.promises.Resolver` que se usa, y nada más: un doble de test la implementa
 *  entera en diez líneas.
 *
 *  `resolve4`/`resolve6` POR SEPARADO y no un `lookup` fusionado, porque eso es
 *  lo que expone c-ares — ver el bloque de `screenHost`. */
export type EvidenceResolver = {
  resolve4(host: string): Promise<string[]>;
  resolve6(host: string): Promise<string[]>;
  cancel(): void;
};

export type EvidenceVerifierDeps = {
  /** FÁBRICA CON EL TOPE COMO ARGUMENTO, no instancia.
   *
   *  Es lo que pide §8.2 control 4, y la razón está ahí y aquí: ni
   *  `dns.promises.Resolver` ni `dns.Resolver` tienen `setTimeout`; el tope por
   *  consulta es una opción del CONSTRUCTOR (`new Resolver({ timeout, tries })`,
   *  `@types/node@22` `dns/promises.d.ts:458-459`). Cada operación recibe como
   *  tope el tiempo restante, y la única forma de aplicarlo es construir el
   *  resolutor cuando ya se conoce ese resto, así que el tope viaja por la
   *  fábrica. `cancel()` sí existe y es lo que se llama al vencer el
   *  presupuesto.
   *
   *  Y una instancia por comprobación de todas formas: `cancel()` aborta las
   *  consultas en vuelo del resolutor ENTERO, así que compartirlo haría que una
   *  comprobación que agota su presupuesto tumbase las de al lado. */
  createResolver: (timeoutMs: number) => EvidenceResolver;
  fetch: typeof globalThis.fetch;
};

export type EvidenceVerifierConfig = {
  /** Presupuesto TOTAL, DNS y saltos incluidos. */
  timeoutMs: number;
  maxRedirects: number;
};

export type VerificationResult =
  | { status: "verified"; failureReason: null }
  | { status: "failed"; failureReason: EvidenceFailureReason };

const VERIFIED: VerificationResult = { status: "verified", failureReason: null };

function failed(failureReason: EvidenceFailureReason): VerificationResult {
  return { status: "failed", failureReason };
}

const logger = new Logger("EvidenceVerifier");

// ---------------------------------------------------------------------------
// El host: se deriva UNA VEZ y de una sola forma
// ---------------------------------------------------------------------------

/** El host que se criba es EXACTAMENTE el que se resuelve y al que se conecta:
 *  `URL.hostname`, con los corchetes de un literal IPv6 quitados. No un regex,
 *  no `split("/")`, no lo que dejó el validador.
 *
 *  Anclarlo al parser WHATWG cierra tres casos sin escribir nada:
 *  `https://2130706433/` normaliza a `127.0.0.1`, `https://0x7f.0.0.1/` a
 *  `127.0.0.1`, y `https://evil.example.com@169.254.169.254/` deja
 *  `hostname = 169.254.169.254` descartando el userinfo. Derivarlo de cualquier
 *  otra forma reabre los tres. Fila 15 de §9.
 *
 *  LOS CORCHETES. `URL.hostname` los CONSERVA en un literal IPv6 —
 *  `new URL("https://[::1]/").hostname` es `"[::1]"`—, así que `isIP()` sobre
 *  ese valor devuelve `0`. Sin quitarlos, el DTO daría 400 a todo literal IPv6
 *  y el cribado trataría `[::1]` como un nombre a resolver. Por eso esta función
 *  la comparten §5.1 y §8.2 en vez de existir dos veces. */
export function hostnameOf(url: URL): string {
  const host = url.hostname;
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

// ---------------------------------------------------------------------------
// Control 2 — el rango, POR ALLOWLIST y no por denylist
// ---------------------------------------------------------------------------
//
// Una allowlist porque el goal 7 es una propiedad CERRADA —"fuera del unicast
// global"— y una enumeración de rangos malos está incompleta por construcción:
// la versión enumerada de este control dejaba pasar `https://[::]/`, que en
// Linux conecta al propio contenedor. Fila 13 de §9.

function ipv4Octets(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;

  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/** IPv4: `1.0.0.0`–`223.255.255.255` menos los bloques de §8.2 punto 2. El
 *  límite inferior excluye `0.0.0.0/8` y el superior todo lo multicast y
 *  reservado a partir de `224/4`. */
function isGlobalUnicastIpv4(address: string): boolean {
  const octets = ipv4Octets(address);
  if (!octets) return false;
  const [a, b, c] = octets;

  if (a < 1 || a > 223) return false;

  if (a === 10) return false; // 10/8 privada
  if (a === 100 && b >= 64 && b <= 127) return false; // 100.64/10 CGNAT
  if (a === 127) return false; // 127/8 loopback
  if (a === 169 && b === 254) return false; // 169.254/16 link-local (metadatos)
  if (a === 172 && b >= 16 && b <= 31) return false; // 172.16/12 privada
  if (a === 192 && b === 0 && c === 0) return false; // 192.0.0/24 IETF
  if (a === 192 && b === 0 && c === 2) return false; // 192.0.2/24 documentación
  if (a === 192 && b === 88 && c === 99) return false; // 192.88.99/24 6to4 relay
  if (a === 192 && b === 168) return false; // 192.168/16 privada
  if (a === 198 && (b === 18 || b === 19)) return false; // 198.18/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // 198.51.100/24 documentación
  if (a === 203 && b === 0 && c === 113) return false; // 203.0.113/24 documentación

  return true;
}

/** Los 16 bytes de una dirección IPv6, o `null` si no se puede leer. Se llama
 *  SIEMPRE detrás de `isIP()`, así que no es un validador: un `null` aquí es
 *  "no lo entiendo", y el llamante lo trata como BLOQUEADA — fallar cerrado. */
function ipv6Bytes(address: string): Uint8Array | null {
  const halves = address.split("::");
  if (halves.length > 2) return null;

  const readGroups = (chunk: string): number[] | null => {
    if (chunk === "") return [];
    const groups: number[] = [];
    for (const group of chunk.split(":")) {
      // Sufijo IPv4 embebido (`::ffff:127.0.0.1`): ocupa DOS grupos de 16 bits.
      if (group.includes(".")) {
        const octets = ipv4Octets(group);
        if (!octets) return null;
        groups.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      groups.push(Number.parseInt(group, 16));
    }
    return groups;
  };

  const head = readGroups(halves[0]);
  const tail = readGroups(halves[1] ?? "");
  if (!head || !tail) return null;

  const declared = head.length + tail.length;
  if (halves.length === 2 ? declared > 8 : declared !== 8) return null;

  const groups = [...head, ...new Array<number>(8 - declared).fill(0), ...tail];
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[index * 2] = (group >> 8) & 0xff;
    bytes[index * 2 + 1] = group & 0xff;
  });
  return bytes;
}

/** IPv6: `2000::/3` menos `2001::/23`, `2002::/16` y `2001:db8::/32`.
 *
 *  ESA ÚNICA REGLA excluye `::`, `::1`, `fc00::/7`, `fe80::/10`, `ff00::/8`,
 *  `64:ff9b::/96` (NAT64), `100::/64` y `::ffff:0:0/96` SIN ENUMERAR NINGUNO:
 *  ninguno cae dentro de `2000::/3`. Filas 12, 13 y 14 de §9.
 *
 *  Se excluye `2001::/23` y no `2001::/32` porque el bloque ancho barre de una
 *  vez toda futura asignación de protocolo del IETF (Teredo, ORCHIDv2, BMWG…)
 *  sin coste. `2001:db8::/32` queda FUERA de ese bloque y por eso lleva su
 *  propia línea: el byte que enmascara la prueba de `/23` es `bytes[2]`, que
 *  para `2001:0db8::` vale `0x0d` —no `0xdb`— y `0x0d & 0xfe = 0x0c`, distinto
 *  de 0. Quien rederive esto a mano tiene que mirar el TERCER byte. */
function isGlobalUnicastIpv6(address: string): boolean {
  const bytes = ipv6Bytes(address);
  if (!bytes) return false;

  if ((bytes[0] & 0xe0) !== 0x20) return false; // fuera de 2000::/3
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && (bytes[2] & 0xfe) === 0x00) return false; // 2001::/23
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return false; // 2002::/16 6to4
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) {
    return false; // 2001:db8::/32 documentación
  }

  return true;
}

/** El control de destino de §8.2: unicast global y nada más. */
export function isGlobalUnicast(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isGlobalUnicastIpv4(address);
  if (family === 6) return isGlobalUnicastIpv6(address);
  return false;
}

// ---------------------------------------------------------------------------
// Control 4 — el presupuesto acota CADA operación, no solo la entrada al bucle
// ---------------------------------------------------------------------------

const DEADLINE_REACHED = Symbol("deadline");

/** Corre `work` con un tope duro de `ms`, ejecutando `onExpire` al vencer.
 *
 *  COMPROBAR ANTES DE EMPEZAR NO ACOTA LO QUE EMPIEZA: una resolución lanzada a
 *  un milisegundo del límite corre después su duración entera, y ahí se come el
 *  margen de `EVIDENCE_BRIDGE_TIMEOUT_MS` que el proxy de `apps/web` necesita
 *  para poder devolver el `failed` en vez de un 503. Por eso hay una carrera de
 *  verdad y no solo un `setTimeout` propio del resolutor: el `setTimeout()` de
 *  c-ares acota cada CONSULTA, no la suma de las dos familias. Fila 27 de §9. */
async function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  onExpire: () => void
): Promise<T | typeof DEADLINE_REACHED> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<typeof DEADLINE_REACHED>((resolve) => {
    timer = setTimeout(() => {
      onExpire();
      resolve(DEADLINE_REACHED);
    }, ms);
  });

  try {
    return await Promise.race([work, expiry]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Controles 2 y 3 — el cribado del destino
// ---------------------------------------------------------------------------

type ScreenOutcome = "ok" | "blocked_address" | "dns" | "timeout";

/** Criba un host: literal IP sin resolver, o las DOS familias resueltas.
 *
 *  `Resolver` (c-ares) EN VEZ DE `lookup` (§8.2 control 3). `dns.promises.lookup`
 *  es `getaddrinfo` sobre el threadpool de libuv: no acepta `AbortSignal`, no se
 *  cancela, y ocupa uno de los 4 slots por defecto mientras dura. Un host cuyo
 *  NS no contesta retendría la llamada muy por encima del presupuesto —que solo
 *  aborta el `fetch`— y convertiría el `failed` que el estudiante debe ver en un
 *  503 del proxy; con varias peticiones en vuelo, además, agota el threadpool
 *  que sirve el `getaddrinfo` de toda conexión saliente del proceso.
 *
 *  ESE CAMBIO RETIRA TRES COMPORTAMIENTOS QUE HAY QUE RECONSTRUIR:
 *
 *   a. **Fusionaba las familias.** `resolve6()` RECHAZA con `ENODATA` en un host
 *      que solo tiene registro `A`. Hay que llamar a las dos, y el rechazo de
 *      una NO es un fallo si la otra devolvió direcciones: `dns` solo se emite
 *      cuando la unión queda vacía. Cablear solo `resolve4()` —la elección
 *      natural, porque casi toda fixture es IPv4— deja la familia AAAA sin
 *      comprobar y abre el bypass del control 2 (fila 17). Cablear las dos y
 *      fallar ante cualquier rechazo convierte TODO destino IPv4 en `failed`/
 *      `dns`, que es el camino feliz de la función entera (fila 16).
 *   b. **Cortocircuitaba los literales IP.** `resolve4("127.0.0.1")` lanza una
 *      consulta DNS real por el NOMBRE `"127.0.0.1"` y falla. Sin la puerta
 *      `isIP()`, toda fila de literal devolvería `dns` en vez de
 *      `blocked_address`.
 *   c. **Devolvía todo en una respuesta.** Con dos llamadas es más fácil
 *      comprobar una y olvidar la otra, y por eso "TODAS las direcciones de
 *      AMBAS familias" está escrito y probado (fila 18).
 *
 *  Con `autoSelectFamily` activo por defecto en Node 22, `fetch` corre Happy
 *  Eyeballs: un `A` público junto a un `AAAA → ::1` es un SSRF vivo que no
 *  necesita ningún resolutor hostil, solo una rama de código sin comprobar. */
async function screenHost(
  host: string,
  deadlineAt: number,
  deps: EvidenceVerifierDeps
): Promise<ScreenOutcome> {
  // b. Un literal se comprueba DIRECTAMENTE, sin resolver.
  if (isIP(host) !== 0) return isGlobalUnicast(host) ? "ok" : "blocked_address";

  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) return "timeout";

  // El tope de c-ares acota cada CONSULTA; la carrera de abajo acota la SUMA de
  // las dos familias. Los dos, no uno.
  const resolver = deps.createResolver(remaining);

  const settled = await withDeadline(
    Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]),
    remaining,
    () => resolver.cancel()
  );
  if (settled === DEADLINE_REACHED) return "timeout";

  const addresses = settled.flatMap((family) =>
    family.status === "fulfilled" ? family.value : []
  );

  // a. La unión vacía —ninguna familia devolvió nada— es `dns`. Un rechazo con
  // la otra familia respondiendo, no.
  if (addresses.length === 0) return "dns";

  // Se criban TODAS, no la primera y no una sola familia.
  return addresses.every(isGlobalUnicast) ? "ok" : "blocked_address";
}

// ---------------------------------------------------------------------------
// El bucle
// ---------------------------------------------------------------------------

/** ¿El fallo del `fetch` fue el presupuesto agotándose? `AbortSignal.timeout()`
 *  aborta con un `DOMException` de nombre `TimeoutError`; undici a veces lo
 *  envuelve, de ahí las dos miradas. */
function isTimeoutError(err: unknown): boolean {
  const names = [
    (err as { name?: unknown } | null)?.name,
    (err as { cause?: { name?: unknown } } | null)?.cause?.name,
  ];
  return names.some((name) => name === "TimeoutError" || name === "AbortError");
}

/**
 * Comprueba que la URL entregada responde, sin leer lo que dice (D4).
 *
 * NUNCA LANZA: el goal 4 dice que un fallo de comprobación es un 200 con
 * `status: "failed"` y su razón, nunca un error HTTP y nunca un bloqueo de
 * avance. Todo camino de esta función devuelve un `VerificationResult`.
 */
export async function verifyEvidenceUrl(
  submittedUrl: string,
  config: EvidenceVerifierConfig,
  deps: EvidenceVerifierDeps
): Promise<VerificationResult> {
  // El instante límite se fija UNA VEZ, antes del bucle. No es un tope por
  // operación: con 3 saltos habría hasta 4 resoluciones y 4 peticiones, y un
  // tope por operación no acota la suma.
  const deadlineAt = Date.now() + config.timeoutMs;

  let current: URL;
  try {
    current = new URL(submittedUrl);
  } catch {
    // Inalcanzable por el DTO, que ya rechazó lo que no parsea con un 400. Se
    // deja como red de seguridad porque esta función es pública y la llaman los
    // tests directamente.
    return failed("malformed_redirect");
  }

  for (let hop = 0; ; hop++) {
    // Control 1 — esquema y puerto, en el DTO Y OTRA VEZ EN CADA SALTO. Un
    // `Location` que cambia únicamente el puerto sería un bypass gratuito de un
    // control que solo viviera en el DTO. Fila 20 de §9.
    if (current.protocol !== "https:") return failed("insecure_redirect");
    if (current.port !== "" && current.port !== "443") return failed("insecure_redirect");

    // Controles 2 y 3 — ANTES de abrir la conexión (goal 7).
    const screened = await screenHost(hostnameOf(current), deadlineAt, deps);
    if (screened !== "ok") return failed(screened);

    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) return failed("timeout");

    let response: Response;
    try {
      response = await deps.fetch(current, {
        method: "GET",
        // Control 5 — a mano. Seguirlas automáticamente es el bypass clásico:
        // el primer host es público y el `Location` apunta adentro.
        redirect: "manual",
        // Control 6 — SIN CREDENCIALES. Sin `Authorization`, sin cookies, sin
        // cabecera propia: no hay nada que filtrar a un destino hostil. Fila 28.
        signal: AbortSignal.timeout(remaining),
      });
    } catch (err: unknown) {
      // §8.5: aquí NO corre `AllExceptionsFilter` —captura sus propios fallos
      // por contrato— y lo que llevan estos errores es peor que el host: un
      // `getaddrinfo ENOTFOUND ana.github.io` trae el hostname y un `TypeError`
      // de undici trae en `cause.message` un `connect ECONNREFUSED 10.0.0.5:443`,
      // la IP INTERNA resuelta. Solo `name` y `cause.code`, nunca el objeto, su
      // `message`, su `stack` ni su `hostname`. Fila 30 de §9.
      const timedOut = isTimeoutError(err);
      logger.warn(
        `evidencia: la comprobación no completó reason=${timedOut ? "timeout" : "network"} ` +
          `name=${errorName(err)} code=${causeCode(err)}`
      );
      return failed(timedOut ? "timeout" : "network");
    }

    // Control 7 — EL CUERPO NO SE LEE. Se observa el status y se descarta la
    // respuesta: sin lectura no hay exfiltración de contenido, no hay bomba de
    // descompresión, y los redirects por `meta refresh` o HTML son irrelevantes
    // porque no hay nada que parsear. Fila 29 de §9.
    // ponytail: tampoco se cancela el flujo, así que el socket lo libera el GC
    // de undici en vez de un `body.cancel()` explícito. Es lo que dice §8.2
    // control 7 al pie de la letra ("se descarta la respuesta"); si aparece
    // presión de sockets, el arreglo es un `cancel()` en un `try`, no leerlo.
    const code = response.status;

    if (code >= 200 && code < 300) return VERIFIED;

    if (code >= 300 && code < 400) {
      // Un 3xx terminal NUNCA es `verified`.
      if (hop >= config.maxRedirects) return failed("too_many_redirects");

      const location = response.headers.get("location");
      // Un `Location` ausente es `malformed_redirect`, NUNCA una excepción:
      // sin esta rama es un `TypeError` y un 500, contra el goal 4. Fila 23.
      if (!location) return failed("malformed_redirect");

      try {
        // Se resuelve contra EL SALTO ACTUAL, no contra la URL original, porque
        // `Location: /login` es el caso común de un repositorio tras
        // autenticación. Fila 22 de §9.
        current = new URL(location, current);
      } catch {
        return failed("malformed_redirect");
      }
      continue;
    }

    // `http_<código>`, nunca prosa del destino (§8.5).
    return failed(`http_${code}`);
  }
}

// ---------------------------------------------------------------------------
// La envoltura inyectable
// ---------------------------------------------------------------------------

/** Ata la costura a la configuración y al `dns.promises.Resolver` real. Es lo
 *  que las filas e2e sustituyen con un doble por override de provider, para que
 *  `pnpm test` no haga DNS ni HTTPS reales contra un tercero. */
@Injectable()
export class EvidenceVerifier {
  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  verify(submittedUrl: string): Promise<VerificationResult> {
    return verifyEvidenceUrl(
      submittedUrl,
      {
        timeoutMs: this.config.evidenceTimeoutMs,
        maxRedirects: this.config.evidenceMaxRedirects,
      },
      {
        // `tries: 1` NO ES COSMÉTICO: el defecto de c-ares son 4 intentos, y
        // `timeout` acota CADA intento, no la consulta. Con el defecto, el tope
        // efectivo por familia sería 4× el resto del presupuesto — o sea ningún
        // tope. La carrera de `withDeadline` lo taparía, pero dejaría consultas
        // corriendo detrás de una respuesta ya devuelta.
        createResolver: (timeoutMs) => new Resolver({ timeout: timeoutMs, tries: 1 }),
        fetch: globalThis.fetch,
      }
    );
  }
}
