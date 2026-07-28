// Cargador del currículo: proyecta `curriculum/<slug>.json` sobre la tabla
// `curriculum_nodes`. Es el ÚNICO escritor en el entorno desplegado (PRD-002
// §7, invariante 1) y corre desde la máquina del operador contra la
// DATABASE_URL del entorno destino, igual que cualquier migración.
//
//   pnpm curriculum:load [archivo]              valida y reporta el diff
//   pnpm curriculum:load --write                escribe
//   pnpm curriculum:load --write --allow-deletes
//   pnpm curriculum:load --write --allow-identity-change L1 L2
//
// Regla de código: identificadores en inglés, comentarios en español.

import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../src/lib/db.ts";
import { curriculumNodes } from "../src/lib/schema.ts";
import { parseCurriculumFile, type FlatNode } from "../src/lib/curriculum-file.ts";

const DEFAULT_FILE = "curriculum/contextia.json";

type Options = {
  file: string;
  write: boolean;
  allowDeletes: boolean;
  /** Slugs autorizados a cambiar de identidad (clase `borrar+crear`). */
  allowIdentityChange: Set<string>;
};

function parseArgs(argv: string[]): Options {
  const options: Options = {
    file: DEFAULT_FILE,
    write: false,
    allowDeletes: false,
    allowIdentityChange: new Set(),
  };
  let positional: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--write") options.write = true;
    else if (arg === "--allow-deletes") options.allowDeletes = true;
    else if (arg === "--allow-identity-change") {
      // Consume todos los slugs que sigan, hasta la próxima bandera.
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        options.allowIdentityChange.add(argv[++i]);
      }
    } else if (arg.startsWith("--")) {
      abort(`bandera desconocida: ${arg}`);
    } else if (positional === null) {
      positional = arg;
    } else {
      abort(`argumento posicional de más: ${arg}`);
    }
  }

  if (positional) options.file = positional;
  return options;
}

function abort(message: string): never {
  console.error(`curriculum:load — ${message}`);
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
  slug: string;
  title: string;
  curriculum: string;
};

type Diff = {
  create: FlatNode[];
  /** Solo los que cambian de verdad algún campo: es lo que mueve `updated_at`. */
  update: FlatNode[];
  /** Bajas puras: su `slug` no reaparece en el archivo. */
  remove: ExistingRow[];
  /** Baja + alta emparejadas por `slug`: la firma de un `id` cambiado. */
  identityChange: { slug: string; before: ExistingRow; after: FlatNode }[];
};

function classify(nodes: FlatNode[], existing: ExistingRow[], existingFull: Map<string, FlatNode>): Diff {
  const existingById = new Map(existing.map((row) => [row.id, row]));
  const fileById = new Map(nodes.map((node) => [node.id, node]));

  const created = nodes.filter((node) => !existingById.has(node.id));
  const removed = existing.filter((row) => !fileById.has(row.id));

  // `borrar+crear` = una baja y un alta en la misma pasada con el MISMO slug.
  // Es lo único que, desde una instantánea única, delata un `id` cambiado.
  const createdBySlug = new Map(created.map((node) => [node.slug, node]));
  const identityChange: Diff["identityChange"] = [];
  for (const row of removed) {
    const after = createdBySlug.get(row.slug);
    if (after) identityChange.push({ slug: row.slug, before: row, after });
  }
  const identitySlugs = new Set(identityChange.map((c) => c.slug));

  const updated = nodes.filter((node) => {
    const before = existingFull.get(node.id);
    if (!before) return false;
    return (
      before.curriculum !== node.curriculum ||
      before.slug !== node.slug ||
      before.parentId !== node.parentId ||
      before.kind !== node.kind ||
      before.title !== node.title ||
      before.position !== node.position ||
      // Comparación profunda, NO `JSON.stringify`: Postgres reordena las llaves
      // de un `jsonb` al guardarlo, así que comparar cadenas marcaría como
      // "actualizado" todo nodo con más de una llave en cada carga — y el
      // conteo dejaría de coincidir con lo que hace el `setWhere` del upsert,
      // que compara jsonb contra jsonb.
      !isDeepStrictEqual(before.payload, node.payload)
    );
  });

  return {
    create: created.filter((node) => !identitySlugs.has(node.slug)),
    update: updated,
    remove: removed.filter((row) => !identitySlugs.has(row.slug)),
    identityChange,
  };
}

