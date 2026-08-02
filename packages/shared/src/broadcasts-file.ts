// Parseo y contrato del archivo de temporadas. SIN dependencias de base de
// datos, igual que `curriculum-file.ts`: es lo que permite que la puerta de
// revisión de un PR corra las reglas enteras sobre el archivo, sin Postgres
// (PRD-008 §4.1 paso 2).
//
// Importa con ruta relativa y extensión (no con el alias `@/lib/…`): Node no
// conoce los `paths` de tsconfig y este módulo se importa desde `scripts/`.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { checkUrlSafety, SLUG_PATTERN } from "./curriculum-file.ts";

export class SeasonsFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeasonsFileError";
  }
}

/** Una emisión ya aplanada, con su instante ABSOLUTO resuelto y todavía sin
 *  `lessonNodeId`: resolver el slug exige conocer el currículo, y eso es un
 *  paso aparte (`resolveBroadcasts`) porque el cargador lo hace contra Postgres
 *  y la puerta del PR contra `parseCurriculumFile`. */
export type ParsedBroadcast = {
  id: string;
  curriculum: string;
  season: string;
  lessonSlug: string;
  startsAt: Date;
  vodUrl: string | null;
};

/** Lo mínimo que hace falta de una lección para resolver un `lessonSlug`.
 *  Tipado estructural a propósito: encaja tanto con el `FlatNode` que devuelve
 *  `parseCurriculumFile` como con una fila de `curriculum_nodes`, que es lo que
 *  permite que la misma regla corra con y sin base de datos. */
export type LessonRef = { id: string; slug: string; kind: string };

/** Fila lista para insertar en `broadcasts`. */
export type BroadcastRecord = ParsedBroadcast & { lessonNodeId: string };

/**
 * Lo que devuelve el parseo. El `curriculum` va SUELTO y no sólo repetido en
 * cada emisión porque un archivo sin ninguna temporada es válido (goal 6): el
 * cargador de un curso adoptante sin directos necesita igualmente saber a qué
 * currículo acotar su fase de borrado, y de una lista vacía no se deduce.
 */
