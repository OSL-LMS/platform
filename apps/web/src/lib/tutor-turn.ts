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

// GUARDA ARMADO — PASO E DE §10, hecho.
//
// Va en el ámbito del módulo, igual que `resolveClientConfig()` en
// `api-client.ts:97`, y por la misma razón: `src/app/api/chat/route.ts` importa
// este fichero, así que la línea se ejecuta en el arranque real de Next y en
// `next build`. Un guarda en un módulo que nadie importa probaría que una
// función lanza, no que el arranque falla.
//
// Hasta el paso E NO podía estar armada, y no era un olvido: durante B, C y D
// la raíz ejecutaba el tutor en proceso y la clave era legítima aquí.
// Condicionarla a `TUTOR_VIA_API` habría sido peor que no ponerla — con el flag
// puesto no dispara, y al quitarlo (que es el rollback del paso D, sin
// desplegar) tumbaría el proceso justo cuando hace falta que arranque.
//
// Desde aquí, la clave pertenece SÓLO a apps/api. §9 fila 39.
assertNoAnthropicKey(process.env.ANTHROPIC_API_KEY);
