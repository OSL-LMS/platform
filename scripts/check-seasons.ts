// Comprobaciones PURAS del archivo de temporadas: forma, contrato y control de
// URLs. No tocan Postgres a propósito — es lo que permite correrlas enteras
// sobre un PR (PRD-008 §4.1 paso 2). Se ejecuta con:
//   node scripts/check-seasons.ts
//
// Cubre las filas 1 a 11 de PRD-008 §9.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  parseSeasonsFile,
  resolveBroadcasts,
  type LessonRef,
} from "../packages/shared/src/broadcasts-file.ts";
import { parseCurriculumFile } from "../packages/shared/src/curriculum-file.ts";
import { URL_EVASIONS, URL_EVASION_COUNT } from "./url-evasion-fixtures.ts";

const ROOT = resolve(import.meta.dirname, "..");

/** Falla si `fn` NO lanza, o si el mensaje no nombra la emisión y la regla. */
function rejects(fn: () => unknown, ...expected: RegExp[]): void {
  let error: Error | null = null;
  try {
    fn();
  } catch (err) {
    error = err as Error;
  }
  assert.ok(error, `se esperaba un rechazo y no lo hubo (${expected.join(", ")})`);
  for (const pattern of expected) assert.match(error.message, pattern);
}

const uuid = () => crypto.randomUUID();

type Raw = Record<string, unknown>;

const broadcast = (over: Raw = {}): Raw => ({
  id: uuid(),
  lessonSlug: "L1",
  date: "2026-07-14",
  ...over,
});

const season = (over: Raw = {}): Raw => ({
  season: "2026-t1",
  startsAtLocal: "20:00",
  utcOffset: "-05:00",
  broadcasts: [broadcast()],
  ...over,
});

const file = (seasons: Raw[]) => ({ curriculum: "test", seasons });

/** Un currículo de mentira con lo justo: dos lecciones, una etapa y un módulo.
 *  La etapa y el módulo existen para la fila 3 — un slug que resuelve pero no
 *  es emitible. */
const LESSONS: LessonRef[] = [
  { id: uuid(), slug: "L1", kind: "lesson" },
  { id: uuid(), slug: "L2", kind: "lesson" },
  { id: uuid(), slug: "E1", kind: "stage" },
  { id: uuid(), slug: "m1", kind: "module" },
];

const parseOf = (seasons: Raw[]) => parseSeasonsFile(file(seasons));
const resolveOf = (seasons: Raw[]) => resolveBroadcasts(parseOf(seasons).broadcasts, LESSONS);

// ---------------------------------------------------------------------------
// Fila 1 — forma mínima: una temporada, una emisión, parsea y aplana
// ---------------------------------------------------------------------------
{
  const parsed = parseOf([season()]);
  assert.equal(parsed.curriculum, "test");
  assert.equal(parsed.broadcasts.length, 1);

  const [emission] = parsed.broadcasts;
  assert.equal(emission.season, "2026-t1");
  assert.equal(emission.lessonSlug, "L1");
  assert.equal(emission.curriculum, "test");
  assert.equal(emission.vodUrl, null, "sin `vodUrl` la emisión vale null, no undefined");
  assert.ok(emission.startsAt instanceof Date);

  // Y con el currículo delante, la emisión gana su `lessonNodeId`.
  const [resolved] = resolveBroadcasts(parsed.broadcasts, LESSONS);
  assert.equal(resolved.lessonNodeId, LESSONS[0].id);
}

// ---------------------------------------------------------------------------
// Fila 2 — un `lessonSlug` inexistente rechaza el ARCHIVO ENTERO
// ---------------------------------------------------------------------------
//
// Es la garantía que daba el tipo `LessonId` y que se perdió en PRD-002 (goal
// 4). Lo que importa además del rechazo es que NO haya filas parciales: la
// primera emisión de este archivo sí resuelve, y aun así no sale ninguna.
{
  const seasons = [
    season({
      broadcasts: [
        broadcast({ lessonSlug: "L1" }),
        broadcast({ lessonSlug: "L9", date: "2026-07-16" }),
      ],
    }),
  ];

  // El parseo puro no resuelve slugs: las dos emisiones salen de ahí.
  assert.equal(parseOf(seasons).broadcasts.length, 2);

  rejects(() => resolveOf(seasons), /L9/, /no existe/);

  let rows: unknown = "no se llamó";
  try {
    rows = resolveOf(seasons);
  } catch {
    rows = null;
  }
  assert.equal(rows, null, "devolvió filas parciales a pesar de rechazar el archivo");
}

