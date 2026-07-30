// Decisiones puras del turno del tutor, lado raíz (PRD-005 §5.2, §5.3, §8.3).
//
// Este módulo existe por la misma razón que src/lib/format-message.ts: el
// repositorio NO tiene runner de componentes React (PRD-005 §9 y §11 punto 4),
// así que lo que el cliente DECIDE —qué cuerpo manda, qué copy corresponde a
// cada estado, qué conserva en pantalla cuando algo falla— se extrae aquí y se
// prueba bajo Node pelado desde scripts/check-tutor-turn.ts (§9 filas 36-38).
// Lo que queda en chat-client.tsx es cableado.
//
// NO IMPORTA NADA. Ni `next/*`, ni la base de datos, ni el esquema: lo importan
// a la vez un Client Component (src/app/chat-client.tsx) y un Route Handler
// (src/app/api/chat/route.ts), así que cualquier import de servidor viajaría al
// bundle del navegador. Los tipos se declaran aquí, no se traen de schema.ts.
//
// Regla de código: identificadores en inglés, comentarios en español.

/** Una entrada del hilo tal como viaja al modelo. Copia local del tipo de
 *  `schema.ts` para no importar nada (ver cabecera). */
export type ThreadMessage = { role: "user" | "assistant"; content: string };

/** El cuerpo que el navegador manda a `POST /api/chat` desde PRD-005 §5.2: un
 *  solo mensaje, el suyo. El hilo sale de `conversations`, no de aquí. */
export type TurnBody = { message: string; lesson?: string };

/** Cota del turno del estudiante (§5.1, `@Length(1, 4000)` en `turn.dto.ts`).
 *  El `<textarea>` la aplica como `maxLength` para que el límite del DTO no
 *  llegue nunca como un 400 con el consejo inútil de "recarga la página". */
export const TUTOR_MESSAGE_MAX_LENGTH = 4000;

// `lesson` es entrada no confiable y sigue sin interpolarse nunca en el prompt.
// El patrón es el que estaba en route.ts:29, movido tal cual; §5.1 lo repite en
// `turn.dto.ts` con `@Matches`.
const LESSON_SLUG_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// ---------------------------------------------------------------------------
// §9 fila 36 — el cuerpo saliente del cliente.
// ---------------------------------------------------------------------------

/**
 * El cuerpo de `POST /api/chat`: `{ message, lesson }` y nada más. **El hilo no
 * viaja**: ésa es la propiedad de seguridad del goal 2, y el cliente deja de
 * poder fabricar turnos `assistant` porque deja de mandarlos.
 *
 * `lesson` se **omite** —no viaja como `null` ni como cadena vacía— cuando no
 * hay selección o cuando no encaja en el patrón: `turn.dto.ts` la declara
 * `@IsOptional`, y `forbidNonWhitelisted` no perdona una clave presente con
 * valor inválido.
 */
export function buildTurnBody(
  message: string,
  lesson?: string | null
): TurnBody {
  if (typeof lesson === "string" && LESSON_SLUG_PATTERN.test(lesson)) {
    return { message, lesson };
  }
  return { message };
}

// ---------------------------------------------------------------------------
// §9 fila 37 — el mapeo de estados a copy.
// ---------------------------------------------------------------------------

/**
 * Traduce el status a un mensaje localizado y honesto. Los tres que ya existían
 * (401, 403, 400) conservan su texto palabra por palabra; 413, 429 y 503 dejan
 * de caer al genérico:
 *
 *  - 413 y 429 son accionables por el estudiante (acortar, esperar) y el
 *    genérico "reintenta en un momento" le dice justo lo contrario en el 413.
 *  - 503 es el puente del tutor caído (§5.3): transitorio y ajeno a él.
 */
export function tutorErrorMessage(status: number): string {
  switch (status) {
    case 401:
      return "Tu sesión expiró. Vuelve a iniciar sesión para seguir.";
    case 403:
      return "Necesitas una suscripción activa para hablar con el tutor.";
    case 400:
      return "No pudimos procesar tu mensaje. Recarga la página e intenta otra vez.";
    case 413:
      return "Tu mensaje es demasiado largo. Acórtalo e inténtalo otra vez.";
    case 429:
      return "Enviaste muchos mensajes seguidos. Espera un minuto y reintenta.";
    case 503:
      return "El tutor no está disponible ahora mismo. Reintenta en un momento.";
    default:
      return "Algo falló al hablar con el tutor. Reintenta en un momento.";
  }
}

// ---------------------------------------------------------------------------
// §9 fila 38 — qué se conserva al fallar.
// ---------------------------------------------------------------------------

/**
 * Las tres formas en las que un turno puede fallar en el cliente, y son tres y
 * no una: hoy `chat-client.tsx:136-138` las mete en un solo `catch` y borra la
 * burbuja entera aunque ya tuviera texto pintado (§4 caso 4).
 *
 *  - `request`: el `fetch` lanzó (offline, DNS, conexión cortada al abrir).
 *  - `status`: hubo respuesta y `!res.ok`.
 *  - `stream`: el bucle de lectura lanzó **después** de abrir el cuerpo.
 */
