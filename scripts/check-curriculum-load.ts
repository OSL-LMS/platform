// Comprobaciones de INTEGRACIÓN del cargador y de la capa de lectura. Escriben,
// borran subárboles y exigen la tabla vacía, así que corren contra su propia
// base — nunca contra la de nadie más. Se ejecuta con:
//   CURRICULUM_TEST_DATABASE_URL=postgres://… node scripts/check-curriculum-load.ts
//
// Este script es el único escritor autorizado contra `curriculum_nodes` aparte
// del cargador (PRD-002 §7 invariante 1, acotado a la base de pruebas por §8.4).
//
// Cubre las filas 6, 8, 9, 9b, 10, 11, 12, 12b, 12c, 12d, 13, 14, 17 y 26 de §9.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

// ---------------------------------------------------------------------------
// Fila 17 — guardia de la base de pruebas. ANTES de cualquier import que abra
// una conexión: este repositorio lo usan principiantes que corren scripts con
// la DATABASE_URL que tengan en el entorno, y aquí se borran subárboles.
// ---------------------------------------------------------------------------

/** ¿Son la misma base? Se compara host + nombre de base **ya parseados**, no la
 *  cadena: la misma base con `?sslmode=require` añadido, o alcanzada por otro
 *  alias de host, no es igual como cadena y sí es la misma base. */
export function sameDatabase(a: string, b: string): boolean {
  try {
    const [x, y] = [new URL(a), new URL(b)];
    return (
      x.hostname === y.hostname &&
      (x.port || "5432") === (y.port || "5432") &&
      x.pathname === y.pathname
    );
  } catch {
    // Si alguna no parsea, se cae del lado seguro: se asume que sí.
    return true;
  }
}

{
  const base = "postgres://u:p@db.example.com:5432/tutor";
  assert.equal(sameDatabase(base, `${base}?sslmode=require`), true, "los parámetros no la hacen otra base");
  assert.equal(sameDatabase(base, "postgres://otro:otro@db.example.com:5432/tutor"), true, "otras credenciales, misma base");
  assert.equal(sameDatabase(base, "postgres://u:p@db.example.com:5432/tutor_test"), false);
  assert.equal(sameDatabase(base, "postgres://u:p@localhost:5432/tutor"), false);
  assert.equal(sameDatabase(base, "no-es-una-url"), true, "sin poder parsear, se asume la misma");
}

const TEST_URL = process.env.CURRICULUM_TEST_DATABASE_URL;
if (!TEST_URL) {
  console.error(
    "check-curriculum-load — falta CURRICULUM_TEST_DATABASE_URL.\n" +
      "  Estas comprobaciones ESCRIBEN y BORRAN. Apunta a una base desechable,\n" +
      "  nunca a la de producción ni a la de desarrollo que uses para otra cosa."
  );
  process.exit(1);
}
if (process.env.DATABASE_URL && sameDatabase(TEST_URL, process.env.DATABASE_URL)) {
  console.error(
    "check-curriculum-load — CURRICULUM_TEST_DATABASE_URL apunta a la MISMA base que\n" +
      "  DATABASE_URL. Correr esto ahí vaciaría el currículo. Abortando."
  );
  process.exit(1);
}