// ---------------------------------------------------------------------------
// Fila 3 — un slug que existe pero NO es `kind: "lesson"` también rechaza
// ---------------------------------------------------------------------------
//
// Más fuerte que el tipo `LessonId`, que sólo cubría la existencia. Una etapa
// no se emite, y un módulo tampoco.
{
  rejects(() => resolveOf([season({ broadcasts: [broadcast({ lessonSlug: "E1" })] })]), /E1/, /stage/);
  rejects(() => resolveOf([season({ broadcasts: [broadcast({ lessonSlug: "m1" })] })]), /m1/, /module/);
}

// ---------------------------------------------------------------------------
// Fila 4 — fecha no parseable o fuera de rango
// ---------------------------------------------------------------------------
{
  // Ni forma de fecha.
  rejects(() => parseOf([season({ broadcasts: [broadcast({ date: "mañana" })] })]), /L1/, /YYYY-MM-DD/);
  rejects(() => parseOf([season({ broadcasts: [broadcast({ date: 20260714 })] })]), /YYYY-MM-DD/);

  // Con forma de fecha y fuera del calendario. `2026-02-31` es el caso que
  // importa: `new Date("2026-02-31T20:00:00-05:00")` NO es inválido en V8, se
  // desborda en silencio al 3 de marzo. Sin esta fila, el archivo diría una
  // fecha y la tabla guardaría otra.
  for (const date of ["2026-13-45", "2026-02-31", "2026-04-31", "2026-00-10", "2026-01-00"]) {
    rejects(() => parseOf([season({ broadcasts: [broadcast({ date })] })]), /L1/, /calendario/);
  }

  // Y el 29 de febrero de un bisiesto SÍ existe: la regla no es un rechazo
  // indiscriminado de todo lo que no sea día 28.
  assert.equal(parseOf([season({ broadcasts: [broadcast({ date: "2028-02-29" })] })]).broadcasts.length, 1);
}

// ---------------------------------------------------------------------------
// Fila 5 — `id` duplicado o no-UUID
// ---------------------------------------------------------------------------
{
  rejects(() => parseOf([season({ broadcasts: [broadcast({ id: "no-es-uuid" })] })]), /L1/, /UUID/);
  rejects(() => parseOf([season({ broadcasts: [broadcast({ id: undefined })] })]), /UUID/);

  const repeated = uuid();
  rejects(
    () =>
      parseOf([
        season({
          broadcasts: [
            broadcast({ id: repeated, lessonSlug: "L1" }),
            broadcast({ id: repeated, lessonSlug: "L2", date: "2026-07-16" }),
          ],
        }),
      ]),
    /duplicado/
  );

  // Y el `id` repetido entre DOS temporadas también: es la identidad global de
  // la emisión, no una etiqueta por temporada.
  rejects(
    () =>
      parseOf([
        season({ broadcasts: [broadcast({ id: repeated })] }),
        season({ season: "2026-t2", broadcasts: [broadcast({ id: repeated })] }),
      ]),
    /duplicado/
  );
}

// ---------------------------------------------------------------------------
// Fila 6 — `season` fuera de `SLUG_PATTERN`
// ---------------------------------------------------------------------------
//
// Participa en la clave única y en el agrupado de la tabla de la home, así que
// no puede ser texto libre.
{
  for (const bad of ["2026 t1", "2026-t1 ", "temporada uno", "otoño", "a".repeat(65), "", 7]) {
    rejects(() => parseOf([season({ season: bad })]), /season/);
  }
  // 64 caracteres sí caben: la cota es la del patrón, no una arbitraria.
  assert.equal(parseOf([season({ season: "a".repeat(64) })]).broadcasts.length, 1);

  // La hora y el desfase de la temporada llevan su propia forma.
  for (const bad of ["20:00:00", "8pm", "24:00", "20-00"]) {
    rejects(() => parseOf([season({ startsAtLocal: bad })]), /startsAtLocal/);
  }
  for (const bad of ["-5:00", "05:00", "-05", "Z"]) {
    rejects(() => parseOf([season({ utcOffset: bad })]), /utcOffset/);
  }
}

