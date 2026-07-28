// Lectura del currículo desde Postgres. La tabla es una PROYECCIÓN de
// `curriculum/<slug>.json`; aquí solo se lee — el único escritor en el entorno
// desplegado es `scripts/load-curriculum.ts`. Ver PRD-002 §5.2.
//
// Importa con ruta relativa y extensión (no con el alias `@/lib/…`): Node no
// conoce los `paths` de tsconfig y este módulo se importa desde `scripts/`.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { eq } from "drizzle-orm";
import { db } from "./db.ts";
import { curriculumNodes } from "./schema.ts";
import {
  ancestorsOf,
  buildForest,
  lessonContextInputs,
  lessonsUnder,
  type CurriculumNode,
} from "./curriculum-file.ts";

export type { CurriculumNode } from "./curriculum-file.ts";

/** La forma que reciben los selectores. No el nodo completo: `payload.stuck`
 *  no tiene por qué viajar al cliente, y `/registro` es pública y sin login. */
export type LessonOption = Pick<CurriculumNode, "slug" | "title">;

export class CurriculumNotLoadedError extends Error {
  constructor(curriculum: string) {
    super(
      `El currículo "${curriculum}" no está cargado en la base de datos. ` +
        `Ejecuta \`pnpm curriculum:load --write\` antes de desplegar.`
    );
    this.name = "CurriculumNotLoadedError";
  }
}

/**
 * `CURRICULUM_SLUG` es obligatoria y sin defecto. Un defecto `"contextia"`
 * dejaría un literal de Contextia en `src/` (invariante 2 de §7) y haría que un
 * entorno mal configurado seleccionase Contextia en silencio en vez de fallar.
 * **Nunca se deriva del request** (§8.5): es configuración de servidor.
 */
export function curriculumSlug(): string {
  const slug = process.env.CURRICULUM_SLUG;
  if (!slug) {
    throw new Error(
      "Falta CURRICULUM_SLUG: es obligatoria y no tiene defecto (ver .env.example)."
    );
  }
  return slug;
}

// Una sola consulta trae el currículo entero y el árbol se arma en memoria: las
// cuatro funciones públicas son recorridos puros sobre ese bosque.
async function readForest(curriculum: string): Promise<CurriculumNode[]> {
  const rows = await db
    .select()
    .from(curriculumNodes)
    .where(eq(curriculumNodes.curriculum, curriculum));
  return buildForest(rows);
}

// `next/cache` se importa en dinámico a propósito: bajo Node pelado (los checks
// de `scripts/`) ni resuelve el especificador ni existe el `incrementalCache`
// que `unstable_cache` exige, y un import estático haría que este módulo ni
// siquiera cargase fuera del servidor de Next. El fallo cae en el `catch` de
// `loadForest`, que ya sabe leer sin caché.
//
// Sin `tags`: la invalidación inmediata sería la respuesta ideal a la retirada
// de urgencia de un `stuck` dañino, pero no hay CRUD ni panel desde donde
// llamar a `revalidateTag` — declarar la etiqueta sugeriría una capacidad que
// no existe. Con 600 s, un cambio de solo contenido se propaga en ≤ 10 min sin
// redesplegar; sin TTL no llegaría hasta el siguiente despliegue.
type ForestReader = (curriculum: string) => Promise<CurriculumNode[]>;
let reader: ForestReader | null = null;

async function cachedForest(curriculum: string): Promise<CurriculumNode[]> {
  if (!reader) {
    try {
      const { unstable_cache } = await import("next/cache");
      reader = unstable_cache(readForest, ["curriculum-forest"], {
        revalidate: 600,
      });
    } catch {
      // Fuera del servidor de Next (los checks de `scripts/`) el especificador
      // ni resuelve. Se decide UNA vez: sin caché, lectura directa. Que este
      // camino no ensucie la salida importa, porque el `catch` de `loadForest`
      // sí señala un fallo real.
      reader = readForest;
    }
  }
  return reader(curriculum);
}