// Y la guardia en sí, ejercitada en SUBPROCESO. Probar solo `sameDatabase()`
// dejaba sin cubrir los dos `process.exit(1)` que separan a un principiante de
// vaciar el currículo de producción: invertir el `if` de arriba, o perder el
// `exit`, mantendría las aserciones puras en verde.
{
  const selfCheck = (env: Record<string, string | undefined>): number => {
    try {
      execFileSync(process.execPath, ["scripts/check-curriculum-load.ts"], {
        cwd: ROOT,
        stdio: "pipe",
        // `SELFCHECK` corta la recursión: el subproceso aborta en la guardia
        // mucho antes, pero si algún día dejara de hacerlo no queremos una
        // cascada de procesos escribiendo en la base.
        env: { ...process.env, SELFCHECK: "1", ...env },
      });
      return 0;
    } catch (err) {
      return (err as { status?: number }).status ?? 1;
    }
  };

  if (!process.env.SELFCHECK) {
    assert.equal(
      selfCheck({ CURRICULUM_TEST_DATABASE_URL: undefined }), 1,
      "sin CURRICULUM_TEST_DATABASE_URL el script tiene que abortar con código 1"
    );
    assert.equal(
      selfCheck({ DATABASE_URL: TEST_URL }), 1,
      "apuntando a la misma base que DATABASE_URL tiene que abortar con código 1"
    );
    assert.equal(
      selfCheck({ DATABASE_URL: `${TEST_URL}?sslmode=require` }), 1,
      "la misma base con otros parámetros de conexión sigue siendo la misma base"
    );
  }
}

// A partir de aquí, todo (incluido el cargador que se lanza en subproceso) va
// contra la base de pruebas.
process.env.DATABASE_URL = TEST_URL;

const { eq } = await import("drizzle-orm");
const { sql } = await import("drizzle-orm");
const { db } = await import("../src/lib/db.ts");
const { curriculumNodes } = await import("../src/lib/schema.ts");
const { getAncestors, getCurriculumForest, getLessons, getLessonContextInputs, CurriculumNotLoadedError } =
  await import("../src/lib/curriculum.ts");
const { buildLessonContext } = await import("../src/lib/curriculum-context.ts");

