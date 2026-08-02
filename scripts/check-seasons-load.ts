// Comprobaciones de INTEGRACIÓN del cargador de temporadas y de la capa de
// lectura. Escriben y borran filas, así que corren contra su propia base —
// nunca contra la de nadie más. Se ejecuta con:
//   CURRICULUM_TEST_DATABASE_URL=postgres://… node scripts/check-seasons-load.ts
//
// Cubre las filas 21 a 25 de PRD-008 §9.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

// ---------------------------------------------------------------------------
// Guardia de la base de pruebas. ANTES de cualquier import que abra conexión.
// ---------------------------------------------------------------------------
//
// Duplicada a propósito de `check-curriculum-load.ts`, que la exporta pero que
// no se puede importar sin ejecutar su suite entera (todo su cuerpo es de nivel
// superior). Son doce líneas de comparación de URL, no un control con bypasses
// documentados — la regla de "una sola implementación" de §6.4 aplica al
// detector de URLs, no a esto. Si alguna vez se extrae, se extraen las dos.
function sameDatabase(a: string, b: string): boolean {
  try {
    const [x, y] = [new URL(a), new URL(b)];
    return (
      x.hostname === y.hostname &&
      (x.port || "5432") === (y.port || "5432") &&
      x.pathname === y.pathname
    );
  } catch {
    return true; // sin poder parsear, se cae del lado seguro
  }
}

const TEST_URL = process.env.CURRICULUM_TEST_DATABASE_URL;
if (!TEST_URL) {
  console.error(
    "check-seasons-load — falta CURRICULUM_TEST_DATABASE_URL.\n" +
      "  Estas comprobaciones ESCRIBEN y BORRAN. Apunta a una base desechable,\n" +
      "  nunca a la de producción ni a la de desarrollo que uses para otra cosa."
  );
  process.exit(1);
}
if (process.env.DATABASE_URL && sameDatabase(TEST_URL, process.env.DATABASE_URL)) {
  console.error(
    "check-seasons-load — CURRICULUM_TEST_DATABASE_URL apunta a la MISMA base que\n" +
      "  DATABASE_URL. Correr esto ahí borraría emisiones reales. Abortando."
  );
  process.exit(1);
}

process.env.DATABASE_URL = TEST_URL;

const { eq } = await import("drizzle-orm");
const { db } = await import("../packages/shared/src/db.ts");
const { broadcasts } = await import("../packages/shared/src/schema.ts");
const { getBroadcasts } = await import("../packages/shared/src/broadcasts.ts");

