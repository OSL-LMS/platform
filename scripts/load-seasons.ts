// Cargador de temporadas: proyecta `curriculum/<slug>.seasons.json` sobre la
// tabla `broadcasts`. Es el ÚNICO escritor en el entorno desplegado (PRD-008
// §7.2, §8) y corre desde la máquina del operador contra la DATABASE_URL del
// entorno destino, igual que cualquier migración.
//
//   pnpm seasons:load [archivo]              valida y reporta el diff
//   pnpm seasons:load --write                escribe
//   pnpm seasons:load --write --allow-deletes
//
// HERMANO de `load-curriculum.ts`, y no una fase suya (§7.2): las dos cosas se
// editan en momentos distintos —el temario por trimestre, las fechas por
// temporada y los `vodUrl` semanalmente— y acoplarlas obligaría a recargar el
// currículo entero para añadir la URL de una grabación.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { readFileSync } from "node:fs";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../packages/shared/src/db.ts";
import { broadcasts, curriculumNodes } from "../packages/shared/src/schema.ts";
import {
  parseSeasonsFile,
  resolveBroadcasts,
  type BroadcastRecord,
  type SeasonsFile,
} from "../packages/shared/src/broadcasts-file.ts";

const DEFAULT_FILE = "curriculum/contextia.seasons.json";

type Options = {
  file: string;
  write: boolean;
  allowDeletes: boolean;
};

function parseArgs(argv: string[]): Options {
  const options: Options = { file: DEFAULT_FILE, write: false, allowDeletes: false };
  let positional: string | null = null;

  for (const arg of argv) {
    if (arg === "--write") options.write = true;
    else if (arg === "--allow-deletes") options.allowDeletes = true;
    else if (arg.startsWith("--")) abort(`bandera desconocida: ${arg}`);
    else if (positional === null) positional = arg;
    else abort(`argumento posicional de más: ${arg}`);
  }

  if (positional) options.file = positional;
  return options;
}

function abort(message: string): never {
  console.error(`seasons:load — ${message}`);
  process.exit(1);
}

/** Aborto desde DENTRO de la transacción. Lanza en vez de `process.exit` para
 *  que Postgres haga ROLLBACK y el pool se cierre: salir a lo bruto deja el
 *  `finally` sin correr. El mensaje ya se imprimió; el `catch` de fuera no lo
 *  repite. */
class LoadAbort extends Error {
  constructor() {
    super("abortado");
    this.name = "LoadAbort";
  }
}

/** Fila tal como vive hoy en la base, para el diff y los mensajes de aborto. */
type ExistingRow = {
  id: string;
  season: string;
  lessonNodeId: string;
  startsAt: Date;
  vodUrl: string | null;
};

type Diff = {
  create: BroadcastRecord[];
  /** Sólo las que cambian de verdad algún campo: es lo que mueve `updated_at`. */
  update: BroadcastRecord[];
  remove: ExistingRow[];
};

function classify(records: BroadcastRecord[], existing: ExistingRow[]): Diff {
  const existingById = new Map(existing.map((row) => [row.id, row]));
  const fileById = new Map(records.map((record) => [record.id, record]));

  return {
    create: records.filter((record) => !existingById.has(record.id)),
    update: records.filter((record) => {
      const before = existingById.get(record.id);
      if (!before) return false;
      return (
        before.season !== record.season ||
        before.lessonNodeId !== record.lessonNodeId ||
        // Por instante, NO por identidad de `Date` ni por su representación:
        // dos `Date` distintos pueden ser el mismo momento.
        before.startsAt.getTime() !== record.startsAt.getTime() ||
        before.vodUrl !== record.vodUrl
      );
    }),
    remove: existing.filter((row) => !fileById.has(row.id)),
  };
}

/** Cómo nombrar una emisión en los mensajes. El `slug` sale del mapa cuando el
 *  nodo existe; cuando no —una lección retirada del temario— cae al UUID, que
 *  es justo el caso que §6.3 protege: la emisión sobrevive al nodo. */
function describe(
  row: { season: string; lessonNodeId: string; startsAt: Date },
  slugByNodeId: Map<string, string>
): string {
  const slug = slugByNodeId.get(row.lessonNodeId) ?? `nodo ${row.lessonNodeId}`;
  return `${slug} en "${row.season}" (${row.startsAt.toISOString()})`;
}