try {
  await db.select().from(curriculumNodes).limit(1);
} catch {
  console.error(
    "check-curriculum-load — la tabla `curriculum_nodes` no existe en la base de pruebas.\n" +
      "  Ejecuta primero: DATABASE_URL=$CURRICULUM_TEST_DATABASE_URL pnpm db:migrate"
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

const FIXTURES = mkdtempSync(join(tmpdir(), "curriculum-check-"));
let fixtureSeq = 0;

type Input = {
  id: string;
  slug: string;
  kind: string;
  title: string;
  payload?: Record<string, unknown>;
  children?: Input[];
};

function fixture(curriculum: string, nodes: Input[]): string {
  const path = join(FIXTURES, `${curriculum}-${fixtureSeq++}.json`);
  writeFileSync(path, JSON.stringify({ curriculum, nodes }, null, 2));
  return path;
}

const mod = (id: string, slug: string, children: Input[] = [], payload?: Record<string, unknown>): Input => ({
  id, slug, kind: "module", title: `Módulo ${slug}`, payload, children,
});
const les = (id: string, slug: string): Input => ({
  id, slug, kind: "lesson", title: `Lección ${slug}`,
  payload: { outcome: `sabes ${slug}`, stuck: `el atasco de ${slug}` },
});

type Run = { status: number; stdout: string; stderr: string };

/** Lanza el cargador en SUBPROCESO: el código de salida se comprueba sobre el
 *  proceso, no sobre una excepción interna (fila 10). */
function loader(file: string, ...args: string[]): Run {
  try {
    const stdout = execFileSync(
      process.execPath,
      ["scripts/load-curriculum.ts", file, ...args],
      { cwd: ROOT, encoding: "utf8", stdio: "pipe", env: { ...process.env, DATABASE_URL: TEST_URL } }
    );
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

async function rowsOf(curriculum: string) {
  return db.select().from(curriculumNodes).where(eq(curriculumNodes.curriculum, curriculum));
}

async function wipe(curriculum: string) {
  await db.delete(curriculumNodes).where(eq(curriculumNodes.curriculum, curriculum));
}

const uuid = () => crypto.randomUUID();

// Cada escenario usa su PROPIO slug de currículo, para que el estado de uno no
// contamine a otro — la fila 14 exige "tabla vacía" para un currículo que las
// demás no deben haber tocado.
const scenarios = [
  "chk-idempotente", "chk-reparent", "chk-rename", "chk-parcial", "chk-aislado-a",
  "chk-aislado-b", "chk-borrado", "chk-identidad", "chk-propiedad-a", "chk-propiedad-b",
  "chk-slugs", "chk-jerarquia", "chk-vacio", "chk-degradado",
];
for (const name of scenarios) await wipe(name);

// ---------------------------------------------------------------------------
// Fila 8 — carga idempotente
// ---------------------------------------------------------------------------
{
  const c = "chk-idempotente";
  const ids = { m: uuid(), a: uuid(), b: uuid() };
  const file = fixture(c, [mod(ids.m, "m1", [les(ids.a, "a1"), les(ids.b, "a2")])]);

  assert.equal(loader(file, "--write").status, 0);
  const first = await rowsOf(c);
  assert.equal(first.length, 3);

  const second = loader(file, "--write");
  assert.equal(second.status, 0);
  assert.match(second.stdout, /actualizar:\s+0/, "la segunda pasada no debería actualizar nada");

  const after = await rowsOf(c);
  assert.deepEqual(after.map((r) => r.id).sort(), first.map((r) => r.id).sort());
  for (const before of first) {
    const now = after.find((r) => r.id === before.id)!;
    assert.equal(
      now.updatedAt.getTime(), before.updatedAt.getTime(),
      `updated_at se movió en ${before.slug} sin que cambiara nada`
    );
  }
}

// ---------------------------------------------------------------------------
// Fila 9 — el `id` sobrevive a un cambio de padre
// ---------------------------------------------------------------------------
{
  const c = "chk-reparent";
  const ids = { m1: uuid(), m2: uuid(), l: uuid() };
  assert.equal(
    loader(fixture(c, [mod(ids.m1, "m1", [les(ids.l, "l1")]), mod(ids.m2, "m2")]), "--write").status,
    0
  );
  // La lección se muda de módulo, con su `id` intacto en el archivo.
  assert.equal(
    loader(fixture(c, [mod(ids.m1, "m1"), mod(ids.m2, "m2", [les(ids.l, "l1")])]), "--write").status,
    0,
    "mover de padre no debería exigir ninguna bandera"
  );

  const rows = await rowsOf(c);
  const moved = rows.find((r) => r.slug === "l1")!;
  assert.equal(moved.id, ids.l, "el `id` es la llave de la que colgará el progreso");
  assert.equal(moved.parentId, ids.m2);
}

// ---------------------------------------------------------------------------
// Fila 9b — el `id` sobrevive a un renombrado del `slug`
// ---------------------------------------------------------------------------
{
  const c = "chk-rename";
  const ids = { m: uuid(), l: uuid() };
  assert.equal(loader(fixture(c, [mod(ids.m, "m1", [les(ids.l, "L3")])]), "--write").status, 0);

  const run = loader(fixture(c, [mod(ids.m, "m1", [les(ids.l, "css-basico")])]), "--write");
  assert.equal(run.status, 0, "renombrar un slug NO es un borrado: el guardarraíl no debe dispararse");
  assert.match(run.stdout, /actualizar:\s+1/);
  assert.match(run.stdout, /borrar:\s+0/);

  const rows = await rowsOf(c);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.id === ids.l)!.slug, "css-basico");
}

// ---------------------------------------------------------------------------
// Fila 10 — sin escritura parcial, y código de salida sobre el SUBPROCESO
// ---------------------------------------------------------------------------
{
  const c = "chk-parcial";
  const ids = { m: uuid(), l: uuid() };
  assert.equal(loader(fixture(c, [mod(ids.m, "m1", [les(ids.l, "l1")])]), "--write").status, 0);
  const before = await rowsOf(c);

  // Archivo inválido: una lección sin `stuck` detrás de un nodo válido.
  const broken = fixture(c, [
    mod(ids.m, "m1", [
      les(ids.l, "l1"),
      { id: uuid(), slug: "roto", kind: "lesson", title: "Rota", payload: { outcome: "x" } },
    ]),
  ]);
  const invalid = loader(broken, "--write");
  assert.equal(invalid.status, 1, "un archivo inválido tiene que salir con código 1");
  assert.match(invalid.stderr, /payload\.stuck/);

  const afterInvalid = await rowsOf(c);
  assert.deepEqual(
    afterInvalid.map((r) => r.id).sort(), before.map((r) => r.id).sort(),
    "no debería haberse escrito ni una fila"
  );

  // Sin `--write`: valida, reporta y no escribe. El modo destructivo no es el defecto.
  const dry = loader(fixture(c, [mod(ids.m, "m1", [les(ids.l, "l1"), les(uuid(), "l9")])]));
  assert.equal(dry.status, 0);
  assert.match(dry.stdout, /crear:\s+1/);
  assert.match(dry.stdout, /no se ha escrito nada/);
  assert.equal((await rowsOf(c)).length, before.length, "el dry-run escribió");

  // Un diff destructivo también dispara el guardarraíl SIN `--write`: el diff se
  // imprime igual, y el operador se entera de qué bandera necesita antes de
  // escribir. Es el punto del ensayo en seco.
  const dryDestructive = loader(fixture(c, [mod(ids.m, "m1")]));
  assert.equal(dryDestructive.status, 1);
  assert.match(dryDestructive.stdout, /borrar:\s+1/);
  assert.match(dryDestructive.stderr, /--allow-deletes/);
  assert.equal((await rowsOf(c)).length, before.length, "el dry-run escribió");
}

// ---------------------------------------------------------------------------
// Fila 11 — aislamiento entre currículos
// ---------------------------------------------------------------------------
{
  const [a, b] = ["chk-aislado-a", "chk-aislado-b"];
  const idsA = { m: uuid(), l: uuid() };
  assert.equal(loader(fixture(a, [mod(idsA.m, "ma", [les(idsA.l, "la")])]), "--write").status, 0);
  assert.equal(loader(fixture(b, [mod(uuid(), "mb", [les(uuid(), "lb")])]), "--write").status, 0);

  const rowsA = await rowsOf(a);
  assert.equal(rowsA.length, 2, "cargar un segundo currículo no puede tocar el primero");
  assert.deepEqual(rowsA.map((r) => r.id).sort(), [idsA.m, idsA.l].sort());
  assert.equal((await rowsOf(b)).length, 2);
}

// ---------------------------------------------------------------------------
// Fila 12 — guardarraíl de borrado: CUALQUIER baja, sin umbral
// ---------------------------------------------------------------------------
{
  const c = "chk-borrado";
  const ids = { m: uuid(), l1: uuid(), l2: uuid(), m2: uuid(), l3: uuid() };
  const full = [
    mod(ids.m, "m1", [les(ids.l1, "l1"), les(ids.l2, "l2")]),
    mod(ids.m2, "m2", [les(ids.l3, "l3")]),
  ];
  assert.equal(loader(fixture(c, full), "--write").status, 0);
  assert.equal((await rowsOf(c)).length, 5);

  // UNA SOLA HOJA — el caso que un umbral porcentual dejaba pasar en silencio.
  const oneLeafGone = fixture(c, [mod(ids.m, "m1", [les(ids.l1, "l1")]), mod(ids.m2, "m2", [les(ids.l3, "l3")])]);
  const blocked = loader(oneLeafGone, "--write");
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /--allow-deletes/);
  assert.match(blocked.stderr, /l2/);
  assert.equal((await rowsOf(c)).length, 5, "abortó pero escribió");

  // Un nodo CON HIJOS, igual de bloqueado.
  const subtreeGone = fixture(c, [mod(ids.m, "m1", [les(ids.l1, "l1"), les(ids.l2, "l2")])]);
  assert.equal(loader(subtreeGone, "--write").status, 1);
  assert.equal((await rowsOf(c)).length, 5);

  // Con la bandera, procede.
  assert.equal(loader(oneLeafGone, "--write", "--allow-deletes").status, 0);
  const after = await rowsOf(c);
  assert.equal(after.length, 4);
  assert.equal(after.find((r) => r.slug === "l2"), undefined);
}

// ---------------------------------------------------------------------------
// Fila 12b — clasificación del diff y autorizaciones SEPARADAS
// ---------------------------------------------------------------------------
{
  const c = "chk-identidad";
  const ids = { m: uuid(), l: uuid() };
  assert.equal(loader(fixture(c, [mod(ids.m, "m1", [les(ids.l, "l1")])]), "--write").status, 0);

  // Mismo `slug`, otro `id`: la firma de un cambio de identidad.
  const newId = uuid();
  const changed = fixture(c, [mod(ids.m, "m1", [les(newId, "l1")])]);

  const noFlags = loader(changed, "--write");
  assert.equal(noFlags.status, 1);
  assert.match(noFlags.stdout, /borrar\+crear:\s+1/);

  // --allow-deletes A SECAS no autoriza esta clase: quien aprueba un borrado no
  // está autorizando en silencio cualquier cambio de identidad del mismo archivo.
  const onlyDeletes = loader(changed, "--write", "--allow-deletes");
  assert.equal(onlyDeletes.status, 1, "--allow-deletes no puede autorizar borrar+crear");
  assert.match(onlyDeletes.stderr, /--allow-identity-change l1/);
  assert.equal((await rowsOf(c)).find((r) => r.slug === "l1")!.id, ids.l, "el id cambió sin permiso");

  // La bandera nombra el SLUG, no el UUID: nada en un UUID le dice a un humano
  // a qué apunta.
  assert.equal(loader(changed, "--write", "--allow-identity-change", "l1").status, 0);
  assert.equal((await rowsOf(c)).find((r) => r.slug === "l1")!.id, newId);

  // Cambiar SOLO el `slug` es `actualizar` y procede sin ninguna bandera.
  const renamed = loader(fixture(c, [mod(ids.m, "m1", [les(newId, "l1-bis")])]), "--write");
  assert.equal(renamed.status, 0);
  assert.match(renamed.stdout, /actualizar:\s+1/);
  assert.match(renamed.stdout, /borrar\+crear:\s+0/);
}

// ---------------------------------------------------------------------------
// Fila 12c — propiedad de `id` entre currículos
// ---------------------------------------------------------------------------
{
  const [a, b] = ["chk-propiedad-a", "chk-propiedad-b"];
  const shared = uuid();
  const idsA = { m: shared, l: uuid() };
  assert.equal(loader(fixture(a, [mod(idsA.m, "pa", [les(idsA.l, "pl")])]), "--write").status, 0);

  // El caso real: alguien copia la plantilla y solo cambia el campo `curriculum`.
  const collision = loader(fixture(b, [mod(shared, "pb", [les(uuid(), "pl2")])]), "--write");
  assert.equal(collision.status, 1);
  assert.match(collision.stderr, new RegExp(shared));
  assert.match(collision.stderr, new RegExp(`"${a}"`));

  const rowsA = await rowsOf(a);
  assert.equal(rowsA.length, 2, "el currículo dueño quedó tocado");
  assert.equal(rowsA.find((r) => r.id === shared)!.curriculum, a, "el nodo migró de currículo");
  assert.equal((await rowsOf(b)).length, 0, "no debería haberse escrito nada en el segundo");
}

// ---------------------------------------------------------------------------
// Fila 12d — reutilización de `slug` y propiedad del esquema
// ---------------------------------------------------------------------------
{
  const c = "chk-slugs";
  const ids = { m: uuid(), x: uuid(), y: uuid() };
  assert.equal(
    loader(fixture(c, [mod(ids.m, "sm", [les(ids.x, "sa"), les(ids.y, "sb")])]), "--write").status, 0
  );

  // (a) Intercambio puro de `slug` entre hermanos: choca con el índice único a
  //     mitad de transacción salvo que la restricción sea diferible.
  const swap = loader(
    fixture(c, [mod(ids.m, "sm", [les(ids.x, "sb"), les(ids.y, "sa")])]), "--write"
  );
  assert.equal(swap.status, 0, `intercambiar dos slug falló: ${swap.stderr}`);
  let rows = await rowsOf(c);
  assert.equal(rows.find((r) => r.id === ids.x)!.slug, "sb");
  assert.equal(rows.find((r) => r.id === ids.y)!.slug, "sa");

  // (b) Retirar un nodo y reutilizar su etiqueta en la misma pasada: el paso 3
  //     corre ENTERO antes del 4, así que el slug que va a quedar libre sigue
  //     ocupado durante toda la fase de escritura.
  const reuse = loader(
    fixture(c, [mod(ids.m, "sm", [les(ids.y, "sb")])]), "--write", "--allow-deletes"
  );
  assert.equal(reuse.status, 0, `reutilizar un slug falló: ${reuse.stderr}`);
  rows = await rowsOf(c);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.id === ids.y)!.slug, "sb", "el `id` superviviente se conservó");
  assert.equal(rows.find((r) => r.id === ids.x), undefined);

  // Aserción DIRECTA sobre el catálogo. `drizzle-kit` no modela DEFERRABLE en su
  // instantánea, así que el parche vive solo en el `.sql` aplicado: una
  // regeneración que tire la cláusula solo se detectaría de rebote sin esto.
  const constraint = await db.execute(sql`
    select condeferrable, condeferred from pg_constraint
    where conname = 'curriculum_nodes_curriculum_slug_key'
  `);
  assert.equal(constraint.rows.length, 1, "la restricción nombrada no existe");
  assert.equal(constraint.rows[0].condeferrable, true, "la restricción única dejó de ser DEFERRABLE");
  assert.equal(
    constraint.rows[0].condeferred, false,
    "debe ser INITIALLY IMMEDIATE: solo el cargador se acoge, con SET CONSTRAINTS"
  );

  // Y la clave primaria NO puede ser diferible: rompería `ON CONFLICT (id)`.
  const pk = await db.execute(sql`
    select condeferrable from pg_constraint where conname = 'curriculum_nodes_pkey'
  `);
  assert.equal(pk.rows[0].condeferrable, false, "una PK diferible rompe el upsert por id");
}

