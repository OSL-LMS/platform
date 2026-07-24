import type { LessonId } from "./lessons";

// El calendario editable de la temporada — la única fuente de fechas del sitio.
// Regla de la home: ninguna fecha escrita a mano en el JSX; todo lo que diga
// "próxima clase" sale de aquí (ver `60 Negocio/Nueva home de academia.md`).
// Al terminar una temporada, si aún no hay fechas nuevas, la home entra sola
// en estado de pausa (nextSession() devuelve null): nunca miente.

export type Session = {
  lessonId: LessonId;
  /** Día de emisión en hora de Colombia (la clase empieza a las 20:00 UTC-5). */
  date: string;
  vodUrl?: string;
};

export const SEASON_SESSIONS: Session[] = [
  { lessonId: "L1", date: "2026-07-14", vodUrl: "https://www.youtube.com/watch?v=T6g1Ynm8r3c" },
  { lessonId: "L2", date: "2026-07-16" },
  { lessonId: "L3", date: "2026-07-21" },
  { lessonId: "L4", date: "2026-07-23" },
  { lessonId: "L5", date: "2026-07-28" },
  { lessonId: "L6", date: "2026-07-30" },
  { lessonId: "L7", date: "2026-08-04" },
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
