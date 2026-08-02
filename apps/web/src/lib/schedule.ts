// El calendario de la home, ya sin fechas dentro. Regla de la home: ninguna
// fecha escrita a mano en el JSX; todo lo que diga "próxima clase" sale de aquí
// (ver `60 Negocio/Nueva home de academia.md`). Sin ninguna emisión futura la
// home entra sola en estado de pausa (nextSession() devuelve null): nunca miente.
//
// Desde PRD-008 las emisiones son DATO: viven en la tabla `broadcasts`, las lee
// `@shared/broadcasts` y llegan aquí como argumento. Este módulo se quedó con lo
// que es puro —el formato de fecha, la agenda y los cuatro textos de la home— y
// por eso se sigue ejercitando bajo Node pelado, sin base de datos.
//
// Con eso muere el aviso que este archivo llevaba desde PRD-002: `lessonSlug`
// era un `string` que nada validaba contra el temario. Ahora lo valida el
// cargador, que resuelve el slug a un nodo `kind: "lesson"` real y rechaza el
// archivo entero si no existe (PRD-008 §6.3). Es CON-7, cerrado.
//
// Regla de código: identificadores en inglés, comentarios en español.

/**
 * Lo mínimo que este módulo necesita saber de una emisión. Tipado estructural a
 * propósito, igual que `LessonLike` más abajo: `schedule.ts` no importa la capa
 * de base de datos, y eso es justo lo que permite ejercitarlo bajo Node pelado.
 * Encaja con el `Broadcast` que devuelve `@shared/broadcasts`.
 *
 * Se llama `Broadcast` y no `Session` (PRD-008 D7): `session` ya es la tabla que
 * el adapter de Auth.js fija por nombre, y dos cosas distintas llamadas igual a
 * dos módulos de distancia es confusión gratuita.
 */
export type Broadcast = {
  id: string;
  season: string;
  /** `""` si el nodo de la lección ya no existe: el join de `@shared/broadcasts`
   *  es a la izquierda a propósito, porque una clase emitida es un hecho
   *  histórico y una edición del temario no puede borrarla (PRD-008 §6.3). */
  lessonSlug: string;
  /** Instante ABSOLUTO. La hora de Colombia es del render, no del dato (§6.2). */
  startsAt: Date;
  vodUrl: string | null;
};

const CLASS_DURATION_MS = 2 * 60 * 60 * 1000;

/**
 * El inicio de una emisión.
 *
 * Este cuerpo era `new Date(`${session.date}T20:00:00-05:00`)`: la hora y el
 * desfase quemados en el código. PRD-008 §6.2 mueve esa composición al cargador
 * y guarda un `timestamptz`, así que aquí sólo queda el accesor.
 *
 * Se conserva como función en vez de sustituirlo por `broadcast.startsAt` en
 * cada llamante porque `formatSessionDate` delega en él —y por eso su cuerpo no
 * cambió ni un carácter—, y éste es exactamente el punto donde alguien podría
 * volver a componer un instante a mano desde una fecha que ya no existe.
 */
export function sessionStart(broadcast: Broadcast): Date {
  return broadcast.startsAt;
}

/** Una emisión deja de ser "la próxima" cuando termina, no cuando empieza. */
export function isPast(broadcast: Broadcast, now = new Date()): boolean {
  return now.getTime() > sessionStart(broadcast).getTime() + CLASS_DURATION_MS;
}

/**
 * Copia ordenada por instante. `@shared/broadcasts` ya entrega en este orden
 * —es el del índice `broadcasts_curriculum_starts_idx`— pero ordenar igualmente
 * es lo que impide que estas funciones puras dependan de una promesa del
 * llamante: los fixtures de `check-schedule.ts` las ejercitan desordenadas.
 */
