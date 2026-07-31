// El calendario editable de la temporada — la única fuente de fechas del sitio.
// Regla de la home: ninguna fecha escrita a mano en el JSX; todo lo que diga
// "próxima clase" sale de aquí (ver `60 Negocio/Nueva home de academia.md`).
// Al terminar una temporada, si aún no hay fechas nuevas, la home entra sola
// en estado de pausa (nextSession() devuelve null): nunca miente.
//
// `lessonSlug` es el slug público de un nodo `lesson` de `curriculum_nodes`,
// no un tipo cerrado: el temario vive en `curriculum/<slug>.json` y se carga
// aparte, así que este módulo no puede validarlo en compilación. Rediseñarlo
// es CON-7; hasta entonces conserva sus literales L1–L7 (PRD-002 §10).
//
// Regla de código: identificadores en inglés, comentarios en español.

export type Session = {
  lessonSlug: string;
  /** Día de emisión en hora de Colombia (la clase empieza a las 20:00 UTC-5). */
  date: string;
  vodUrl?: string;
};

export const SEASON_SESSIONS: Session[] = [
  { lessonSlug: "L1", date: "2026-07-14", vodUrl: "https://www.youtube.com/watch?v=T6g1Ynm8r3c" },
  { lessonSlug: "L2", date: "2026-07-16" },
  { lessonSlug: "L3", date: "2026-07-21" },
  { lessonSlug: "L4", date: "2026-07-23" },
  { lessonSlug: "L5", date: "2026-07-28" },
  { lessonSlug: "L6", date: "2026-07-30" },
  { lessonSlug: "L7", date: "2026-08-04" },
];

const CLASS_DURATION_MS = 2 * 60 * 60 * 1000;

export function sessionStart(session: Session): Date {
  return new Date(`${session.date}T20:00:00-05:00`);
}

/** Una sesión deja de ser "la próxima" cuando termina, no cuando empieza. */
export function isPast(session: Session, now = new Date()): boolean {
  return now.getTime() > sessionStart(session).getTime() + CLASS_DURATION_MS;
}

/** La próxima sesión por emitir, o null si la temporada terminó (pausa). */
export function nextSession(now = new Date()): Session | null {
  return SEASON_SESSIONS.find((s) => !isPast(s, now)) ?? null;
}

// Formato manual y determinista: no depende de los locales ICU del runtime.
const WEEKDAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/** "martes 28 jul" — siempre en hora de Colombia (UTC-5, sin DST). */
export function formatSessionDate(session: Session): string {
  const start = sessionStart(session);
  const colombia = new Date(start.getTime() - 5 * 60 * 60 * 1000);
  return `${WEEKDAYS[colombia.getUTCDay()]} ${colombia.getUTCDate()} ${MONTHS[colombia.getUTCMonth()]}`;
}

/** Lo mínimo que este módulo necesita saber de una lección. Tipado estructural
 *  a propósito: `schedule.ts` no importa la capa de currículo. */
type LessonLike = { slug: string; title: string; payload: Record<string, unknown> };

export type SeasonRow = {
  session: Session;
  /** Vacíos si la lección no está cargada — la fila degrada, no revienta. */
  title: string;
  outcome: string;
  emitted: boolean;
  isNext: boolean;
};

/**
 * Empareja el calendario con las lecciones cargadas.
 *
 * Desde PRD-002, `SEASON_SESSIONS` (viaja con el código) y
 * `curriculum/<slug>.json` (efectivo solo tras `curriculum:load --write`) son
 * **dos artefactos que se despliegan por separado**. Antes iban en el mismo
 * commit compilado y un desajuste era un error de compilación; ahora una sesión
 * puede apuntar a un nodo que todavía no existe. Esa fila se degrada; la home
 * no se cae.
 */
export function seasonAgenda(lessons: LessonLike[], now = new Date()): SeasonRow[] {
  const bySlug = new Map(lessons.map((l) => [l.slug, l]));
  const next = nextSession(now);
  return SEASON_SESSIONS.map((session) => {
    const lesson = bySlug.get(session.lessonSlug);
    return {
      session,
      title: lesson?.title ?? "",
      outcome: typeof lesson?.payload.outcome === "string" ? lesson.payload.outcome : "",
      emitted: isPast(session, now),
      isNext: next?.lessonSlug === session.lessonSlug,
    };
  });
}
