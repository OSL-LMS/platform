// El calendario de la temporada. Hoy este módulo no tenía ninguna cobertura y
// PRD-002 lo modifica: `LessonId` deja de existir y `seasonAgenda()` nace para
// que una sesión sin lección cargada degrade su fila en vez de tumbar la home.
// Se ejecuta con: node scripts/check-schedule.ts
//
// Cubre las filas 21 y 23 de PRD-002 §9.
import assert from "node:assert/strict";
import {
  SEASON_SESSIONS,
  formatSessionDate,
  isPast,
  nextSession,
  seasonAgenda,
  sessionStart,
} from "../src/lib/schedule.ts";

// ---------------------------------------------------------------------------
// Fila 21 — `schedule.ts` sigue en pie contra el tipo de slug nuevo
// ---------------------------------------------------------------------------
{
  const first = SEASON_SESSIONS[0];
  assert.equal(typeof first.lessonSlug, "string");

  // Una sesión deja de ser "la próxima" cuando TERMINA, no cuando empieza.
  const start = sessionStart(first);
  assert.equal(isPast(first, new Date(start.getTime() - 1)), false);
  assert.equal(isPast(first, new Date(start.getTime() + 60 * 60 * 1000)), false, "a mitad de clase");
  assert.equal(isPast(first, new Date(start.getTime() + 2 * 60 * 60 * 1000 + 1)), true);

  // La próxima es la primera no pasada; terminada la temporada, `null` (pausa).
  assert.equal(nextSession(new Date("2026-07-14T00:00:00Z"))?.lessonSlug, "L1");
  // L3 se emite el 21 jul 20:00 en Colombia = 22 jul 01:00 UTC, y termina a las
  // 03:00 UTC. A las 00:00 UTC del 22 todavía no ha empezado; a las 04:00 ya
  // terminó. Las dos horas de clase son justo lo que separa estas dos líneas.
  assert.equal(nextSession(new Date("2026-07-22T00:00:00Z"))?.lessonSlug, "L3");
  assert.equal(nextSession(new Date("2026-07-22T04:00:00Z"))?.lessonSlug, "L4");
  assert.equal(nextSession(new Date("2030-01-01T00:00:00Z")), null);

  // Formato manual y determinista: no depende de los locales ICU del runtime.
  assert.equal(formatSessionDate({ lessonSlug: "L1", date: "2026-07-14" }), "martes 14 jul");
  assert.equal(formatSessionDate({ lessonSlug: "L7", date: "2026-08-04" }), "martes 4 ago");
}

// ---------------------------------------------------------------------------
// Fila 23 — sesión sin lección cargada: degrada la fila, no la página
// ---------------------------------------------------------------------------
{
  const loaded = SEASON_SESSIONS.slice(0, 3).map((s, i) => ({
    slug: s.lessonSlug,
    title: `Título ${i}`,
    payload: { outcome: `Resultado ${i}` },
  }));

  // Estado estable, no solo el corte inicial: `SEASON_SESSIONS` viaja con el
  // código y el temario solo es efectivo tras `curriculum:load --write`.
  const rows = seasonAgenda(loaded, new Date("2026-07-20T00:00:00Z"));
  assert.equal(rows.length, SEASON_SESSIONS.length, "no se pierde ninguna fila");

  assert.equal(rows[0].title, "Título 0");
  assert.equal(rows[0].outcome, "Resultado 0");
  assert.equal(rows[0].emitted, true);

  // La fila 4 en adelante no tiene nodo cargado: se degrada, con su slug y su
  // fecha intactos.
  assert.equal(rows[3].title, "");
  assert.equal(rows[3].outcome, "");
  assert.equal(rows[3].session.lessonSlug, "L4");
  assert.equal(formatSessionDate(rows[3].session), "jueves 23 jul");

  // Currículo entero sin cargar: la home sigue pintando el calendario.
  const empty = seasonAgenda([], new Date("2026-07-20T00:00:00Z"));
  assert.equal(empty.length, SEASON_SESSIONS.length);
  assert.ok(empty.every((r) => r.title === "" && r.outcome === ""));
  assert.equal(empty.filter((r) => r.isNext).length, 1, "sigue habiendo una próxima");
}

console.log(`OK — calendario sano: ${SEASON_SESSIONS.length} sesiones, degradación cubierta.`);