// ---------------------------------------------------------------------------
// Filas 6 y 13 — consultas de jerarquía e índice ACOTADO AL MÓDULO
// ---------------------------------------------------------------------------
{
  const c = "chk-jerarquia";
  const ids = { e: uuid(), m1: uuid(), m2: uuid(), a: uuid(), b: uuid(), x: uuid() };
  const file = fixture(c, [
    {
      id: ids.e, slug: "JE1", kind: "stage", title: "Etapa",
      payload: {
        built: "algo", aiRole: "ninguno", hours: 10, milestone: "H1",
        status: "en-emision", statusLabel: "EN EMISIÓN", hasDetail: true,
      },
      children: [
        mod(ids.m1, "jm1", [les(ids.a, "ja1"), les(ids.b, "ja2")], { audience: "gente de jm1" }),
        mod(ids.m2, "jm2", [les(ids.x, "jb1")]),
      ],
    },
  ]);
  assert.equal(loader(file, "--write").status, 0);

  // Recorrido en profundidad, orden de `position` dentro de cada nivel.
  assert.deepEqual((await getLessons(c)).map((l) => l.slug), ["ja1", "ja2", "jb1"]);
  assert.deepEqual((await getLessons(c, "jm1")).map((l) => l.slug), ["ja1", "ja2"]);
  assert.deepEqual((await getLessons(c, "jm2")).map((l) => l.slug), ["jb1"]);
  assert.deepEqual((await getLessons(c, "JE1")).map((l) => l.slug), ["ja1", "ja2", "jb1"]);
  assert.deepEqual(await getLessons(c, "no-existe"), []);

  assert.deepEqual((await getAncestors(c, "ja1")).map((a) => a.slug), ["JE1", "jm1"]);
  assert.deepEqual((await getAncestors(c, "jm2")).map((a) => a.slug), ["JE1"]);
  assert.deepEqual(await getAncestors(c, "JE1"), []);

  // Fila 6 — con DOS módulos poblados, el índice del tutor lista solo las del
  // módulo de la lección declarada. Con `getLessons(curriculum)` a secas, esta
  // línea pasaría a listar el currículo entero etiquetado como "del módulo", y
  // el golden seguiría en verde porque hoy los dos conjuntos coinciden.
  const { moduleLessons, ancestors } = await getLessonContextInputs(c, "ja1");
  const block = buildLessonContext(moduleLessons, ancestors, "ja1");
  assert.match(block, /Lecciones del módulo: ja1 Lección ja1 · ja2 Lección ja2\./);
  assert.ok(!block.includes("jb1"), "el bloque del tutor listó lecciones de OTRO módulo");
  assert.match(block, /Tus estudiantes son gente de jm1\./);

  // Y el módulo sin `audience`: se omite la frase, no se interpola `undefined`.
  // La fila 7 lo cubre de forma pura en `check-curriculum.ts`; esto es el mismo
  // comportamiento contra datos reales de Postgres.
  const other = await getLessonContextInputs(c, "jb1");
  const otherBlock = buildLessonContext(other.moduleLessons, other.ancestors, "jb1");
  assert.ok(!otherBlock.includes("undefined"), "se interpoló `undefined` en el bloque de system");
  assert.ok(!otherBlock.includes("Tus estudiantes son"));
  assert.match(otherBlock, /Módulo en curso: "Módulo jm2"\./);
}