export type SeasonsFile = {
  curriculum: string;
  broadcasts: ParsedBroadcast[];
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Sólo la forma. Que el día exista de verdad lo decide el constructor de
 *  `Date`, que devuelve NaN para `2026-02-31` igual que para `2026-13-45`. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const OFFSET_PATTERN = /^[+-]([01]\d|2[0-3]):[0-5]\d$/;

function fail(message: string): never {
  throw new SeasonsFileError(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Etiqueta legible de una emisión CRUDA, para los mensajes de error: la regla
 *  que falla se nombra siempre junto a la emisión que la incumple, y eso tiene
 *  que funcionar también cuando el campo que falta es parte de la etiqueta. */
function label(season: string, raw: Record<string, unknown>): string {
  const slug = typeof raw.lessonSlug === "string" ? raw.lessonSlug : "(sin lessonSlug)";
  const date = typeof raw.date === "string" ? raw.date : "(sin date)";
  const id = typeof raw.id === "string" ? raw.id : "(sin id)";
  return `emisión "${slug}" de la temporada "${season}" (${date}, id ${id})`;
}

/** La misma etiqueta, ya sobre una emisión parseada. */
function labelOf(broadcast: ParsedBroadcast): string {
  return `emisión "${broadcast.lessonSlug}" de la temporada "${broadcast.season}" (id ${broadcast.id})`;
}

/**
 * Aplana el archivo a emisiones y valida el contrato entero. Lanza
 * `SeasonsFileError` en el primer incumplimiento, nombrando la emisión y la
 * regla. No escribe nada ni consulta nada.
 *
 * Lo que NO comprueba: que el `lessonSlug` resuelva a una lección real. Eso es
 * `resolveBroadcasts`, y va aparte porque necesita el currículo.
 *
 * Un archivo con `"seasons": []` es válido a propósito (goal 6): es el curso
 * adoptante sin clases en directo.
 */
export function parseSeasonsFile(raw: unknown): SeasonsFile {
  if (!isPlainObject(raw)) fail("el archivo no es un objeto JSON");

  const curriculum = raw.curriculum;
  if (typeof curriculum !== "string" || !SLUG_PATTERN.test(curriculum)) {
    fail(`campo "curriculum" ausente o fuera del patrón ${SLUG_PATTERN}`);
  }
  if (!Array.isArray(raw.seasons)) fail('campo "seasons" ausente o no es un array');

  const out: ParsedBroadcast[] = [];
  const seenIds = new Set<string>();
  // La clave única de §6.1 menos el currículo, que es uno solo por archivo. La
  // FECHA entra a propósito: dos emisiones de la misma lección en la misma
  // temporada en fechas DISTINTAS son legales (una recuperación, una cohorte
  // partida). Lo que esto caza es la misma emisión duplicada por copia y pega.
  const seenKeys = new Set<string>();

  raw.seasons.forEach((rawSeason, seasonIndex) => {
    if (!isPlainObject(rawSeason)) fail(`la temporada #${seasonIndex} no es un objeto`);

    const season = rawSeason.season;
    if (typeof season !== "string" || !SLUG_PATTERN.test(season)) {
      fail(
        `temporada #${seasonIndex}: "season" ausente o fuera del patrón ${SLUG_PATTERN} ` +
          `— participa en la clave única y en el agrupado de la tabla, así que no puede ser texto libre`
      );
    }

    // La hora y el desfase se declaran POR TEMPORADA, no por emisión (§6.4):
    // es lo que son hoy —todas a las 20:00 Colombia— y repetirlos por fila
    // invita a que uno discrepe por un error de copia.
    const startsAtLocal = rawSeason.startsAtLocal;
    if (typeof startsAtLocal !== "string" || !TIME_PATTERN.test(startsAtLocal)) {
      fail(`temporada "${season}": "startsAtLocal" ausente o no tiene la forma HH:MM`);
    }
    const utcOffset = rawSeason.utcOffset;
    if (typeof utcOffset !== "string" || !OFFSET_PATTERN.test(utcOffset)) {
      fail(`temporada "${season}": "utcOffset" ausente o no tiene la forma +HH:MM o -HH:MM`);
    }

    const list = rawSeason.broadcasts;
    if (!Array.isArray(list)) {
      fail(`temporada "${season}": "broadcasts" ausente o no es un array`);
    }

    list.forEach((rawBroadcast, position) => {
      if (!isPlainObject(rawBroadcast)) {
        fail(`temporada "${season}": la emisión #${position} no es un objeto`);
      }
      const where = label(season, rawBroadcast);

      const id = rawBroadcast.id;
      if (typeof id !== "string" || !UUID_PATTERN.test(id)) {
        fail(`${where}: "id" ausente o no es un UUID`);
      }
      if (seenIds.has(id)) fail(`${where}: "id" duplicado en el archivo`);
      seenIds.add(id);

      const lessonSlug = rawBroadcast.lessonSlug;
      if (typeof lessonSlug !== "string" || !SLUG_PATTERN.test(lessonSlug)) {
        fail(`${where}: "lessonSlug" ausente o fuera del patrón ${SLUG_PATTERN}`);
      }

      const date = rawBroadcast.date;
      if (typeof date !== "string" || !DATE_PATTERN.test(date)) {
        fail(`${where}: "date" ausente o no tiene la forma YYYY-MM-DD`);
      }

      // EL DESFASE SE APLICA AQUÍ, al cargar (§6.2). Antes la hora y el desfase
      // estaban quemados en `sessionStart()`; ahora lo que se guarda es un
      // instante ABSOLUTO y la hora de Colombia vuelve a ser una propiedad del
      // render. Guardarla además como columna sería guardar dos veces el mismo
      // hecho.
      //
      // Se compone de los COMPONENTES y no parseando la cadena ISO: V8 acepta
      // `2026-02-31T20:00:00-05:00` y lo desborda en silencio al 3 de marzo,
      // que es exactamente el "fuera de rango" que §4.2 manda rechazar — una
      // clase emitida tres días después de lo que dice el archivo, sin que
      // nada se ponga rojo. La comprobación de ida y vuelta lo caza.
      const [year, month, day] = date.split("-").map(Number);
      const [hours, minutes] = startsAtLocal.split(":").map(Number);
      const offsetMinutes =
        (utcOffset.startsWith("-") ? -1 : 1) *
        (Number(utcOffset.slice(1, 3)) * 60 + Number(utcOffset.slice(4, 6)));

      const probe = new Date(Date.UTC(year, month - 1, day));
      if (
        probe.getUTCFullYear() !== year ||
        probe.getUTCMonth() !== month - 1 ||
        probe.getUTCDate() !== day
      ) {
        fail(`${where}: la fecha "${date}" no existe en el calendario`);
      }

      const startsAt = new Date(
        Date.UTC(year, month - 1, day, hours, minutes) - offsetMinutes * 60_000
      );
      // Residual: con los componentes ya validados no debería poder darse, y
      // por eso mismo se deja — si alguien relaja `DATE_PATTERN`, esto avisa.
      if (Number.isNaN(startsAt.getTime())) {
        fail(
          `${where}: la fecha "${date}" con hora "${startsAtLocal}" y desfase "${utcOffset}" ` +
            `no es un instante válido`
        );
      }

      let vodUrl: string | null = null;
      const rawVod = rawBroadcast.vodUrl;
      if (rawVod !== undefined && rawVod !== null) {
        if (typeof rawVod !== "string" || rawVod.length === 0) {
          fail(`${where}: "vodUrl" tiene que ser una cadena no vacía`);
        }
        // LA MISMA implementación que el currículo, no una copia (§6.4). Es un
        // enlace saliente en la landing pública bajo la marca de la escuela, y
        // el control de HOST tiene exactamente una implementación.
        checkUrlSafety(where, "vodUrl", rawVod, fail);
        // Y el esquema, explícito: `checkUrlSafety` sólo mira lo que PARECE una
        // URL, así que un `"youtube.com/watch?v=x"` la atraviesa entera y
        // moriría abajo, en el CHECK de la columna, con un error de Postgres en
        // vez de uno que nombre la emisión. Esta línea es el mismo `LIKE
        // 'https://%'` de §6.1 dicho en la puerta del PR.
        if (!rawVod.startsWith("https://")) {
          fail(`${where}: "vodUrl" vale "${rawVod}" y tiene que empezar por "https://"`);
        }
        vodUrl = rawVod;
      }

      // `|` no cabe en `SLUG_PATTERN`, así que no hay colisión entre claves.
      const key = [season, lessonSlug, startsAt.getTime()].join("|");
      if (seenKeys.has(key)) {
        fail(
          `${where}: ya hay otra emisión de "${lessonSlug}" en la temporada "${season}" ` +
            `en ese mismo instante (§6.1). Dos fechas distintas sí son legales.`
        );
      }
      seenKeys.add(key);

      out.push({ id, curriculum, season, lessonSlug, startsAt, vodUrl });
    });
  });

  return { curriculum, broadcasts: out };
}

/**
 * Resuelve `lessonSlug → id de nodo` y RECHAZA EL ARCHIVO ENTERO si alguno no
 * existe o no es `kind: "lesson"` (goal 4).
 *
 * Es la garantía que daba el tipo `LessonId` antes de PRD-002, y es más fuerte,
 * porque además cubre el `kind`: una etapa no se emite. También es la única
 * comprobación de integridad que hay, porque `lesson_node_id` NO lleva clave
 * foránea a propósito (§6.3) — la integridad se comprueba en la escritura para
 * que retirar una lección del temario no pueda destruir el registro de una
 * clase que sí ocurrió.
 *
 * `lessons` tiene que venir ya acotada al currículo del archivo; aquí no se
 * comprueba, porque los dos llamantes la obtienen ya acotada (el cargador por
 * `where curriculum = …`, la puerta del PR porque el archivo de currículo
 * declara uno solo).
 */
export function resolveBroadcasts(
  broadcasts: ParsedBroadcast[],
  lessons: LessonRef[]
): BroadcastRecord[] {
  const bySlug = new Map(lessons.map((lesson) => [lesson.slug, lesson]));

  // `.map` y no un bucle que vaya acumulando: el primer incumplimiento lanza y
  // el llamante no recibe NINGUNA fila. "Rechaza el archivo entero" es literal.
  return broadcasts.map((broadcast) => {
    const where = labelOf(broadcast);
    const node = bySlug.get(broadcast.lessonSlug);
    if (!node) {
      fail(
        `${where}: la lección "${broadcast.lessonSlug}" no existe en el currículo ` +
          `"${broadcast.curriculum}"`
      );
    }
    if (node.kind !== "lesson") {
      fail(
        `${where}: "${broadcast.lessonSlug}" es un nodo de tipo "${node.kind}" y sólo se ` +
          `emiten nodos "lesson"`
      );
    }
    return { ...broadcast, lessonNodeId: node.id };
  });
}