try {
  await db.select().from(broadcasts).limit(1);
} catch {
  console.error(
    "check-seasons-load — la tabla `broadcasts` no existe en la base de pruebas.\n" +
      "  Ejecuta primero: DATABASE_URL=$CURRICULUM_TEST_DATABASE_URL pnpm db:migrate"
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

const FIXTURES = mkdtempSync(join(tmpdir(), "seasons-check-"));
let fixtureSeq = 0;

/**
 * UUID DETERMINISTA a partir de un nombre. No es cosmético: los fixtures de
 * currículo se cargan con `load-curriculum.ts`, y con `id` nuevos en cada
 * ejecución la segunda pasada vería los de la anterior como bajas y el
 * guardarraíl abortaría. Así el suite es reejecutable sin `--allow-deletes`.
 */
function idOf(name: string): string {
  const hex = createHash("sha256").update(name).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

type Emission = { lessonSlug: string; date: string; vodUrl?: string };

/** Archivo de currículo con un módulo y las lecciones que se le pidan. */
function curriculumFixture(curriculum: string, lessonSlugs: string[]): string {
  const path = join(FIXTURES, `curriculum-${curriculum}-${fixtureSeq++}.json`);
  writeFileSync(
    path,
    JSON.stringify(
      {
        curriculum,
        nodes: [
          {
            id: idOf(`${curriculum}:m`),
            slug: "m1",
            kind: "module",
            title: "Módulo de pruebas",
            children: lessonSlugs.map((slug) => ({
              id: idOf(`${curriculum}:${slug}`),
              slug,
              kind: "lesson",
              title: `Lección ${slug}`,
              payload: { outcome: `sabes ${slug}`, stuck: `el atasco de ${slug}` },
            })),
          },
        ],
      },
      null,
      2
    )
  );
  return path;
}

/** Archivo de temporadas. `season` por defecto, hora y desfase de Colombia. */
function seasonsFixture(
  curriculum: string,
  emissions: Emission[],
  season = "2026-t1"
): string {
  const path = join(FIXTURES, `seasons-${curriculum}-${fixtureSeq++}.json`);
  writeFileSync(
    path,
    JSON.stringify(
      {
        curriculum,
        seasons: [
          {
            season,
            startsAtLocal: "20:00",
            utcOffset: "-05:00",
            broadcasts: emissions.map((emission) => ({
              id: idOf(`${curriculum}:${season}:${emission.lessonSlug}:${emission.date}`),
              ...emission,
            })),
          },
        ],
      },
      null,
      2
    )
  );
  return path;
}

type Run = { status: number; stdout: string; stderr: string };

/** Lanza un cargador en SUBPROCESO: el código de salida se comprueba sobre el
 *  proceso, no sobre una excepción interna. */
function run(script: string, file: string, ...args: string[]): Run {
  try {
    const stdout = execFileSync(process.execPath, [script, file, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: "pipe",
      env: { ...process.env, DATABASE_URL: TEST_URL },
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

const seasonsLoad = (file: string, ...args: string[]) =>
  run("scripts/load-seasons.ts", file, ...args);
const curriculumLoad = (file: string, ...args: string[]) =>
  run("scripts/load-curriculum.ts", file, ...args);

const rowsOf = (curriculum: string) =>
  db.select().from(broadcasts).where(eq(broadcasts.curriculum, curriculum));

// Cada escenario usa su PROPIO slug de currículo, para que el estado de uno no
// contamine a otro.
const scenarios = [
  "seasons-carga",
  "seasons-borrado",
  "seasons-retirada",
  "seasons-rechazo",
  "seasons-tz",
  "seasons-propiedad-a",
  "seasons-propiedad-b",
];
for (const name of scenarios) {
  await db.delete(broadcasts).where(eq(broadcasts.curriculum, name));
}

// ---------------------------------------------------------------------------
// Fila 21 — escribe, actualiza y no duplica
// ---------------------------------------------------------------------------
{
  const c = "seasons-carga";
  assert.equal(curriculumLoad(curriculumFixture(c, ["S1", "S2"]), "--write").status, 0);

  const file = seasonsFixture(c, [
    { lessonSlug: "S1", date: "2026-07-14", vodUrl: "https://youtu.be/abc" },
    { lessonSlug: "S2", date: "2026-07-16" },
  ]);

  const first = seasonsLoad(file, "--write");
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /crear:\s+2/);
  const before = await rowsOf(c);
  assert.equal(before.length, 2);

  // Segunda pasada, mismo archivo: ni una fila nueva, ni un `updated_at` movido.
  // Sin el `setWhere` del upsert esto pasaría igual y `updated_at` no
  // significaría nada (§6.5).
  const second = seasonsLoad(file, "--write");
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /actualizar:\s+0/, "la segunda pasada no debería actualizar nada");
  const after = await rowsOf(c);
  assert.deepEqual(after.map((r) => r.id).sort(), before.map((r) => r.id).sort());
  for (const row of before) {
    const now = after.find((r) => r.id === row.id)!;
    assert.equal(
      now.updatedAt.getTime(),
      row.updatedAt.getTime(),
      "updated_at se movió sin que cambiara nada"
    );
  }

  // Cambiar una FECHA: se actualiza por `id` —la emisión es la misma— y mueve
  // `updated_at` dejando `created_at` intacto.
  const moved = seasonsFixture(c, [
    { lessonSlug: "S1", date: "2026-07-14", vodUrl: "https://youtu.be/abc" },
    { lessonSlug: "S2", date: "2026-07-16" },
  ]);
  // Mismo `id` para S2 (el fixture es determinista por lección y fecha), con la
  // fecha cambiada a mano: es exactamente "corregir la fecha de una emisión".
  const s2Id = idOf(`${c}:2026-t1:S2:2026-07-16`);
  writeFileSync(
    moved,
    JSON.stringify(
      {
        curriculum: c,
        seasons: [
          {
            season: "2026-t1",
            startsAtLocal: "20:00",
            utcOffset: "-05:00",
            broadcasts: [
              {
                id: idOf(`${c}:2026-t1:S1:2026-07-14`),
                lessonSlug: "S1",
                date: "2026-07-14",
                vodUrl: "https://youtu.be/abc",
              },
              { id: s2Id, lessonSlug: "S2", date: "2026-07-21" },
            ],
          },
        ],
      },
      null,
      2
    )
  );

  const third = seasonsLoad(moved, "--write");
  assert.equal(third.status, 0, third.stderr);
  assert.match(third.stdout, /actualizar:\s+1/);
  assert.match(third.stdout, /crear:\s+0/);
  assert.match(third.stdout, /borrar:\s+0/);

  const final = await rowsOf(c);
  assert.equal(final.length, 2, "corregir una fecha no puede crear una fila nueva");
  const s1 = final.find((r) => r.id === idOf(`${c}:2026-t1:S1:2026-07-14`))!;
  const s2 = final.find((r) => r.id === s2Id)!;
  assert.equal(s2.startsAt.toISOString(), "2026-07-22T01:00:00.000Z");

  const s2Before = before.find((r) => r.id === s2Id)!;
  assert.ok(s2.updatedAt.getTime() > s2Before.updatedAt.getTime(), "updated_at no se movió");
  assert.equal(
    s2.createdAt.getTime(),
    s2Before.createdAt.getTime(),
    "created_at cambió: no puede estar en el `set` del upsert (§6.5)"
  );
  // Y la que no cambió sigue quieta.
  const s1Before = before.find((r) => r.id === s1.id)!;
  assert.equal(s1.updatedAt.getTime(), s1Before.updatedAt.getTime());
  assert.equal(s1.vodUrl, "https://youtu.be/abc");
}

// ---------------------------------------------------------------------------
// Fila 22 — una emisión que desaparece del archivo aborta sin --allow-deletes
// ---------------------------------------------------------------------------
//
// Goal 7, y LA MITAD QUE FALTABA de §6.3: sin esto, proteger la emisión de una
// edición de temario y dejarla a merced de una línea borrada del archivo no la
// protege de nada.
{
  const c = "seasons-borrado";
  assert.equal(curriculumLoad(curriculumFixture(c, ["S1", "S2"]), "--write").status, 0);

  const full = seasonsFixture(c, [
    { lessonSlug: "S1", date: "2026-07-14", vodUrl: "https://youtu.be/grabada" },
    { lessonSlug: "S2", date: "2026-07-16" },
  ]);
  assert.equal(seasonsLoad(full, "--write").status, 0);
  assert.equal((await rowsOf(c)).length, 2);

  const shrunk = seasonsFixture(c, [{ lessonSlug: "S2", date: "2026-07-16" }]);

  const blocked = seasonsLoad(shrunk, "--write");
  assert.equal(blocked.status, 1, "quitar una emisión del archivo no puede pasar en silencio");
  assert.match(blocked.stderr, /--allow-deletes/);
  assert.match(blocked.stderr, /S1/, "el mensaje tiene que nombrar la emisión que moriría");
  assert.match(blocked.stderr, /grabada/, "y su grabación, que es lo que se pierde");
  assert.equal((await rowsOf(c)).length, 2, "abortó pero escribió");

  // El ensayo en seco dispara el guardarraíl igual: el operador se entera de
  // qué bandera necesita antes de escribir.
  const dry = seasonsLoad(shrunk);
  assert.equal(dry.status, 1);
  assert.match(dry.stdout, /borrar:\s+1/);
  assert.equal((await rowsOf(c)).length, 2);

  // Con la bandera, procede.
  const allowed = seasonsLoad(shrunk, "--write", "--allow-deletes");
  assert.equal(allowed.status, 0, allowed.stderr);
  const left = await rowsOf(c);
  assert.equal(left.length, 1);
  assert.equal(left[0].id, idOf(`${c}:2026-t1:S2:2026-07-16`));
}

// ---------------------------------------------------------------------------
// Fila 23 — una lección retirada NO borra su emisión
// ---------------------------------------------------------------------------
//
// La razón entera de que `lesson_node_id` no lleve clave foránea (§6.3): una
// clase emitida es un hecho histórico. El temario puede cambiar; el 14 de julio
// de 2026 hubo una clase y su grabación existe.
{
  const c = "seasons-retirada";
  assert.equal(curriculumLoad(curriculumFixture(c, ["S1", "S2"]), "--write").status, 0);

  assert.equal(
    seasonsLoad(
      seasonsFixture(c, [
        { lessonSlug: "S1", date: "2026-07-14", vodUrl: "https://youtu.be/historica" },
      ]),
      "--write"
    ).status,
    0
  );
  const before = await rowsOf(c);
  assert.equal(before.length, 1);

  // Se retira S1 del temario, por el camino real: el cargador del currículo con
  // su bandera. Sin clave foránea, ni cascada que se lleve la emisión ni
  // transacción que aborte.
  const retired = curriculumLoad(curriculumFixture(c, ["S2"]), "--write", "--allow-deletes");
  assert.equal(retired.status, 0, retired.stderr);

  const after = await rowsOf(c);
  assert.equal(after.length, 1, "la emisión murió con el nodo");
  assert.equal(after[0].vodUrl, "https://youtu.be/historica", "se perdió la grabación");
  assert.equal(after[0].startsAt.toISOString(), "2026-07-15T01:00:00.000Z");

  // Y la lectura la sigue entregando, con el slug vacío: el join es a la
  // IZQUIERDA (§7.3). Un `slugsByNodeId` al uso —el precedente de PRD-007—
  // la omitiría, que es justo lo contrario de lo que §6.3 quiere.
  const read = await getBroadcasts(c);
  assert.equal(read.length, 1, "la lectura omitió una emisión cuyo nodo ya no existe");
  assert.equal(read[0].lessonSlug, "", "sin nodo, el slug es vacío y la fila degrada");
  assert.equal(read[0].vodUrl, "https://youtu.be/historica");
}

// ---------------------------------------------------------------------------
// Fila 24 — rechaza sin escribir nada
// ---------------------------------------------------------------------------
{
  const c = "seasons-rechazo";
  assert.equal(curriculumLoad(curriculumFixture(c, ["S1"]), "--write").status, 0);

  assert.equal(
    seasonsLoad(seasonsFixture(c, [{ lessonSlug: "S1", date: "2026-07-14" }]), "--write").status,
    0
  );
  const before = await rowsOf(c);
  assert.equal(before.length, 1);

  // Un slug que no existe, detrás de uno que sí: el archivo entero se rechaza.
  const badSlug = seasonsLoad(
    seasonsFixture(c, [
      { lessonSlug: "S1", date: "2026-07-14" },
      { lessonSlug: "NOPE", date: "2026-07-16" },
    ]),
    "--write"
  );
  assert.equal(badSlug.status, 1);
  assert.match(badSlug.stderr, /NOPE/);
  assert.match(badSlug.stderr, /no existe/);

  // Un slug que existe y NO es lección.
  const notALesson = seasonsLoad(
    seasonsFixture(c, [{ lessonSlug: "m1", date: "2026-07-16" }]),
    "--write"
  );
  assert.equal(notALesson.status, 1);
  assert.match(notALesson.stderr, /m1/);
  assert.match(notALesson.stderr, /module/);

  const after = await rowsOf(c);
  assert.deepEqual(
    after.map((r) => r.id).sort(),
    before.map((r) => r.id).sort(),
    "no debería haberse escrito ni una fila"
  );
  assert.equal(after.length, 1);
}

// ---------------------------------------------------------------------------
// Fila 25 — `starts_at` da el MISMO instante bajo dos `TZ`
// ---------------------------------------------------------------------------
//
// ES LO ÚNICO QUE FALLA si alguien "simplifica" la columna a `timestamp` sin
// zona: las filas puras (9 y 15) componen y formatean con funciones que no
// tocan la base, y siguen verdes con la columna mal declarada. `pg-types`
// registra el mismo parser para los dos OID, y para una cadena SIN desfase
// construye el `Date` con los componentes LOCALES del proceso (§6.2).
{
  const c = "seasons-tz";
  assert.equal(curriculumLoad(curriculumFixture(c, ["S1"]), "--write").status, 0);
  assert.equal(
    seasonsLoad(seasonsFixture(c, [{ lessonSlug: "S1", date: "2026-07-14" }]), "--write").status,
    0
  );

  const id = idOf(`${c}:2026-t1:S1:2026-07-14`);

  /** Lee la fila en un proceso NUEVO con la `TZ` dada: `TZ` se fija al arrancar
   *  Node, así que cambiarla en caliente no serviría de nada. */
  function epochUnder(tz: string): number {
    const source = [
      `const { eq } = await import("drizzle-orm");`,
      `const { db } = await import(${JSON.stringify(join(ROOT, "packages/shared/src/db.ts"))});`,
      `const { broadcasts } = await import(${JSON.stringify(join(ROOT, "packages/shared/src/schema.ts"))});`,
      `const rows = await db.select().from(broadcasts).where(eq(broadcasts.id, ${JSON.stringify(id)}));`,
      `console.log(rows[0].startsAt.getTime());`,
      `await db.$client.end();`,
    ].join("\n");

    const out = execFileSync(process.execPath, ["--input-type=module", "-e", source], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: "pipe",
      env: { ...process.env, TZ: tz, DATABASE_URL: TEST_URL },
    });
    const epoch = Number(out.trim().split("\n").pop());
    assert.ok(Number.isFinite(epoch), `no se pudo leer el instante bajo TZ=${tz}: ${out}`);
    return epoch;
  }

  const utc = epochUnder("UTC");
  const tokyo = epochUnder("Asia/Tokyo");
  const bogota = epochUnder("America/Bogota");

  assert.equal(utc, tokyo, "la misma fila dio dos instantes distintos según la TZ del proceso");
  assert.equal(utc, bogota, "la misma fila dio dos instantes distintos según la TZ del proceso");
  assert.equal(
    new Date(utc).toISOString(),
    "2026-07-15T01:00:00.000Z",
    "20:00 en Colombia el 14 de julio es 01:00 UTC del 15"
  );
}

// ---------------------------------------------------------------------------
// Fila 26 — un `id` que pertenece a OTRO currículo aborta la carga
// ---------------------------------------------------------------------------
//
// EL PELIGRO LO CREA §6.5, no el descuido del operador. `curriculum` queda
// FUERA del `set` del upsert a propósito, así que un `id` copiado del archivo de
// otro curso entra por `ON CONFLICT (id)` y sobrescribe en silencio su
// temporada, su lección, su fecha y su grabación — conservando el `curriculum`
// ajeno, de modo que la fila sigue "perteneciendo" a quien ya no describe.
//
// Y el disparador es corriente, no rebuscado: `curriculum/README.md` abre
// diciendo que copiar la plantilla CONSERVA los UUID y que hay que regenerarlos.
// Quien no lea esa línea produce exactamente este caso.
{
  const A = "seasons-propiedad-a";
  const B = "seasons-propiedad-b";

  const curriculumA = curriculumFixture(A, ["L1"]);
  curriculumLoad(curriculumA, "--write");
  const seasonsA = seasonsFixture(A, [{ lessonSlug: "L1", date: "2026-07-14", vodUrl: "https://youtu.be/abc" }]);
  const okA = seasonsLoad(seasonsA, "--write");
  assert.equal(okA.status, 0, `la carga de ${A} debía funcionar: ${okA.stderr}`);

  const antes = await rowsOf(A);
  assert.equal(antes.length, 1);
  const idAjeno = antes[0].id;

  // El currículo B, con su propia lección, y un archivo de temporadas que
  // reutiliza el `id` de A — el accidente de copiar la plantilla.
  const curriculumB = curriculumFixture(B, ["L1"]);
  curriculumLoad(curriculumB, "--write");
  const rutaB = join(FIXTURES, `seasons-${B}-robo.json`);
  writeFileSync(
    rutaB,
    JSON.stringify(
      {
        curriculum: B,
        seasons: [
          {
            season: "2026-t1",
            startsAtLocal: "20:00",
            utcOffset: "-05:00",
            broadcasts: [{ id: idAjeno, lessonSlug: "L1", date: "2026-09-15" }],
          },
        ],
      },
      null,
      2
    )
  );

  const robo = seasonsLoad(rutaB, "--write");
  assert.notEqual(robo.status, 0, "una carga con un `id` ajeno tiene que abortar");
  assert.match(
    `${robo.stdout}${robo.stderr}`,
    /pertenece|currículo/i,
    "y el mensaje tiene que decir de quién es el id"
  );

  // Lo que de verdad importa: la fila de A quedó INTACTA.
  const despues = await rowsOf(A);
  assert.equal(despues.length, 1, "A sigue teniendo su única emisión");
  assert.equal(despues[0].id, idAjeno);
  assert.equal(
    despues[0].startsAt.getTime(),
    antes[0].startsAt.getTime(),
    "y con su fecha, no la de B"
  );
  assert.equal(despues[0].vodUrl, "https://youtu.be/abc", "y con su grabación");

  // Y B no escribió nada: el rechazo es del archivo entero.
  const deB = await rowsOf(B);
  assert.equal(deB.length, 0, "el archivo rechazado no deja filas a medias");
}

// ---------------------------------------------------------------------------
// Fila 27 — la lectura NO relanza: devuelve `[]` y registra (§7.3)
// ---------------------------------------------------------------------------
//
// ES LA DIFERENCIA DELIBERADA CON `curriculum.ts`, y hasta ahora la sostenía un
// comentario. Aquél RELANZA cuando fallan sus tres capas; si `broadcasts.ts`
// hiciera lo mismo, un hipo de Postgres en la lectura del calendario tumbaría la
// home ENTERA — lo contrario de lo que §4.2 y §7.3 prometen. Sin este escenario,
// alguien "unifica los dos módulos porque son iguales" y nada se pone rojo hasta
// que un visitante ve un 500 en la landing pública.
//
// Se ejercita en SUBPROCESO y contra un host que no resuelve: el fallo tiene que
// venir de la consulta real y no de un doble, y `lastKnown` es por proceso — en
// éste ya lo poblaron los escenarios de arriba, que es justo el camino que NO se
// quiere medir.
{
  const guion = join(FIXTURES, "degradacion.mjs");
  const modulo = JSON.stringify(join(ROOT, "packages/shared/src/broadcasts.ts"));
  writeFileSync(
    guion,
    [
      `import { getBroadcasts } from ${modulo};`,
      `const filas = await getBroadcasts("da-igual");`,
      `console.log("RESULTADO:" + JSON.stringify({ largo: filas.length, esArray: Array.isArray(filas) }));`,
      `process.exit(0);`,
    ].join("\n")
  );

  const salida = execFileSync(process.execPath, [guion], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "pipe",
    env: { ...process.env, DATABASE_URL: "postgres://n:n@no-existe-este-host.invalid:5432/n" },
  });

  const linea = salida.split("\n").find((l) => l.startsWith("RESULTADO:")) ?? "";
  const resultado = JSON.parse(linea.slice("RESULTADO:".length)) as {
    largo: number;
    esArray: boolean;
  };
  assert.equal(resultado.esArray, true, "getBroadcasts tiene que devolver un array, no lanzar");
  assert.equal(resultado.largo, 0, "y vacío cuando no hay nada que servir");
}


await db.$client.end();

console.log(
  `OK — cargador y lectura de temporadas sanos contra Postgres: ${scenarios.length} escenarios ` +
    "(idempotencia, guardarraíl de borrado, lección retirada, rechazo, timestamptz, propiedad " +
    "de `id` y degradación sin relanzar)."
);