// ---------------------------------------------------------------------------
// Fila 7 — la clave única de §6.1, sus DOS mitades
// ---------------------------------------------------------------------------
{
  // (a) misma lección, misma temporada y MISMA fecha: rechazo.
  rejects(
    () =>
      parseOf([
        season({
          broadcasts: [
            broadcast({ lessonSlug: "L1", date: "2026-07-14" }),
            broadcast({ lessonSlug: "L1", date: "2026-07-14" }),
          ],
        }),
      ]),
    /L1/,
    /mismo instante/
  );

  // (b) misma lección, misma temporada, fechas DISTINTAS: legal. Es la clase de
  //     recuperación, o la cohorte que se parte y recibe L1 dos veces. El
  //     borrador anterior de §6.1 lo prohibía por accidente al dejar la fecha
  //     fuera de la clave.
  const twice = parseOf([
    season({
      broadcasts: [
        broadcast({ lessonSlug: "L1", date: "2026-07-14" }),
        broadcast({ lessonSlug: "L1", date: "2026-07-21" }),
      ],
    }),
  ]);
  assert.equal(twice.broadcasts.length, 2, "dos emisiones de L1 en fechas distintas son legales");
  assert.equal(resolveBroadcasts(twice.broadcasts, LESSONS).length, 2);
}

// ---------------------------------------------------------------------------
// Fila 8 — la misma lección en DOS temporadas es legal
// ---------------------------------------------------------------------------
//
// El caso del goal 2, que la clave única no debe impedir: una temporada nueva
// que reemite las mismas lecciones, sin que la primera pierda su grabación.
{
  const parsed = parseOf([
    season({ broadcasts: [broadcast({ lessonSlug: "L1", date: "2026-07-14", vodUrl: "https://youtu.be/abc" })] }),
    season({ season: "2026-t2", broadcasts: [broadcast({ lessonSlug: "L1", date: "2026-11-10" })] }),
  ]);
  assert.equal(parsed.broadcasts.length, 2);
  assert.deepEqual(parsed.broadcasts.map((b) => b.season), ["2026-t1", "2026-t2"]);
  assert.equal(parsed.broadcasts[0].vodUrl, "https://youtu.be/abc", "la primera conserva su grabación");
  assert.equal(parsed.broadcasts[1].vodUrl, null);
}

// ---------------------------------------------------------------------------
// Fila 9 — el desfase se aplica AL CARGAR
// ---------------------------------------------------------------------------
//
// Lo que se guarda es un instante ABSOLUTO. El instante se compone de los
// componentes con `Date.UTC`, así que este resultado no depende de la `TZ` del
// proceso — la fila 25, que lee la columna bajo dos `TZ`, es la otra mitad.
{
  const [emission] = parseOf([
    season({ broadcasts: [broadcast({ lessonSlug: "L1", date: "2026-09-15" })] }),
  ]).broadcasts;
  assert.equal(emission.startsAt.toISOString(), "2026-09-16T01:00:00.000Z");

  // Las siete de hoy: 20:00 Colombia es 01:00 UTC del día siguiente.
  const [julio] = parseOf([
    season({ broadcasts: [broadcast({ date: "2026-07-14" })] }),
  ]).broadcasts;
  assert.equal(julio.startsAt.toISOString(), "2026-07-15T01:00:00.000Z");

  // Y el desfase declarado es el que manda, no uno quemado: con +00:00 el
  // instante es otro.
  const [utc] = parseOf([
    season({ utcOffset: "+00:00", broadcasts: [broadcast({ date: "2026-07-14" })] }),
  ]).broadcasts;
  assert.equal(utc.startsAt.toISOString(), "2026-07-14T20:00:00.000Z");
}