function byStart(broadcasts: Broadcast[]): Broadcast[] {
  return [...broadcasts].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

/**
 * La próxima emisión por emitir, o `null` si no hay ninguna futura (pausa).
 *
 * La más próxima EN EL TIEMPO, no la primera del array: con dos temporadas
 * cargadas el orden de llegada no tiene por qué ser el del calendario.
 */
export function nextSession(broadcasts: Broadcast[], now = new Date()): Broadcast | null {
  return byStart(broadcasts).find((b) => !isPast(b, now)) ?? null;
}

// Formato manual y determinista: no depende de los locales ICU del runtime.
const WEEKDAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/** El instante, corrido a hora de pared de Colombia (UTC-5, sin DST). Privada:
 *  lo que sale de aquí NO es un instante, es una pared de reloj y sólo vale
 *  para leerle los componentes con los getters `getUTC*`. */
function colombiaWallClock(broadcast: Broadcast): Date {
  return new Date(sessionStart(broadcast).getTime() - 5 * 60 * 60 * 1000);
}

/** "martes 28 jul" — siempre en hora de Colombia (UTC-5, sin DST). */
export function formatSessionDate(broadcast: Broadcast): string {
  const colombia = colombiaWallClock(broadcast);
  return `${WEEKDAYS[colombia.getUTCDay()]} ${colombia.getUTCDate()} ${MONTHS[colombia.getUTCMonth()]}`;
}

/**
 * "20:00" — la hora de la emisión, en hora de Colombia.
 *
 * EXISTE PORQUE ESE "20:00" ESTABA ESCRITO A MANO EN TRES SITIOS y ninguno
 * derivaba de la emisión. Hoy coinciden por casualidad: la única temporada
 * cargada empieza a las 20:00. Pero `startsAtLocal` es dato **por temporada**
 * (PRD-008 §6.4) precisamente para que una futura pueda ser distinta, y ese día
 * la fecha seguiría siendo correcta —`formatSessionDate` la calcula del
 * instante— y la HORA mentiría, sin que nada se pusiera rojo. Es la misma clase
 * de fallo que §4.4 arregló para el número de clases, con el reloj en vez del
 * conteo.
 *
 * El dato ya se estaba calculando: sólo faltaba exponerlo.
 */
export function formatSessionTime(broadcast: Broadcast): string {
  const colombia = colombiaWallClock(broadcast);
  const hh = String(colombia.getUTCHours()).padStart(2, "0");
  const mm = String(colombia.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

// ---------------------------------------------------------------------------
// Los cuatro textos de la home que dependen de la próxima clase
// ---------------------------------------------------------------------------
//
// Viven aquí y no en el JSX, y no es preferencia de estilo (PRD-008 §7.1). La
// fila 20 de §9 tiene que afirmar sobre ellos, y el golden del repositorio NO
// renderiza React: construye datos y compara. Un golden que copiase las
// plantillas a mano compararía su propia copia contra sí misma — alguien cambia
// el copy en `page.tsx`, olvida el golden, y nada se pone rojo. Los llaman los
// dos.
//
// Son dos funciones y no cuatro porque la RAMA también es copy: elegir entre
// "hay próxima clase" y "pausa" es parte de lo que hay que proteger, y dejando
// la elección fuera el golden volvería a copiar la mitad del trabajo.

/** El renglón bajo el CTA del hero y bajo el cierre (`page.tsx`, dos usos). */
export function agendaLine(next: Broadcast | null): string {
  return next
    ? `Próxima clase — ${formatSessionDate(next)} · ${formatSessionTime(next)} Colombia · en Twitch`
    : "Pausa entre temporadas — las grabaciones siguen abiertas, gratis";
}

/** El titular de S10. Sólo el día de la semana: la fecha completa ya está en el
 *  renglón de agenda que va justo debajo. */
export function closingHeading(next: Broadcast | null): string {
  return next
    ? `La próxima clase es este ${formatSessionDate(next).split(" ")[0]}. Puedes estar dentro.`
    : "Las grabaciones te esperan. Puedes estar dentro.";
}

/** Lo mínimo que este módulo necesita saber de una lección. Tipado estructural
 *  a propósito: `schedule.ts` no importa la capa de currículo. */
type LessonLike = { slug: string; title: string; payload: Record<string, unknown> };

export type SeasonRow = {
  broadcast: Broadcast;
  /** Vacíos si la lección no está cargada — la fila degrada, no revienta. */
  title: string;
  outcome: string;
  emitted: boolean;
  isNext: boolean;
};

/** Un grupo por temporada, en el orden en que empezaron. Con UNA temporada
 *  cargada el agrupado no debe verse: eso es cosa del JSX, que sólo pinta
 *  encabezado cuando hay más de un grupo (PRD-008 §4.4). */
export type SeasonGroup = {
  season: string;
  rows: SeasonRow[];
};

/**
 * Empareja las emisiones con las lecciones cargadas y las agrupa por temporada.
 *
 * Dos artefactos que se despliegan por separado siguen encontrándose aquí, sólo
 * que ahora los dos son dato: `curriculum/<slug>.json` y
 * `curriculum/<slug>.seasons.json`, cada uno con su cargador. Una emisión cuyo
 * nodo ya no existe llega con `lessonSlug: ""` y degrada su fila; la home no se
 * cae. Ésa es la mitad de §6.3 que el join a la izquierda de
 * `@shared/broadcasts` conserva y que un `slugsByNodeId` al uso rompería.
 *
 * El orden sale de una sola pasada: se ordena por instante y el `Map` conserva
 * el orden de primera aparición, así que los grupos salen ordenados por su
 * primera emisión y las filas de cada uno por fecha.
 */
export function seasonAgenda(
  broadcasts: Broadcast[],
  lessons: LessonLike[],
  now = new Date()
): SeasonGroup[] {
  const bySlug = new Map(lessons.map((l) => [l.slug, l]));
  const next = nextSession(broadcasts, now);
  const groups = new Map<string, SeasonRow[]>();

  for (const broadcast of byStart(broadcasts)) {
    const lesson = bySlug.get(broadcast.lessonSlug);
    const row: SeasonRow = {
      broadcast,
      title: lesson?.title ?? "",
      outcome: typeof lesson?.payload.outcome === "string" ? lesson.payload.outcome : "",
      emitted: isPast(broadcast, now),
      // POR `id`, NUNCA POR SLUG (§4.3). Comparar slugs era cierto mientras sólo
      // hubiera una temporada; con la misma lección emitida en dos, marca como
      // "próxima" la fila de la temporada equivocada.
      isNext: next?.id === broadcast.id,
    };
    const rows = groups.get(broadcast.season);
    if (rows) rows.push(row);
    else groups.set(broadcast.season, [row]);
  }

  return [...groups].map(([season, rows]) => ({ season, rows }));
}