function report(diff: Diff, write: boolean): void {
  const header = write ? "Aplicando" : "Simulación (sin --write no se escribe nada)";
  console.log(`curriculum:load — ${header}`);
  console.log(`  crear:        ${diff.create.length}`);
  console.log(`  actualizar:   ${diff.update.length}`);
  console.log(`  borrar:       ${diff.remove.length}`);
  console.log(`  borrar+crear: ${diff.identityChange.length}`);

  for (const node of diff.create) console.log(`  + ${node.slug} — ${node.title}`);
  for (const node of diff.update) console.log(`  ~ ${node.slug} — ${node.title}`);
  for (const row of diff.remove) console.log(`  - ${row.slug} — ${row.title}`);
  for (const change of diff.identityChange) {
    console.log(
      `  ! ${change.slug} — "${change.before.title}" cambia de identidad: ` +
        `${change.before.id} → ${change.after.id}`
    );
  }
}

/**
 * El guardarraíl. Cualquier borrado exige `--allow-deletes`; cada cambio de
 * identidad exige que su `slug` esté nombrado en `--allow-identity-change`.
 * Las dos autorizaciones están separadas a propósito: quien aprueba UN borrado
 * no está autorizando en silencio cualquier cambio de identidad que venga en el
 * mismo archivo.
 */
