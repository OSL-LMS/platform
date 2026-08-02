// El calendario de la home, ya sin fechas dentro. PRD-008 §10 paso D saca
// `SEASON_SESSIONS` de `schedule.ts`: las emisiones son dato y llegan como
// argumento, así que este script trae SU PROPIO array de fixtures. Antes
// importaba el del módulo en seis sitios, y un test que se alimenta del dato que
// vigila deja de vigilarlo.
// Se ejecuta con: node scripts/check-schedule.ts
//
// Cubre las filas 12 a 19 de PRD-008 §9. Las filas 21 y 23 de PRD-002 §9, que
// este archivo cubría, NO se pierden: la 21 —una sesión deja de ser "la próxima"
// al TERMINAR, no al empezar— es ahora la fila 14, y la 23 —una sesión sin
// lección cargada degrada su fila— es la fila 17, reforzada, porque el caso ya
// no es un slug que nadie resolvió sino el `lessonSlug: ""` que produce el join
// a la izquierda de `@shared/broadcasts`.
import assert from "node:assert/strict";
import {
  agendaLine,
  closingHeading,
  formatSessionDate,
  formatSessionTime,
  isPast,
  nextSession,
  seasonAgenda,
  sessionStart,
  type Broadcast,
} from "../src/lib/schedule.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** El cargador de mentira de este script: 20:00 en Colombia, UTC-5 sin DST.
 *  La composición vive en `scripts/load-seasons.ts` desde PRD-008 §6.2 y lo que
 *  llega a `schedule.ts` es ya un instante ABSOLUTO; aquí se rehace para poder
 *  escribir los fixtures con fechas legibles. El desfase es explícito, así que
 *  no depende de la `TZ` del proceso — que es lo que hace honesta la fila 15. */
function at(date: string): Date {
  return new Date(`${date}T20:00:00-05:00`);
}

let seq = 0;
function broadcast(
  season: string,
  lessonSlug: string,
  date: string,
  vodUrl: string | null = null
): Broadcast {
  seq += 1;
  return { id: `bc-${seq}`, season, lessonSlug, startsAt: at(date), vodUrl };
}

/** Las siete emisiones de la temporada en emisión, con el formato que cada una
 *  tiene que producir. Es a la vez el fixture del script y el golden de la
 *  fila 15. */
const T1_ROWS: Array<[lessonSlug: string, date: string, formatted: string]> = [
  ["L1", "2026-07-14", "martes 14 jul"],
  ["L2", "2026-07-16", "jueves 16 jul"],
  ["L3", "2026-07-21", "martes 21 jul"],
  ["L4", "2026-07-23", "jueves 23 jul"],
  ["L5", "2026-07-28", "martes 28 jul"],
  ["L6", "2026-07-30", "jueves 30 jul"],
  ["L7", "2026-08-04", "martes 4 ago"],
];

const VOD_L1 = "https://www.youtube.com/watch?v=T6g1Ynm8r3c";

const T1: Broadcast[] = T1_ROWS.map(([slug, date]) =>
  broadcast("2026-t1", slug, date, slug === "L1" ? VOD_L1 : null)
);

/** Una segunda temporada que REEMITE L1 y L3 — el caso del goal 2, y el que
 *  rompe los dos identificadores de §4.3. Deliberadamente desordenada: nada
 *  garantiza que un fixture llegue en orden de calendario. */
const T2: Broadcast[] = [
  broadcast("2026-t2", "L3", "2026-10-08"),
  broadcast("2026-t2", "L1", "2026-10-06"),
];

/** El temario cargado, con la forma estructural que `seasonAgenda` pide. */
const LESSONS = T1_ROWS.map(([slug], i) => ({
  slug,
  title: `Título ${i + 1}`,
  payload: { outcome: `Resultado ${i + 1}` },
}));

/** A mitad de temporada: L1 y L2 emitidas, L3 es la próxima. */
const MID = new Date("2026-07-20T00:00:00Z");

/** Las dos temporadas, con la SEGUNDA primero: el orden de llegada no es el
 *  orden del calendario, y las filas 12 y 18 existen para eso. */
const MIXED: Broadcast[] = [...T2, ...T1];

// ---------------------------------------------------------------------------
// Fila 12 — `nextSession`: la primera futura EN EL TIEMPO, no la del array
// ---------------------------------------------------------------------------
{
  const next = nextSession(MIXED, MID);
  assert.equal(next?.lessonSlug, "L3", "la próxima es la más cercana en el tiempo");
  assert.equal(next?.season, "2026-t1", "y es la de la temporada en curso, no la reemisión");
  assert.equal(next?.id, T1[2].id);

  // Los cortes de las dos horas de clase, con el calendario real. L3 se emite el
  // 21 jul 20:00 en Colombia = 22 jul 01:00 UTC y termina a las 03:00 UTC.
  assert.equal(nextSession(MIXED, new Date("2026-07-22T00:00:00Z"))?.id, T1[2].id);
  assert.equal(nextSession(MIXED, new Date("2026-07-22T04:00:00Z"))?.id, T1[3].id);

  // Terminada la primera temporada la próxima es la reemisión, no `null`: la
  // pausa es "no queda ninguna futura", no "se acabó esta temporada".
  assert.equal(nextSession(MIXED, new Date("2026-09-01T00:00:00Z"))?.season, "2026-t2");
}