export type TurnFailure =
  | { phase: "request" }
  | { phase: "status"; status: number }
  | { phase: "stream" };

export type TurnRecovery = {
  /** `true` → la burbuja del asistente se queda con lo que ya se pintó. */
  keepPartial: boolean;
  /** El aviso que se muestra bajo el hilo. */
  notice: string;
};

/**
 * Qué hacer con la burbuja del asistente dada la fase del fallo.
 *
 * Antes del stream no hay nada que conservar: la burbuja está vacía y se
 * recorta. Después del primer byte hay texto en pantalla que el estudiante ya
 * leyó, y borrarlo es peor que dejarlo con un aviso — es la diferencia entre
 * "se cortó" y "no pasó nada".
 *
 * OJO: esto decide **dada la fase**; no clasifica la fase. Que chat-client.tsx
 * sepa en qué fase está es lo que §10 paso B verifica a mano, porque una
 * implementación que conserve el `catch` único y pase siempre `request` hace
 * pasar esta prueba con el fallo intacto.
 */
export function decideTurnFailure(failure: TurnFailure): TurnRecovery {
  if (failure.phase === "stream") {
    return {
      keepPartial: true,
      notice:
        "Se cortó la respuesta del tutor. Lo que alcanzó a escribir sigue arriba; reintenta cuando quieras.",
    };
  }
  return {
    keepPartial: false,
    notice:
      failure.phase === "status"
        ? tutorErrorMessage(failure.status)
        : tutorErrorMessage(0),
  };
}

// ---------------------------------------------------------------------------
// §5.2 — el hilo sale de la base, y la base no tiene restricción de forma.
// ---------------------------------------------------------------------------

export type SanitizedThread = {
  messages: ThreadMessage[];
  /** Cuántas entradas se descartaron. Es un entero y **no lleva contenido**:
   *  §8.3 mantiene el registro como allowlist por campo. */
  discarded: number;
};

function isThreadMessage(entry: unknown): entry is ThreadMessage {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as { role?: unknown; content?: unknown };
  return (
    (e.role === "user" || e.role === "assistant") && typeof e.content === "string"
  );
}

/**
 * Valida el hilo guardado AL LEERLO y deja lo que puede viajar al modelo.
 *
 * `conversations.messages` es `jsonb` sin restricción, y hasta PRD-005 daba
 * igual: la fila no alimentaba al modelo. Desde §5.2 sí, y el goal 2 sólo es
 * tan fuerte como esta lectura — `trimWindow` mira `m.role === "user"` y una
 * entrada con `role: "system"` le pasaría por delante.
 *
 * Dos cosas, en este orden:
 *  1. Se descarta toda entrada cuyo `role` no sea exactamente `"user"` o
 *     `"assistant"`, o cuyo `content` no sea string.
 *  2. Se recorta el prefijo hasta el primer `user`. `trimWindow` NO da esa
 *     garantía por debajo de 30 mensajes (`window.ts:33` devuelve el array tal
 *     cual), así que si el descarte se lleva la primera entrada y la siguiente
 *     es `assistant`, lo que viajaría empieza por `assistant`, Anthropic
 *     responde 400 y el tutor da 500.
 *
 * Un `messages` que no sea un array —violación de esquema, no de contenido— se
 * trata como "nada utilizable" y no como un descarte contable.
 *
 * ponytail: el paso E de §10 la retira de la raíz junto con la implementación
 * local del tutor; desde ahí la lectura validada vive en
 * `apps/api/src/tutor/conversations.repository.ts`.
 */
export function sanitizeStoredThread(raw: unknown): SanitizedThread {
  if (!Array.isArray(raw)) return { messages: [], discarded: 0 };

  const kept: ThreadMessage[] = [];
  for (const entry of raw) {
    if (isThreadMessage(entry)) kept.push({ role: entry.role, content: entry.content });
  }

  const firstUser = kept.findIndex((m) => m.role === "user");
  const messages = firstUser === -1 ? [] : kept.slice(firstUser);

  // `discarded` cuenta LAS DOS PÉRDIDAS —entradas inválidas más el prefijo
  // recortado—, igual que `sanitizeThread` de
  // apps/api/src/tutor/conversations.repository.ts. Contar solo las inválidas
  // aquí daría dos números distintos para el mismo hilo justo durante los pasos
  // B-E, que es cuando las dos rutas conviven y cuando un operador los
  // compararía.
  return { messages, discarded: raw.length - messages.length };
}

// ---------------------------------------------------------------------------
// §10 paso B — el cuerpo entrante, en sus dos formas.
// ---------------------------------------------------------------------------