// ---------------------------------------------------------------------------
// Fila 14 — currículo no cargado
// ---------------------------------------------------------------------------
{
  const c = "chk-vacio"; // nadie lo ha tocado: la tabla está vacía para él
  await assert.rejects(() => getCurriculumForest(c), CurriculumNotLoadedError);

  // `getAncestors` NUNCA lanza: es el caso que hace que el tutor pregunte, y un
  // 500 aquí tumbaría /api/chat.
  assert.deepEqual(await getAncestors(c, "no-existe"), []);
  assert.deepEqual(await getAncestors("chk-jerarquia", "no-existe"), []);
}

// ---------------------------------------------------------------------------
// Fila 26 — degradación ante fallo de Postgres (va LA ÚLTIMA: rompe el pool)
// ---------------------------------------------------------------------------
{
  const c = "chk-degradado";
  const ids = { m: uuid(), l: uuid() };
  assert.equal(loader(fixture(c, [mod(ids.m, "dm", [les(ids.l, "dl")])]), "--write").status, 0);

  console.log(
    "  (fila 26: las dos trazas de 'sirviendo el último valor conocido' que vienen " +
      "a continuación son ESPERADAS — son la degradación funcionando)"
  );

  // Caché caliente: la primera lectura guarda el último valor conocido.
  const warm = await getCurriculumForest(c);
  assert.equal(warm.length, 1);

  // Base caída.
  await db.$client.end();
  await assert.rejects(() => db.select().from(curriculumNodes).limit(1), "el pool sigue vivo");

  // Se sirve el último valor conocido en vez de propagar el error. Sin esto,
  // cualquier hipo de Postgres sería un 500 en la landing pública.
  const degraded = await getCurriculumForest(c);
  assert.deepEqual(degraded.map((n) => n.slug), ["dm"]);
  assert.deepEqual((await getAncestors(c, "dl")).map((a) => a.slug), ["dm"]);
}

console.log(
  `OK — cargador y lectura sanos contra Postgres: ${scenarios.length} escenarios ` +
    "(idempotencia, identidad, aislamiento, guardarraíles, jerarquía y degradación)."
);