// ---------------------------------------------------------------------------
// Fila 13 — `nextSession` sin futuras → `null` (la pausa, goal 3)
// ---------------------------------------------------------------------------
{
  assert.equal(nextSession(MIXED, new Date("2030-01-01T00:00:00Z")), null);
  assert.equal(nextSession([], MID), null, "sin ninguna emisión también es pausa");

  // Y los dos textos de la home entran en su rama de pausa por ese `null`, que
  // es el estado que §4.2 manda conservar literalmente en los DOS sitios.
  assert.equal(
    agendaLine(null),
    "Pausa entre temporadas — las grabaciones siguen abiertas, gratis"
  );
  assert.equal(closingHeading(null), "Las grabaciones te esperan. Puedes estar dentro.");
  assert.equal(agendaLine(T1[2]), "Próxima clase — martes 21 jul · 20:00 Colombia · en Twitch");
  assert.equal(closingHeading(T1[2]), "La próxima clase es este martes. Puedes estar dentro.");
}

// ---------------------------------------------------------------------------
// Fila 14 — `isPast`: deja de ser próxima al TERMINAR, no al empezar
// ---------------------------------------------------------------------------
{
  const first = T1[0];
  const start = sessionStart(first);
  assert.equal(start.getTime(), first.startsAt.getTime(), "sessionStart es ya un accesor");

  assert.equal(isPast(first, new Date(start.getTime() - 1)), false);
  assert.equal(isPast(first, new Date(start.getTime())), false, "justo al empezar");
  assert.equal(isPast(first, new Date(start.getTime() + 60 * 60 * 1000)), false, "a mitad de clase");
  assert.equal(isPast(first, new Date(start.getTime() + 2 * 60 * 60 * 1000)), false, "al filo");
  assert.equal(isPast(first, new Date(start.getTime() + 2 * 60 * 60 * 1000 + 1)), true);
}

// ---------------------------------------------------------------------------
// Fila 15 — `formatSessionDate` no cambió, y no depende de la `TZ` (goal 5)
// ---------------------------------------------------------------------------
{
  const originalTz = process.env.TZ;
  // Las dos que más lejos caen del UTC-5 de Colombia, una a cada lado: si el
  // formato leyese los componentes locales del proceso, con Tokyo el día
  // saltaría hacia delante y con Honolulu hacia atrás.
  for (const tz of ["UTC", "Asia/Tokyo", "Pacific/Honolulu"]) {
    process.env.TZ = tz;
    for (const [slug, date, formatted] of T1_ROWS) {
      assert.equal(
        formatSessionDate({ id: slug, season: "2026-t1", lessonSlug: slug, startsAt: at(date), vodUrl: null }),
        formatted,
        `${slug} cambió de formato bajo TZ=${tz}`
      );
    }
  }
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
}

