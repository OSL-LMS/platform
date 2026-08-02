// Lectura de las emisiones desde Postgres. La tabla es una PROYECCIÓN de
// `curriculum/<slug>.seasons.json`; aquí sólo se lee — el único escritor en el
// entorno desplegado es `scripts/load-seasons.ts`. Ver PRD-008 §7.3.
//
// Importa con ruta relativa y extensión (no con el alias `@/lib/…`): Node no
// conoce los `paths` de tsconfig y este módulo se importa desde `scripts/`.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { eq } from "drizzle-orm";
import { db } from "./db.ts";
import { broadcasts, curriculumNodes } from "./schema.ts";

/**
 * Una emisión tal como la consume la home. `lessonSlug` y no `lessonNodeId`
 * porque `seasonAgenda()` empareja por slug; la resolución la hace el join de
 * aquí, una sola vez.
 */
export type Broadcast = {
  id: string;
  season: string;
  /** `""` si el nodo de la lección ya no existe — ver `readBroadcasts`. */
  lessonSlug: string;
  /** Instante ABSOLUTO. La hora de Colombia la pone el render (§6.2). */
  startsAt: Date;
  vodUrl: string | null;
};

/**
 * EL JOIN ES A LA IZQUIERDA, y no es un detalle de estilo.
 *
 * El precedente más cercano —`slugsByNodeId()` de PRD-007— OMITE los ids que ya
 * no resuelven. Eso es correcto para la evidencia y es exactamente lo contrario
 * de lo que §6.3 quiere aquí: una lección retirada del temario se llevaría por
 * delante la emisión histórica, con su fecha y su grabación, de una clase que
 * SÍ ocurrió. Toda fila de `broadcasts` tiene que llegar a `seasonAgenda`; un
 * `lesson_node_id` sin resolver produce la fila de título vacío que
 * `schedule.ts` ya sabe pintar.
 *
 * El orden es el del índice `broadcasts_curriculum_starts_idx`.
 */
async function readBroadcasts(curriculum: string): Promise<Broadcast[]> {
  const rows = await db
    .select({
      id: broadcasts.id,
      season: broadcasts.season,
      lessonSlug: curriculumNodes.slug,
      startsAt: broadcasts.startsAt,
      vodUrl: broadcasts.vodUrl,
    })
    .from(broadcasts)
    .leftJoin(curriculumNodes, eq(curriculumNodes.id, broadcasts.lessonNodeId))
    .where(eq(broadcasts.curriculum, curriculum))
    .orderBy(broadcasts.startsAt);

  return rows.map((row) => ({ ...row, lessonSlug: row.lessonSlug ?? "" }));
}

// `next/cache` se importa en dinámico por lo mismo que en `curriculum.ts`: bajo
// Node pelado (los checks de `scripts/`) ni resuelve el especificador ni existe
// el `incrementalCache` que `unstable_cache` exige. Mismo TTL de 600 s, que es
// lo que hace cierta la promesa de §4.1 paso 3: una `vodUrl` nueva aparece en
// ≤ 10 min sin desplegar.
type BroadcastReader = (curriculum: string) => Promise<Broadcast[]>;
let reader: BroadcastReader | null = null;

async function cachedBroadcasts(curriculum: string): Promise<Broadcast[]> {
  if (!reader) {
    try {
      const { unstable_cache } = await import("next/cache");
      reader = unstable_cache(readBroadcasts, ["broadcasts"], { revalidate: 600 });
    } catch {
      reader = readBroadcasts;
    }
  }
  return reader(curriculum);
}

// Último valor conocido por currículo, en memoria del proceso, igual que en
// `curriculum.ts`.
// ponytail: por proceso, no compartido entre instancias. Con varias réplicas
// cada una degrada por su cuenta.
const lastKnown = new Map<string, Broadcast[]>();

/** `name` y `code`, NUNCA la consulta (§7.3): el `message` de un error de `pg`
 *  puede arrastrar el texto de la sentencia a los logs. */
function describe(err: unknown): string {
  const shaped = err as { name?: unknown; code?: unknown } | null;
  const name = typeof shaped?.name === "string" ? shaped.name : "Error";
  const code = typeof shaped?.code === "string" ? shaped.code : null;
  return code ? `${name} (${code})` : name;
}

/**
 * Las emisiones de un currículo, ordenadas por fecha. **Nunca lanza.**
 *
 * Ahí está la diferencia con `curriculum.ts`, y es deliberada: aquél RELANZA
 * cuando fallan las tres capas, así que replicarlo al pie de la letra haría que
 * un fallo del calendario tumbase la home entera — lo contrario de lo que este
 * PRD promete. La última capa registra y devuelve `[]`: la sección de temporada
 * se omite, el resto de la home se pinta, y la home nunca inventa una fecha.
 *
 * Se registra porque el operador SÍ tiene que poder distinguir "no hay
 * directos" de "la lectura falló". Que el visitante no los distinga es
 * correcto; que el operador tampoco, no — durante una temporada viva,
 * "indistinguible" es el problema.
 */
export async function getBroadcasts(curriculum: string): Promise<Broadcast[]> {
  try {
    const rows = await cachedBroadcasts(curriculum);
    lastKnown.set(curriculum, rows);
    return rows;
  } catch (err) {
    const stale = lastKnown.get(curriculum);
    if (stale) {
      console.error(`Emisiones: sirviendo el último valor conocido — ${describe(err)}`);
      return stale;
    }
    // Sin caché del que servir. También es el camino de los scripts: fuera del
    // runtime de Next, `unstable_cache` lanza siempre.
    try {
      const fresh = await readBroadcasts(curriculum);
      lastKnown.set(curriculum, fresh);
      return fresh;
    } catch (readErr) {
      console.error(
        `Emisiones: no se pudieron leer, se omite la sección de temporada — ${describe(readErr)}`
      );
      return [];
    }
  }
}