function report(diff: Diff, write: boolean, slugByNodeId: Map<string, string>): void {
  const header = write ? "Aplicando" : "Simulación (sin --write no se escribe nada)";
  console.log(`seasons:load — ${header}`);
  console.log(`  crear:      ${diff.create.length}`);
  console.log(`  actualizar: ${diff.update.length}`);
  console.log(`  borrar:     ${diff.remove.length}`);

  for (const record of diff.create) console.log(`  + ${describe(record, slugByNodeId)}`);
  for (const record of diff.update) console.log(`  ~ ${describe(record, slugByNodeId)}`);
  for (const row of diff.remove) console.log(`  - ${describe(row, slugByNodeId)}`);
}

/**
 * El guardarraíl, y LA MITAD QUE FALTABA DE §6.3. Sin clave foránea, retirar
 * una lección del temario ya no puede borrar su emisión — pero quitar una línea
 * del archivo de temporadas sí, y en silencio. Proteger un hecho histórico de
 * una puerta y dejarlo abierto por la otra no lo protege.
 */
function authorize(diff: Diff, options: Options, slugByNodeId: Map<string, string>): void {
  if (diff.remove.length === 0 || options.allowDeletes) return;

  console.error("seasons:load — abortado por el guardarraíl:");
  console.error(
    `  ${diff.remove.length} emisión(es) desaparecerían del archivo. Una clase emitida es un ` +
      `hecho histórico: con ella muere su fecha y su grabación, aunque la clase sí ocurriera.`
  );
  for (const row of diff.remove) {
    const vod = row.vodUrl ? ` — grabación: ${row.vodUrl}` : " — sin grabación";
    console.error(`    - ${describe(row, slugByNodeId)}${vod}`);
  }
  console.error("  Si es lo que quieres, repite con --allow-deletes.");
  throw new LoadAbort();
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (!process.env.DATABASE_URL) {
    abort("falta DATABASE_URL: el cargador escribe contra el entorno destino.");
  }

  // Paso 1 — parsear y validar el archivo ENTERO, sin base de datos. Lo que
  // aquí no se puede comprobar es que cada `lessonSlug` resuelva: eso necesita
  // el currículo, y va dentro de la transacción para verlo consistente.
  let parsed: SeasonsFile;
  try {
    parsed = parseSeasonsFile(JSON.parse(readFileSync(options.file, "utf8")));
  } catch (err) {
    abort(`${options.file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const curriculum = parsed.curriculum;

  await db.transaction(async (tx) => {
    // Paso 0 — PRIMERA sentencia de la transacción. El paso 3 es una lectura y
    // el 5 una escritura: bajo READ COMMITTED dos cargas concurrentes pueden
    // ver ambas que un `id` no existe. `SELECT ... FOR UPDATE` no cierra esto
    // (la fila peligrosa es la que todavía no existe), así que se serializa la
    // operación entera. Se libera sólo en el COMMIT o el ROLLBACK.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('broadcasts'))`);

    // Paso 2 — el currículo, para resolver `lessonSlug` y para los mensajes.
    // No hace falta el árbol: `curriculum_nodes` lleva `slug` y `kind` como
    // columnas, así que la búsqueda es directa (§7.2).
    const lessons = await tx
      .select({
        id: curriculumNodes.id,
        slug: curriculumNodes.slug,
        kind: curriculumNodes.kind,
      })
      .from(curriculumNodes)
      .where(eq(curriculumNodes.curriculum, curriculum));

    const slugByNodeId = new Map(lessons.map((lesson) => [lesson.id, lesson.slug]));

    // La integridad que la clave foránea NO da (§6.3): el archivo entero se
    // rechaza si algún `lessonSlug` no existe o no es `kind: "lesson"`. Es más
    // fuerte que el tipo `LessonId` que se perdió, porque además cubre el kind.
    let records: BroadcastRecord[];
    try {
      records = resolveBroadcasts(parsed.broadcasts, lessons);
    } catch (err) {
      console.error(
        `seasons:load — ${options.file}: ${err instanceof Error ? err.message : String(err)}`
      );
      throw new LoadAbort();
    }

    // Paso 3 — propiedad de `id`, sólo lectura. La clave primaria es GLOBAL y
    // el upsert tiene como objetivo de conflicto `id`; como §6.5 deja
    // `curriculum` FUERA del `set`, sin esta comprobación un `id` copiado de
    // otro currículo no migraría de dueño: le sobrescribiría en silencio la
    // temporada, la lección y la fecha a una emisión ajena. Disparador nada
    // hipotético: copiar la plantilla conserva los UUID.
    const fileIds = records.map((record) => record.id);
    if (fileIds.length > 0) {
      const clashes = await tx
        .select({
          id: broadcasts.id,
          curriculum: broadcasts.curriculum,
          season: broadcasts.season,
        })
        .from(broadcasts)
        .where(inArray(broadcasts.id, fileIds));

      const foreign = clashes.filter((row) => row.curriculum !== curriculum);
      if (foreign.length > 0) {
        console.error("seasons:load — abortado: hay `id` que ya pertenecen a otro currículo.");
        for (const row of foreign) {
          console.error(
            `    ${row.id} pertenece al currículo "${row.curriculum}" (temporada "${row.season}") ` +
              `y el archivo lo declara como "${curriculum}".`
          );
        }
        console.error(
          "  Si copiaste la plantilla, regenera los `id` — ver curriculum/README.md."
        );
        throw new LoadAbort();
      }
    }

    // Paso 4 — diff contra lo que hay hoy en ESTE currículo.
    const existing: ExistingRow[] = await tx
      .select({
        id: broadcasts.id,
        season: broadcasts.season,
        lessonNodeId: broadcasts.lessonNodeId,
        startsAt: broadcasts.startsAt,
        vodUrl: broadcasts.vodUrl,
      })
      .from(broadcasts)
      .where(eq(broadcasts.curriculum, curriculum));

    const diff = classify(records, existing);
    report(diff, options.write, slugByNodeId);
    authorize(diff, options, slugByNodeId);

    if (!options.write) {
      console.log("seasons:load — sin --write no se ha escrito nada.");
      return;
    }

    // Paso 5 — upsert POR `id`. El `set` se nombra explícitamente (§6.5):
    // `created_at` no aparece, y `curriculum` tampoco — una fila no cambia de
    // dueño, y el paso 3 ya garantizó que ninguna ajena está en juego.
    //
    // `updated_at` lleva `defaultNow()` y NO `$onUpdate`, así que un camino de
    // conflicto que no lo nombre conserva el valor de inserción; el `setWhere`
    // hace que sólo se mueva cuando algo difiere de verdad. Sin él el recuento
    // de "actualizados" sería siempre cero o siempre la tabla entera, y el
    // operador perdería la señal que le dice qué hizo su carga.
    for (const record of records) {
      await tx
        .insert(broadcasts)
        .values({
          id: record.id,
          curriculum: record.curriculum,
          season: record.season,
          lessonNodeId: record.lessonNodeId,
          startsAt: record.startsAt,
          vodUrl: record.vodUrl,
        })
        .onConflictDoUpdate({
          target: broadcasts.id,
          set: {
            season: record.season,
            lessonNodeId: record.lessonNodeId,
            startsAt: record.startsAt,
            vodUrl: record.vodUrl,
            updatedAt: new Date(),
          },
          setWhere: sql`(
            ${broadcasts.season}, ${broadcasts.lessonNodeId},
            ${broadcasts.startsAt}, ${broadcasts.vodUrl}
          ) is distinct from (
            excluded.season, excluded.lesson_node_id,
            excluded.starts_at, excluded.vod_url
          )`,
        });
    }

    // Paso 6 — borrado acotado a ESTE currículo, y DESPUÉS del upsert, por
    // paralelismo con `load-curriculum.ts`.
    //
    // Residual conocido: la clave única de §6.1 NO es diferible, así que mover
    // una emisión al hueco exacto —misma temporada, misma lección, mismo
    // instante— de otra que este mismo archivo retira fallaría a mitad de la
    // fase de escritura. Exige `--allow-deletes` y una coincidencia exacta de
    // los cuatro campos; se deja escrito en vez de resuelto porque §6.1 no
    // declara la restricción diferible.
    const doomed = diff.remove.map((row) => row.id);
    if (doomed.length > 0) {
      await tx
        .delete(broadcasts)
        .where(and(eq(broadcasts.curriculum, curriculum), inArray(broadcasts.id, doomed)));
    }

    console.log(
      `seasons:load — OK: ${records.length} emisión(es) en "${curriculum}" ` +
        `(${diff.create.length} creadas, ${diff.update.length} actualizadas, ` +
        `${diff.remove.length} borradas).`
    );
  });
}

try {
  await main();
} catch (err) {
  // LoadAbort ya imprimió su diagnóstico; el resto son fallos inesperados.
  if (!(err instanceof LoadAbort)) {
    console.error("seasons:load — error:", err instanceof Error ? err.message : err);
  }
  process.exitCode = 1;
} finally {
  await db.$client.end();
}
