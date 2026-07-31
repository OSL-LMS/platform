// Decisiones puras del panel de entrega, lado cliente (PRD-007 §4.3 y §5.3).
//
// Este módulo existe por la misma razón que src/lib/tutor-turn.ts: el
// repositorio NO tiene runner de componentes React, así que lo que el cliente
// DECIDE —si hay panel, qué línea acompaña a la entrega, con qué tratamiento y
// bajo qué rol de accesibilidad— se extrae aquí y se prueba bajo Node pelado
// desde scripts/check-evidence-bridge.ts (§9 fila 64). Lo que queda en
// chat-client.tsx es cableado.
//
// LA RAZÓN CONCRETA DE ESTA COSTURA. El único precedente de fallo asíncrono del
// repositorio es la caja roja `role="alert"` de chat-client.tsx:241-245, y
// copiarla para un `failed` convertiría una comprobación fallida en lo que el
// goal 4 prohíbe: un castigo al estudiante por una URL que todavía no responde.
// Por eso el `role` VIAJA EN LA DECISIÓN y no se escribe a mano en el JSX —
// renderizar un `role="alert"` exigiría contradecir visiblemente este módulo, no
// simplemente olvidarse de él.
//
// NO IMPORTA NADA POR VALOR. Lo importa un Client Component, así que cualquier
// import de servidor viajaría al bundle del navegador: los tipos de
// `@shared/evidence` entran con `import type` y se borran al compilar (la misma
// regla que apps/web/CLAUDE.md § "Trampas registradas" declara para
// `@shared/*`).
//
// Regla de código: identificadores en inglés, comentarios en español.

import type { EvidenceItem } from "@shared/evidence";

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

/** La lección seleccionada, en la forma mínima que el panel necesita. Es un
 *  tipo local y no `EvidenceLesson` de `@shared/curriculum` a propósito: este
 *  módulo no debe conocer el currículo, sólo las dos llaves de §6.4. */
export type EvidencePanelLesson = {
  slug: string;
  evidenceKind?: string;
  evidencePrompt?: string;
};

/**
 * El estado de la lectura de montaje (`GET /api/evidence`), con las tres fases
 * que §4.3 distingue.
 *
 * `unavailable` TAMBIÉN LLEVA ITEMS, y no es redundante: una entrega que sí
 * aterrizó durante la sesión es conocimiento firme aunque la lectura inicial
 * fallara, y descartarlo repintaría el panel como "sin entrega" justo después
 * de que el estudiante entregara algo.
 */
export type EvidenceLoad =
  | { phase: "loading" }
  | { phase: "ready"; items: EvidenceItem[] }
  | { phase: "unavailable"; items: EvidenceItem[] };

export type EvidencePanelInput = {
  /** La lección del selector. `undefined` en la rama sin sesión, que no
   *  consulta la base de datos y por tanto no tiene lecciones. */
  lesson?: EvidencePanelLesson | null;
  load: EvidenceLoad;
  /** Hay una comprobación en vuelo: el viaje dura hasta
   *  EVIDENCE_BRIDGE_TIMEOUT_MS y éste es el guarda de doble envío (§4.3). */
  submitting: boolean;
  /** El último envío no aterrizó ninguna fila (el proxy devolvió 503, §4.2
   *  última fila). No es un estado de la entrega: es un estado del viaje. */
  submitFailed: boolean;
  /** El texto de `checkEvidenceUrl` cuando la última dirección tecleada no
   *  pasó la comprobación de forma. Viaja por aquí y no se pinta aparte para
   *  que TODA línea del panel siga saliendo de este módulo — que es lo que la
   *  fila 64 de §9 puede afirmar. */
  shapeError?: string | null;
};

// ---------------------------------------------------------------------------
// Salida
// ---------------------------------------------------------------------------

/**
 * La línea que acompaña a la entrega.
 *
 * `role` ES SIEMPRE `"status"` y el tipo lo fija: `aria-live="polite"`, igual
 * que el aviso de "el tutor está escribiendo" de chat-client.tsx:235-237, y
 * NUNCA `role="alert"` — que es lo que usa el error del tutor y lo que arrastra
 * la lectura de castigo (§4.3, "Accesibilidad").
 *
 * `tone` no tiene variante de error a propósito. Un `failed` es `neutral`: el
 * estado es de la comprobación, no del estudiante.
 */