export type IncomingTurn =
  | { ok: true; message: string; lesson: string | undefined }
  | { ok: false; error: string };

/**
 * Lee el turno del cuerpo de `POST /api/chat` aceptando **las dos formas**.
 *
 * Las dos mitades del paso B van juntas en el despliegue, no en el navegador:
 * un estudiante con `/chat` ya abierto conserva el bundle viejo, que manda el
 * hilo entero. Sin esta caída a `messages.at(-1).content` recibiría un 400
 * hasta recargar, y el rollback tendría el problema simétrico.
 *
 * ponytail: el paso E de §10 retira esta función con la rama de compatibilidad.
 * No valida la cota de 4 000: hacerlo aquí rechazaría a un bundle viejo por un
 * límite que ese bundle no conocía. La cota la aplican el `<textarea>` nuevo y
 * el DTO de `apps/api` (§5.1).
 */
export function readIncomingTurn(body: unknown): IncomingTurn {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "Invalid JSON body" };
  }
  const b = body as { message?: unknown; messages?: unknown; lesson?: unknown };

  const lesson =
    typeof b.lesson === "string" && LESSON_SLUG_PATTERN.test(b.lesson)
      ? b.lesson
      : undefined;

  if (typeof b.message === "string") {
    return b.message.length > 0
      ? { ok: true, message: b.message, lesson }
      : { ok: false, error: "Missing message" };
  }

  if (Array.isArray(b.messages)) {
    const last: unknown = b.messages[b.messages.length - 1];
    if (last && typeof last === "object") {
      const content = (last as { content?: unknown }).content;
      if (typeof content === "string" && content.length > 0) {
        return { ok: true, message: content, lesson };
      }
    }
  }

  return { ok: false, error: "Missing message" };
}

// ---------------------------------------------------------------------------
// §8.3 — falla cerrado ante la PRESENCIA de la clave de Anthropic.
// ---------------------------------------------------------------------------

/**
 * Tumba el arranque si `ANTHROPIC_API_KEY` aparece en el entorno de la raíz.
 *
 * Simétrico al guarda de `PADDLE_API_KEY` en `apps/api/src/config.ts:77-83`, y
 * por la razón que ese comentario ya da: el `CMD` de la imagen equivocada
 * arranca **aparentando éxito**, y en autohospedaje —repositorio público,
 * AGPL— un solo `.env` en una máquina lo heredan todos los entrypoints.
 * PRD-003 §1.1 prohíbe que una propiedad de seguridad dependa de dónde se
 * ponga una variable, y "retirarla del servicio Next" es exactamente eso.
 *
 * Una cadena VACÍA también cuenta como presente: lo que el operador comprueba
 * es "está o no está". El mensaje NOMBRA la variable y nunca imprime su valor.
 *
 * Recibe el VALOR y no `process.env` entero a propósito (mismo patrón que
 * `shouldEmitPageview(salt)` en `src/lib/pixel.ts`): `process.env.X` como
 * acceso estático es lo que Next sustituye por `undefined` en el bundle del
 * navegador, mientras que pasar el objeto `process.env` desde un Client
 * Component depende del shim del bundler.
 */
export function assertNoAnthropicKey(value: string | undefined): void {
  if (value === undefined) return;
  throw new Error(
    "El servicio Next no puede arrancar: ANTHROPIC_API_KEY está presente en " +
      "su entorno. Desde el paso E de PRD-005 §10 el tutor vive en apps/api y " +
      "este proceso sólo proxya el stream, así que esa credencial ya no tiene " +
      "lector aquí. Retírala de este servicio. Ver PRD-005 §8.3."
  );
}

// ARMADO DEL GUARDA — LO ENCIENDE EL PASO E DE §10, NO ANTES.
//
// La línea que falta es exactamente ésta, sin argumentos ni condiciones:
//
//     assertNoAnthropicKey(process.env.ANTHROPIC_API_KEY);
//
// y va aquí, en el ámbito del módulo, igual que `resolveClientConfig()` en
// `api-client.ts:97`: este fichero lo importa `src/app/api/chat/route.ts`, así
// que se carga en el arranque real de Next y en `next build`. Un guarda en un
// módulo que nadie importa probaría que una función lanza, no que el arranque
// falla.
//
// NO SE PUEDE ARMAR HOY, y no es un olvido: durante los pasos B, C y D la raíz
// sigue ejecutando el tutor en proceso (`new Anthropic()` en route.ts) y la
// clave es legítima aquí. Tampoco sirve condicionarlo a `TUTOR_VIA_API`: §8.3
// dice que durante C-D la clave vive en los dos servicios, precisamente para
// que el rollback del paso D —quitar la variable, sin desplegar— devuelva un
// camino local que funciona. El día que el paso E borre la implementación
// local, esta línea deja de tener excusa. §9 fila 39 la fecha ahí ("tras el
// paso E") y `scripts/check-secrets.ts` explica qué mitad cubre hoy.