// Último valor conocido por currículo, en memoria del proceso. Es lo que hace
// cierta la rama degradada de §4.2: sin un caché real del que servir, un hipo
// de Postgres sería un 500 en la landing pública. No se da por sentado que
// `unstable_cache` sirva el valor stale cuando falla la revalidación — es el
// respaldo que PRD-002 §11 punto 3 deja escrito, y hace la promesa cierta
// independientemente de cómo se comporte una API `unstable_*`.
// ponytail: por proceso, no compartido entre instancias. Basta mientras haya
// un solo servidor Node; con varias réplicas cada una degrada por su cuenta.
const lastKnown = new Map<string, CurriculumNode[]>();

async function loadForest(curriculum: string): Promise<CurriculumNode[]> {
  try {
    const forest = await cachedForest(curriculum);
    lastKnown.set(curriculum, forest);
    return forest;
  } catch (err) {
    const stale = lastKnown.get(curriculum);
    if (stale) {
      console.error("Currículo: sirviendo el último valor conocido —", err);
      return stale;
    }
    // Sin caché del que servir. También es el camino de los scripts: fuera del
    // runtime de Next, `unstable_cache` lanza siempre. Si Postgres falla aquí,
    // el error sube, que es lo correcto: no hay nada que servir.
    const fresh = await readForest(curriculum);
    lastKnown.set(curriculum, fresh);
    return fresh;
  }
}

/** Las raíces del currículo, en orden de `position`. El currículo es un
 *  BOSQUE, no un árbol: hoy son las 4 etapas hermanas. */
export async function getCurriculumForest(
  curriculum: string
): Promise<CurriculumNode[]> {
  const forest = await loadForest(curriculum);
  if (forest.length === 0) throw new CurriculumNotLoadedError(curriculum);
  return forest;
}

/** Lecciones (`kind === "lesson"`) bajo `rootSlug`, a cualquier profundidad, en
 *  orden de recorrido en profundidad. Sin `rootSlug`, todas las del currículo. */
export async function getLessons(
  curriculum: string,
  rootSlug?: string
): Promise<CurriculumNode[]> {
  return lessonsUnder(await getCurriculumForest(curriculum), rootSlug);
}

/** Cadena de ancestros de un nodo, de la raíz hacia abajo. `[]` si el slug no
 *  existe — y también si no hay currículo cargado. **Nunca lanza**: es el caso
 *  que hace que el tutor pregunte, y un 500 ahí tumbaría `/api/chat`. */
export async function getAncestors(
  curriculum: string,
  slug: string
): Promise<CurriculumNode[]> {
  try {
    return ancestorsOf(await loadForest(curriculum), slug);
  } catch (err) {
    console.error("Currículo: no se pudo leer el árbol para getAncestors —", err);
    return [];
  }
}

/**
 * Los dos argumentos que `buildLessonContext` necesita, resueltos contra la
 * base en una sola consulta: las lecciones del módulo de esa lección (NO las
 * del currículo entero) y su cadena de ancestros.
 *
 * **Nunca lanza.** Un currículo sin cargar o un slug inexistente devuelven el
 * par vacío, que es la rama "el tutor pregunta" de siempre — un 500 aquí
 * tumbaría `/api/chat`, y §4.2 acota el error de despliegue a la home, `/chat`
 * y `/registro`.
 */
export async function getLessonContextInputs(
  curriculum: string,
  lessonSlug?: string
): Promise<{ moduleLessons: CurriculumNode[]; ancestors: CurriculumNode[] }> {
  const empty = { moduleLessons: [], ancestors: [] };
  if (!lessonSlug) return empty;
  try {
    return lessonContextInputs(await loadForest(curriculum), lessonSlug);
  } catch (err) {
    console.error("Currículo: no se pudo componer el contexto del tutor —", err);
    return empty;
  }
}

/** Lo que viaja al cliente: `{slug, title}` y nada más. */
export function toLessonOptions(lessons: CurriculumNode[]): LessonOption[] {
  return lessons.map((l) => ({ slug: l.slug, title: l.title }));
}