export type EvidencePanelStatus = {
  text: string;
  tone: "neutral" | "affirmative";
  role: "status";
};

export type EvidencePanelView =
  | { visible: false }
  | {
      visible: true;
      /** Lo que se le pide al estudiante. Del currículo cuando lo declara. */
      prompt: string;
      /** La URL ya guardada, o `null` si no hay entrega conocida. */
      submittedUrl: string | null;
      status: EvidencePanelStatus | null;
      /** §4.3: deshabilitado mientras hay una comprobación en vuelo. */
      submitDisabled: boolean;
    };

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

/** Cuando la lección declara `evidenceKind` pero no `evidencePrompt`: las dos
 *  llaves son independientes y opcionales (§6.4), así que el panel tiene que
 *  saber pedir algo sin que el currículo se lo dicte. */
const DEFAULT_PROMPT = "Pega la dirección de lo que entregas en esta lección.";

const SUBMITTING_TEXT = "Comprobando esa dirección…";

// "no se pudo guardar" (§4.2, última fila): el viaje falló, la entrega no
// consta. Accionable y sin culpar a la URL, que aquí no se llegó a mirar.
const SUBMIT_FAILED_TEXT =
  "No pudimos guardar esa entrega. Reinténtalo en un momento; el chat sigue funcionando.";

// §4.3, "GET de montaje fallido": el panel se pinta en estado "sin entrega" con
// una línea que dice que no se pudo leer el estado anterior, y NUNCA bloquea la
// entrega — reenviar es idempotente, así que el peor caso es reenviar algo que
// ya estaba.
const LOAD_FAILED_TEXT =
  "No pudimos leer si ya habías entregado algo aquí. Puedes enviar de nuevo: reenviar no duplica nada.";

// ---------------------------------------------------------------------------
// Comprobación de forma, antes de salir del navegador
// ---------------------------------------------------------------------------

/**
 * POR QUÉ EXISTE, y por qué NO replica el DTO de apps/api.
 *
 * El puente aplica la regla positiva (§5.3): sólo un 200 con la forma esperada
 * produce resultado, así que el 400 del `ValidationPipe` llega al panel como el
 * mismo `{error:true}` que un 503 y se pinta como "reinténtalo en un momento".
 * Para un esquema equivocado ese mensaje es falso: reintentar igual falla igual,
 * y el issue es explícito en que un principiante con la URL mal escrita no puede
 * quedarse encerrado. §5.1 dejó el hueco declarado; esto lo cierra por el único
 * lado que no exige ensanchar el tipo de retorno del puente.
 *
 * Comprueba SÓLO lo que un principiante alcanza de verdad —`http://` y un
 * puerto distinto de 443— y no la forma del host: `net.isIP` no existe en el
 * navegador, y un host raro es infrecuente y da el mismo mensaje por los dos
 * caminos. **El servidor sigue siendo la autoridad**; esto es un atajo de
 * mensaje, no un control de seguridad, y por eso vive aquí y no en el guarda.
 */
export function checkEvidenceUrl(raw: string): { ok: true } | { ok: false; text: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return {
      ok: false,
      text: "Eso no parece una dirección web. Tiene que empezar por https:// y llevar un punto.",
    };
  }
  if (url.protocol !== "https:") {
    return { ok: false, text: "La dirección tiene que empezar por https:// para poder comprobarla." };
  }
  // El parser WHATWG borra el puerto por defecto del esquema, así que `port` es
  // "" para `https://x/` y para `https://x:443/` — ver §5.1.
  if (url.port !== "" && url.port !== "443") {
    return { ok: false, text: "Sólo podemos comprobar direcciones en el puerto estándar de https." };
  }
  return { ok: true };
}

/**
 * El tratamiento de cada estado de la fila, según la tabla de §4.3.
 *
 * `failed` es NEUTRO Y ACCIONABLE, nunca rojo de alerta y nunca la palabra
 * "error". Es la fila 64 de §9 y la razón de que este módulo exista.
 */