function authorize(diff: Diff, options: Options): void {
  const problems: string[] = [];

  if (diff.remove.length > 0 && !options.allowDeletes) {
    problems.push(
      `${diff.remove.length} nodo(s) desaparecerían del archivo. Con ellos muere su ` +
        `\`id\` y todo lo que cuelgue de esa fila (hoy nada; en cuanto exista el ` +
        `seguimiento de progreso, el progreso del estudiante por cascada):`
    );
    for (const row of diff.remove) problems.push(`    - ${row.slug} — "${row.title}"`);
    problems.push("  Si es lo que quieres, repite con --allow-deletes.");
  }

  const unauthorized = diff.identityChange.filter(
    (change) => !options.allowIdentityChange.has(change.slug)
  );
  if (unauthorized.length > 0) {
    problems.push(
      `${unauthorized.length} nodo(s) cambian de identidad (mismo slug, otro \`id\`). ` +
        `--allow-deletes NO autoriza esta clase:`
    );
    for (const change of unauthorized) {
      problems.push(
        `    ! ${change.slug} — "${change.before.title}" (fila actual en la base)`
      );
    }
    problems.push(
      `  Si es lo que quieres, repite con --allow-identity-change ${unauthorized
        .map((c) => c.slug)
        .join(" ")}`
    );
  }

  if (problems.length > 0) {
    console.error("curriculum:load — abortado por el guardarraíl:");
    for (const line of problems) console.error(`  ${line}`);
    throw new LoadAbort();
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (!process.env.DATABASE_URL) {
    abort("falta DATABASE_URL: el cargador escribe contra el entorno destino.");
  }

  // Paso 1 — parsear y validar el archivo ENTERO. Cualquier fallo aborta sin
  // abrir escritura, y el mensaje nombra el nodo y la regla.
  let nodes: FlatNode[];
  try {
    nodes = parseCurriculumFile(JSON.parse(readFileSync(options.file, "utf8")));
  } catch (err) {
    abort(`${options.file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const curriculum = nodes[0]?.curriculum;
  if (!curriculum) abort(`${options.file}: el archivo no declara ningún nodo.`);

  await db.transaction(async (tx) => {
    // Paso 0 — PRIMERA sentencia de la transacción. El paso 2 es una lectura y
    // el 3 una escritura: bajo READ COMMITTED dos cargas concurrentes pueden
    // ver ambas que un `id` no existe. `SELECT ... FOR UPDATE` no cierra esto
    // (la fila peligrosa es la que todavía no existe), así que serializamos la
    // operación entera. Se libera solo en el COMMIT o el ROLLBACK.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('curriculum_nodes'))`);

    // Intercambiar dos `slug`, o reutilizar el de un nodo retirado, viola el
    // índice único a mitad de la fase de escritura: el paso 3 corre entero
    // antes del 4. Diferida, Postgres comprueba el estado final en el COMMIT.
    await tx.execute(
      sql`set constraints curriculum_nodes_curriculum_slug_key deferred`
    );

    // Paso 2 — propiedad de `id`, solo lectura. La clave primaria es GLOBAL y
    // el upsert tiene como objetivo de conflicto `id`: sin esto,
    // `ON CONFLICT (id) DO UPDATE` sobrescribiría la fila entera incluida su
    // columna `curriculum`, y el nodo migraría de currículo arrastrando su
    // subárbol. Disparador nada hipotético: copiar la plantilla conserva los
    // UUID.
    const fileIds = nodes.map((node) => node.id);
    const clashes = await tx
      .select({
        id: curriculumNodes.id,
        curriculum: curriculumNodes.curriculum,
        slug: curriculumNodes.slug,
      })
      .from(curriculumNodes)
      .where(inArray(curriculumNodes.id, fileIds));

    const foreign = clashes.filter((row) => row.curriculum !== curriculum);
    if (foreign.length > 0) {
      console.error(
        "curriculum:load — abortado: hay `id` que ya pertenecen a otro currículo."
      );
      for (const row of foreign) {
        const node = nodes.find((n) => n.id === row.id)!;
        console.error(
          `    ${row.id} pertenece al currículo "${row.curriculum}" (como "${row.slug}") ` +
            `y el archivo lo declara como "${node.slug}" de "${curriculum}".`
        );
      }
      console.error(
        "  Si copiaste la plantilla, regenera los `id` — ver curriculum/README.md."
      );
      throw new LoadAbort();
    }

    // Diff contra lo que hay hoy en ESTE currículo.
    const existingRows = await tx
      .select()
      .from(curriculumNodes)
      .where(eq(curriculumNodes.curriculum, curriculum));

    const existing: ExistingRow[] = existingRows.map((row) => ({
      id: row.id,
      slug: row.slug,
      title: row.title,
      curriculum: row.curriculum,
    }));
    const existingFull = new Map<string, FlatNode>(
      existingRows.map((row) => [
        row.id,
        {
          id: row.id,
          curriculum: row.curriculum,
          slug: row.slug,
          parentId: row.parentId,
          kind: row.kind,
          title: row.title,
          position: row.position,
          payload: row.payload,
          depth: 0,
        },
      ])
    );

    const diff = classify(nodes, existing, existingFull);
    report(diff, options.write);
    authorize(diff, options);

    if (!options.write) {
      console.log("curriculum:load — sin --write no se ha escrito nada.");
      return;
    }

    // Paso 3 — upsert POR `id`, en orden ascendente de `depth` para que el
    // padre exista cuando llega el hijo. Ordena la profundidad, no la posición
    // en el documento: un padre siempre tiene profundidad estrictamente menor.
    for (const node of nodes) {
      const values = {
        id: node.id,
        curriculum: node.curriculum,
        slug: node.slug,
        parentId: node.parentId,
        kind: node.kind,
        title: node.title,
        position: node.position,
        payload: node.payload,
      };
      await tx
        .insert(curriculumNodes)
        .values(values)
        .onConflictDoUpdate({
          target: curriculumNodes.id,
          set: { ...values, updatedAt: new Date() },
          // `updated_at` solo se mueve cuando algún campo difiere. Sin esta
          // condición, o no cambia nunca o cambia en todas las filas en cada
          // carga, y el conteo de "actualizados" sería siempre el total.
          setWhere: sql`(
            ${curriculumNodes.curriculum}, ${curriculumNodes.slug}, ${curriculumNodes.parentId},
            ${curriculumNodes.kind}, ${curriculumNodes.title}, ${curriculumNodes.position},
            ${curriculumNodes.payload}
          ) is distinct from (
            excluded.curriculum, excluded.slug, excluded.parent_id,
            excluded.kind, excluded.title, excluded.position,
            excluded.payload
          )`,
        });
    }

    // Paso 4 — borrado acotado a ESTE currículo. Después del upsert, nunca
    // antes: con el borrado primero, mover una lección de módulo borraría al
    // padre viejo y `on delete cascade` se llevaría a la hija que sí sigue en
    // el archivo, rompiendo la estabilidad del `id`.
    const doomed = existing
      .filter((row) => !nodes.some((node) => node.id === row.id))
      .map((row) => row.id);
    if (doomed.length > 0) {
      await tx
        .delete(curriculumNodes)
        .where(
          and(
            eq(curriculumNodes.curriculum, curriculum),
            inArray(curriculumNodes.id, doomed)
          )
        );
    }

    console.log(
      `curriculum:load — OK: ${nodes.length} nodos en "${curriculum}" ` +
        `(${diff.create.length + diff.identityChange.length} creados, ` +
        `${diff.update.length} actualizados, ` +
        `${diff.remove.length + diff.identityChange.length} borrados).`
    );
  });
}

try {
  await main();
} catch (err) {
  // LoadAbort ya imprimió su diagnóstico; el resto son fallos inesperados.
  if (!(err instanceof LoadAbort)) {
    console.error("curriculum:load — error:", err instanceof Error ? err.message : err);
  }
  process.exitCode = 1;
} finally {
  await db.$client.end();
}