// ---------------------------------------------------------------------------
// Fila 15 (hermana) — la HORA también sale del dato, no de un literal
// ---------------------------------------------------------------------------
//
// Ese "20:00" estaba escrito a mano en tres sitios y ninguno derivaba de la
// emisión. Coincidían por casualidad: la única temporada cargada empieza a las
// 20:00. Pero `startsAtLocal` es dato POR TEMPORADA (§6.4) justo para que otra
// pueda ser distinta, y ese día la fecha seguiría bien —se calcula del
// instante— y la hora mentiría sin que nada se pusiera rojo. Misma clase de
// fallo que §4.4 cerró para el número de clases, con el reloj en vez del conteo.
{
  const veinte = broadcast("2026-t1", "L1", "2026-07-14");
  assert.equal(formatSessionTime(veinte), "20:00");

  // Una temporada a otra hora: es el caso que el literal no podía representar.
  const siete = {
    id: "bc-tarde",
    season: "2026-t2",
    lessonSlug: "L1",
    startsAt: new Date("2026-09-15T19:30:00-05:00"),
    vodUrl: null,
  };
  assert.equal(formatSessionTime(siete), "19:30", "la hora tiene que salir del instante");
  assert.equal(formatSessionDate(siete), "martes 15 sep", "y la fecha seguir siendo correcta");

  // Y el renglón del banner la usa, en vez de repetirla a mano.
  assert.match(agendaLine(siete), /19:30 Colombia/);

  // No depende de la `TZ` del proceso, por lo mismo que la fecha.
  const originalTz2 = process.env.TZ;
  for (const tz of ["UTC", "Asia/Tokyo", "Pacific/Honolulu"]) {
    process.env.TZ = tz;
    assert.equal(formatSessionTime(siete), "19:30", `la hora cambió bajo TZ=${tz}`);
  }
  if (originalTz2 === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz2;
}

// ---------------------------------------------------------------------------
// Fila 16 — `seasonAgenda`: `isNext` se decide por `id`, no por slug (§4.3)
// ---------------------------------------------------------------------------
{
  const groups = seasonAgenda(MIXED, LESSONS, MID);
  const rows = groups.flatMap((g) => g.rows);

  const marked = rows.filter((r) => r.isNext);
  assert.equal(marked.length, 1, "sólo una fila puede ser la próxima");
  assert.equal(marked[0].broadcast.id, T1[2].id);
  assert.equal(marked[0].broadcast.season, "2026-t1");

  // La otra L3 —la reemisión de la segunda temporada— NO se marca. Con la
  // comparación por slug de antes de PRD-008 se marcaban las dos.
  const reemitida = rows.find((r) => r.broadcast.season === "2026-t2" && r.broadcast.lessonSlug === "L3");
  assert.ok(reemitida, "la reemisión tiene que estar en la agenda");
  assert.equal(reemitida.isNext, false);

  // Y las claves de React que salen de aquí son únicas, que es la otra mitad de
  // §4.3: dos filas con `key="L3"` es el fallo que esto previene.
  const ids = rows.map((r) => r.broadcast.id);
  assert.equal(new Set(ids).size, ids.length, "los `id` de emisión son únicos");
  const slugs = rows.map((r) => r.broadcast.lessonSlug);
  assert.notEqual(new Set(slugs).size, slugs.length, "el fixture repite slugs a propósito");
}

// ---------------------------------------------------------------------------
// Fila 17 — una emisión sin lección resuelta SIGUE en la agenda (§6.3, §7.3)
// ---------------------------------------------------------------------------
{
  // `lessonSlug: ""` es lo que produce el join a la izquierda cuando el nodo del
  // temario ya no existe. La clase ocurrió y su grabación existe: la fila
  // degrada a título vacío, no desaparece.
  const retirada = broadcast("2026-t1", "", "2026-07-09", "https://www.youtube.com/watch?v=zzz");
  const groups = seasonAgenda([retirada, ...T1], LESSONS, MID);
  const rows = groups.flatMap((g) => g.rows);

  assert.equal(rows.length, T1.length + 1, "no se pierde ninguna fila");
  assert.equal(rows[0].broadcast.id, retirada.id, "y va primera, por fecha");
  assert.equal(rows[0].title, "");
  assert.equal(rows[0].outcome, "");
  assert.equal(rows[0].emitted, true);
  assert.equal(rows[0].broadcast.vodUrl, "https://www.youtube.com/watch?v=zzz", "conserva su VOD");
  assert.equal(formatSessionDate(rows[0].broadcast), "jueves 9 jul");

  // Temario entero sin cargar: la home sigue pintando el calendario.
  const sinTemario = seasonAgenda(T1, [], MID).flatMap((g) => g.rows);
  assert.equal(sinTemario.length, T1.length);
  assert.ok(sinTemario.every((r) => r.title === "" && r.outcome === ""));
  assert.equal(sinTemario.filter((r) => r.isNext).length, 1, "sigue habiendo una próxima");
}

// ---------------------------------------------------------------------------
// Fila 18 — `seasonAgenda` agrupa por temporada, ordenada por primera emisión
// ---------------------------------------------------------------------------
{
  const groups = seasonAgenda(MIXED, LESSONS, MID);

  assert.equal(groups.length, 2, "dos temporadas → dos grupos");
  assert.deepEqual(
    groups.map((g) => g.season),
    ["2026-t1", "2026-t2"],
    "los grupos salen en orden de primera emisión, no de llegada"
  );

  for (const group of groups) {
    const starts = group.rows.map((r) => r.broadcast.startsAt.getTime());
    assert.deepEqual(starts, [...starts].sort((a, b) => a - b), `${group.season} sin ordenar`);
    assert.ok(
      group.rows.every((r) => r.broadcast.season === group.season),
      `${group.season} lleva una emisión de otra temporada`
    );
  }

  assert.deepEqual(groups[0].rows.map((r) => r.broadcast.lessonSlug), T1_ROWS.map(([s]) => s));
  // El fixture de T2 llega con L3 antes que L1 y sale al revés, por fecha.
  assert.deepEqual(groups[1].rows.map((r) => r.broadcast.lessonSlug), ["L1", "L3"]);

  // Con UNA temporada hay UN grupo: es lo que permite al JSX no pintar
  // encabezado y dejar la tabla de hoy intacta (§4.4).
  const una = seasonAgenda(T1, LESSONS, MID);
  assert.equal(una.length, 1);
  assert.equal(una[0].season, "2026-t1");
  assert.equal(una[0].rows.length, T1.length);
}

// ---------------------------------------------------------------------------
// Fila 19 — sin emisiones, la agenda es vacía (goal 6)
// ---------------------------------------------------------------------------
{
  assert.deepEqual(seasonAgenda([], LESSONS, MID), []);
  assert.deepEqual(seasonAgenda([], [], MID), [], "y sin temario tampoco revienta");
}

console.log(
  `OK — calendario sano: ${T1.length + T2.length} emisiones en 2 temporadas, agrupado, ` +
    `próxima por id, degradación y pausa cubiertas.`
);