// ---------------------------------------------------------------------------
// Fila 10 — `vodUrl` hostil, con LA TABLA DE FIXTURES COMPARTIDA
// ---------------------------------------------------------------------------
//
// Las catorce corren aquí y en `check-curriculum.ts` desde una sola fuente
// (`url-evasion-fixtures.ts`) sobre una sola implementación del detector
// (§6.4). Tres casos ad-hoc dejarían pasar tabulador-en-esquema, prefijo C0 y
// barra invertida.
{
  assert.equal(
    URL_EVASIONS.length,
    URL_EVASION_COUNT,
    "la tabla de evasión cambió de tamaño: son catorce y cada una cubre un bypass distinto"
  );
  // EL PATRÓN NO ADMITE `https`, Y ES LA MITAD DE ESTA FILA. Con esa tercera
  // alternativa la comprobación no probaba nada: ninguna de las catorce empieza
  // por `https://` —los tabuladores parten el `//`, los controles C0 van
  // delante, las de barra invertida no empiezan por `https` y `javascript:`
  // menos—, así que todas las caza también el control de esquema de
  // `broadcasts-file.ts`, cuyo mensaje contiene "https". Si `checkUrlSafety`
  // fuera un no-op mañana, las catorce seguirían rechazándose por el prefijo y
  // esta mitad de la fila 10 seguiría verde: exactamente el fallo que la tabla
  // compartida existe para impedir, reintroducido una capa más arriba.
  //
  // Exigiendo "esquema" o "allowlist" —el mismo patrón que `check-curriculum.ts`—
  // sólo pasan si el DETECTOR las rechaza. El orden lo permite:
  // `broadcasts-file.ts:211` llama a `checkUrlSafety` ANTES del prefijo.
  for (const evasion of URL_EVASIONS) {
    rejects(
      () => parseOf([season({ broadcasts: [broadcast({ vodUrl: evasion })] })]),
      /esquema|allowlist/
    );
  }

  // Host fuera de la allowlist, sin evasión ninguna.
  rejects(
    () => parseOf([season({ broadcasts: [broadcast({ vodUrl: "https://evil.example.com/x" })] })]),
    /allowlist/
  );
  // Y `https://youtube.com@evil.example.com/` — que a un humano le parece
  // YouTube en un diff de JSON y cuyo host real es otro. Lo caza la allowlist y
  // SÓLO la allowlist: el CHECK de la columna lo admite.
  rejects(
    () =>
      parseOf([
        season({ broadcasts: [broadcast({ vodUrl: "https://youtube.com@evil.example.com/x" })] }),
      ]),
    /allowlist/
  );

  // Lo que NO parece una URL atraviesa `checkUrlSafety` entero, así que sin la
  // exigencia explícita de esquema moriría abajo, en el CHECK de la columna,
  // con un error de Postgres en vez de uno que nombre la emisión.
  rejects(
    () => parseOf([season({ broadcasts: [broadcast({ vodUrl: "youtube.com/watch?v=x" })] })]),
    /L1/,
    /https/
  );
  rejects(() => parseOf([season({ broadcasts: [broadcast({ vodUrl: "" })] })]), /vodUrl/);

  // Y los hosts legítimos pasan, verbatim: la regla no es un rechazo
  // indiscriminado.
  for (const good of [
    "https://www.youtube.com/watch?v=T6g1Ynm8r3c",
    "https://youtu.be/T6g1Ynm8r3c",
    "https://www.twitch.tv/videos/123",
  ]) {
    const [emission] = parseOf([season({ broadcasts: [broadcast({ vodUrl: good })] })]).broadcasts;
    assert.equal(emission.vodUrl, good);
  }
}

// ---------------------------------------------------------------------------
// Fila 11 — un archivo SIN ninguna temporada es válido
// ---------------------------------------------------------------------------
//
// El curso adoptante sin clases en directo (goal 6): sin temporadas, sin fechas
// y sin sección de calendario, y sin tocar `src/`.
{
  const parsed = parseSeasonsFile({ curriculum: "adoptante", seasons: [] });
  assert.equal(parsed.curriculum, "adoptante");
  assert.deepEqual(parsed.broadcasts, []);
  assert.deepEqual(resolveBroadcasts(parsed.broadcasts, []), []);

  // Una temporada declarada y sin emisiones también: es el hueco entre
  // programar la temporada y tener sus fechas.
  assert.deepEqual(parseOf([season({ broadcasts: [] })]).broadcasts, []);

  // Lo que NO es válido es un archivo sin los campos de cabecera.
  rejects(() => parseSeasonsFile({ seasons: [] }), /curriculum/);
  rejects(() => parseSeasonsFile({ curriculum: "adoptante" }), /seasons/);
  rejects(() => parseSeasonsFile("no soy un objeto"), /objeto JSON/);
}

// ---------------------------------------------------------------------------
// §4.1 paso 2 — el archivo REAL valida, y sus slugs resuelven contra el
// currículo REAL
// ---------------------------------------------------------------------------
//
// Es la puerta del PR, y la única fila que ejercita los dos archivos juntos:
// un `lessonSlug` con una errata muere aquí, en CI y sin base de datos, en vez
// de en el cargador con la temporada ya mergeada.
{
  const real = parseSeasonsFile(
    JSON.parse(readFileSync(join(ROOT, "curriculum/contextia.seasons.json"), "utf8"))
  );
  const nodes = parseCurriculumFile(
    JSON.parse(readFileSync(join(ROOT, "curriculum/contextia.json"), "utf8"))
  );
  assert.equal(real.curriculum, "contextia");
  assert.ok(real.broadcasts.length > 0, "curriculum/contextia.seasons.json quedó vacío");

  const resolved = resolveBroadcasts(real.broadcasts, nodes);
  assert.equal(resolved.length, real.broadcasts.length);
  for (const emission of resolved) {
    assert.ok(emission.lessonNodeId, `${emission.lessonSlug} no resolvió a ningún nodo`);
  }

  console.log(
    `OK — temporadas sanas: ${resolved.length} emisión(es) en el archivo real, ` +
      `contrato, clave única y las ${URL_EVASIONS.length} evasiones de URL en pie.`
  );
}