const STATUS_TEXT: Record<string, EvidencePanelStatus> = {
  // "Sin adorno de éxito ni de fallo": la URL quedó guardada y todavía no hay
  // veredicto que contar (§5.5 lo produce al descartar un veredicto tardío).
  declared: { text: "Entrega guardada.", tone: "neutral", role: "status" },
  verified: { text: "Comprobado: esa dirección responde.", tone: "affirmative", role: "status" },
  failed: {
    text: "No pudimos comprobar esa dirección; revísala y reenvía cuando quieras.",
    tone: "neutral",
    role: "status",
  },
};

// ---------------------------------------------------------------------------
// Decisiones
// ---------------------------------------------------------------------------

/** La fila de una lección dentro de lo que se haya podido leer, o `null`. */
export function findSubmission(
  load: EvidenceLoad,
  lessonSlug: string
): EvidenceItem | null {
  if (load.phase === "loading") return null;
  return load.items.find((item) => item.lessonSlug === lessonSlug) ?? null;
}

/**
 * Incorpora la fila que devolvió un `POST` al estado leído.
 *
 * Reemplaza por `lessonSlug` en vez de añadir: la llave de §6.1 es
 * `(usuario, lección)`, así que dos filas para la misma lección no existen en la
 * base y no deben existir aquí.
 *
 * Una lectura de montaje fallida SE QUEDA `unavailable`: la entrega recién hecha
 * es conocimiento firme, pero lo que no se pudo leer sigue sin leerse, y
 * ascender a `ready` haría que las demás lecciones se pintaran como "sin
 * entrega" sobre una lista que nunca llegó.
 */
export function applySubmission(
  load: EvidenceLoad,
  item: EvidenceItem
): EvidenceLoad {
  const previous = load.phase === "loading" ? [] : load.items;
  const items = [...previous.filter((i) => i.lessonSlug !== item.lessonSlug), item];
  return load.phase === "ready"
    ? { phase: "ready", items }
    : { phase: "unavailable", items };
}

/**
 * Qué pinta el panel, dado el estado completo del cliente.
 *
 * El orden de las tres primeras salidas es la tabla de §4.3 leída de arriba
 * abajo: sin `evidenceKind` no hay panel; con la lectura de montaje en vuelo el
 * panel NO se pinta todavía (no hay esqueleto: aparecer y saltar es peor que
 * aparecer una vez); y sólo después se decide la línea.
 */
export function decideEvidencePanel(input: EvidencePanelInput): EvidencePanelView {
  const { lesson, load, submitting, submitFailed, shapeError } = input;

  // Sin lección seleccionada, o una que no pide evidencia. `evidenceKind`
  // ausente ES la declaración de "esta lección no pide evidencia" (§6.4).
  if (!lesson || !lesson.evidenceKind) return { visible: false };

  if (load.phase === "loading") return { visible: false };

  const submission = findSubmission(load, lesson.slug);

  return {
    visible: true,
    prompt: lesson.evidencePrompt ?? DEFAULT_PROMPT,
    submittedUrl: submission?.url ?? null,
    status: decideStatusLine(submission, load, submitting, submitFailed, shapeError ?? null),
    submitDisabled: submitting,
  };
}

// Precedencia: lo que está pasando ahora manda sobre lo que pasó antes. Un
// envío en vuelo tapa el veredicto anterior porque ese veredicto ya no
// corresponde a lo que el estudiante acaba de mandar.
function decideStatusLine(
  submission: EvidenceItem | null,
  load: EvidenceLoad,
  submitting: boolean,
  submitFailed: boolean,
  shapeError: string | null
): EvidencePanelStatus | null {
  if (submitting) return { text: SUBMITTING_TEXT, tone: "neutral", role: "status" };
  // Antes que `submitFailed`: si la forma no pasó, no hubo viaje que fallara, y
  // decir "reinténtalo" sería el mensaje falso que esta comprobación cierra.
  // `neutral`, como todo lo demás: el estado es de la dirección, no del alumno.
  if (shapeError) return { text: shapeError, tone: "neutral", role: "status" };
  if (submitFailed) return { text: SUBMIT_FAILED_TEXT, tone: "neutral", role: "status" };
  if (submission) return STATUS_TEXT[submission.status] ?? null;
  if (load.phase === "unavailable") {
    return { text: LOAD_FAILED_TEXT, tone: "neutral", role: "status" };
  }
  return null;
}
