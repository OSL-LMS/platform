// Parseo y validación del archivo de currículo. SIN dependencias de base de
// datos: es lo que permite que la puerta de revisión de un PR corra las reglas
// enteras sobre el archivo, sin Postgres. Ver PRD-002 §5.1.
//
// Importa con ruta relativa y extensión (no con el alias `@/lib/…`): Node no
// conoce los `paths` de tsconfig y este módulo se importa desde `scripts/`.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { buildLessonContext } from "./curriculum-context.ts";

export type CurriculumNodeInput = {
  /** UUID estable, autoría del archivo. ES la identidad del nodo. */
  id: string;
  /** Etiqueta legible y mutable. Único por currículo, pero NO es la identidad. */
  slug: string;
  kind: string;
  title: string;
  children?: CurriculumNodeInput[];
  payload?: Record<string, unknown>;
};

export type CurriculumFile = {
  curriculum: string;
  nodes: CurriculumNodeInput[];
};

/** Fila lista para insertar. `parentId` sale del anidamiento. */
export type FlatNode = {
  id: string;
  curriculum: string;
  slug: string;
  parentId: string | null;
  kind: string;
  title: string;
  position: number;
  payload: Record<string, unknown>;
  /** 0 = raíz; el cargador inserta en orden ascendente. */
  depth: number;
};

/** El nodo tal como lo consume la aplicación: con sus hijos ya colgados. */
export type CurriculumNode = {
  id: string;
  slug: string;
  kind: string;
  title: string;
  payload: Record<string, unknown>;
  children: CurriculumNode[];
};

export class CurriculumFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CurriculumFileError";
  }
}

// ---------------------------------------------------------------------------
// Contrato de contenido — lo que el esquema no puede dar y hoy daba el compilador
// ---------------------------------------------------------------------------

type PayloadRule = {
  type: "string" | "number" | "boolean";
  required: boolean;
  /**
   * El valor acaba en la entrada de un modelo: arrastra la cota de 4 000
   * caracteres, el filtro de patrones imperativos y el control de URLs.
   *
   * No es lo mismo que "lo lee la home". `stuck`, `outcome`, `audience` y
   * `title` viajan al segundo bloque de system del tutor. `scope` no: viaja en
   * el archivo publicado (§5.4), cuyo consumidor real es el generador de
   * exámenes, que se lo da a un juez. Distinto camino, mismo destino, mismos
   * guardas — y es lo que `CONTRIBUTING.md` promete al enumerarlo entre las
   * llaves que exigen el escrutinio del prompt certificado.
   */
  modelBound?: boolean;
};

/**
 * El esquema no conoce las llaves del `payload` ni los valores de `kind`; la
 * aplicación sí. La adoptabilidad real es *trae tu contenido*, no *trae tu
 * vocabulario*. Un `kind` que no esté aquí es legal y no exige ninguna llave.
 */
export const PAYLOAD_VOCABULARY: Record<string, Record<string, PayloadRule>> = {
  stage: {
    built: { type: "string", required: true },
    aiRole: { type: "string", required: true },
    hours: { type: "number", required: true },
    milestone: { type: "string", required: true },
    status: { type: "string", required: true },
    statusLabel: { type: "string", required: true },
    hasDetail: { type: "boolean", required: true },
    scope: { type: "string", required: false, modelBound: true },
  },
  module: {
    audience: { type: "string", required: false, modelBound: true },
  },
  lesson: {
    outcome: { type: "string", required: true, modelBound: true },
    stuck: { type: "string", required: true, modelBound: true },
  },
};

/** Cota por valor. El segundo bloque de system NO lleva `cache_control`: un
 *  valor gigante se factura como entrada no cacheada en cada petición. */
export const MAX_SYSTEM_VALUE_CHARS = 4_000;

/** Cota del bloque compuesto, por lección. La cota por valor no acota la
 *  agregación: el índice `Lecciones del módulo:` crece con cada lección. */
export const MAX_SYSTEM_BLOCK_CHARS = 24_000;

/** Cota de nodos por currículo. `/registro` es pública y renderiza la lista
 *  entera; el guardarraíl del cargador cuenta bajas, nunca altas. */
export const MAX_NODES = 500;

/** Patrones imperativos hacia el modelo. Misma forma que ya tenía el filtro de
 *  `scripts/check-lessons.ts`, aplicada al contenido en vez de al slug. */
const IMPERATIVE_PATTERNS =
  /\b(ignora|ignore|olvida|forget|instrucciones anteriores|previous instructions|system)\b/i;

export const SLUG_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Cualquier esquema, más el relativo-a-protocolo `//host`, que el navegador
 *  trata como cross-origin. Acotar a "distinto de https:" dejaba pasar `//`.
 *
 *  DESVIACIÓN de la letra de PRD-002 §5.1: la regla escrita allí (`esquema` +
 *  `:` sin más) marca como URL el título real de L5, "Git: tu trabajo, a salvo
 *  y con historia" — y renombrar una lección pública para contentar al
 *  validador contradice el objetivo de "no cambiar ni un píxel". Se exige que
 *  tras los dos puntos venga un carácter NO blanco, que es lo que separa una
 *  URL de una frase con dos puntos.
 *
 *  Esa exigencia SOLA sí relajaba el control, y por eso no va sola: el parser
 *  de URL de la WHATWG **elimina tab, LF y CR antes de parsear**, así que
 *  `"https:\tevil"` no casaba y el navegador navegaba igual. Se normaliza
 *  primero (`stripUrlNoise`) y se añade una lista cerrada de esquemas
 *  peligrosos que caen aunque lleven espacio detrás — `javascript: alert(1)`
 *  ejecuta en un `href` y ninguna prosa del temario empieza por `javascript:`. */
const URL_LIKE = /^\s*(?:[a-z][a-z0-9+.-]*:\S|\/\/)/i;

/** Los tres caracteres que el parser de URL descarta en silencio. */
const stripUrlNoise = (value: string) => value.replace(/[\t\n\r]/g, "");

/** Esquemas que se rechazan aunque no parezcan URL: lo que va detrás de los
 *  dos puntos es carga útil, no prosa. */
const DANGEROUS_SCHEME = /^\s*(?:javascript|data|vbscript|file|blob)\s*:/i;

/** El control de esquema no cubre el DESTINO: `https://evil.example.com` pasa
 *  cualquier control de esquema y sigue siendo un enlace saliente arbitrario
 *  bajo la marca de la escuela, en la landing pública. */
export const URL_HOST_ALLOWLIST = [
  "contextia.io",
  "www.contextia.io",
  "github.com",
  "www.github.com",
  "youtube.com",
  "www.youtube.com",
  "youtu.be",
  "twitch.tv",
  "www.twitch.tv",
  "discord.gg",
];

/** Una etapa, con el vocabulario de `stage` ya leído. Es lo que consume el mapa
 *  del programa de la home; vive aquí, puro, para que el golden de "cero cambio
 *  visible" pueda compararlo sin renderizar React ni consultar Postgres. */
export type StageView = {
  /** UUID: solo la `key` de React. NUNCA se renderiza como texto. */
  id: string;
  /** El número visible de la etapa ("E1"). Sale del `slug`, no del `id`. */
  num: string;
  name: string;
  built: string;
  aiRole: string;
  milestone: string;
  hours: number;
  status: string;
  statusLabel: string;
  /** `undefined` — no `[]` — cuando la etapa no tiene detalle todavía: en JS
   *  `[] && x` es *truthy*, así que un array vacío pintaría "0 módulos" en dos
   *  etapas que hoy no muestran nada. La distinción vive en `hasDetail`, no en
   *  la ausencia de hijos. */
  modules?: string[];
};

export function toStageViews(forest: CurriculumNode[]): StageView[] {
  return forest
    .filter((node) => node.kind === "stage")
    .map((stage) => ({
      id: stage.id,
      num: stage.slug,
      name: stage.title,
      built: String(stage.payload.built ?? ""),
      aiRole: String(stage.payload.aiRole ?? ""),
      milestone: String(stage.payload.milestone ?? ""),
      hours: Number(stage.payload.hours ?? 0),
      status: String(stage.payload.status ?? ""),
      statusLabel: String(stage.payload.statusLabel ?? ""),
      modules: stage.payload.hasDetail
        ? stage.children.filter((c) => c.kind === "module").map((c) => c.title)
        : undefined,
    }));
}

// ---------------------------------------------------------------------------
// Parseo
// ---------------------------------------------------------------------------

function fail(message: string): never {
  throw new CurriculumFileError(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Etiqueta legible del nodo para los mensajes de error: la regla que falla se
 *  nombra siempre junto al nodo que la incumple. */
function label(node: { slug?: unknown; id?: unknown }): string {
  const slug = typeof node.slug === "string" ? node.slug : "(sin slug)";
  const id = typeof node.id === "string" ? node.id : "(sin id)";
  return `nodo "${slug}" (id ${id})`;
}

/**
 * Aplana el archivo a filas listas para insertar y valida el contrato entero.
 * Lanza `CurriculumFileError` en el primer incumplimiento, nombrando el nodo y
 * la regla. No escribe nada ni consulta nada.
 */
export function parseCurriculumFile(raw: unknown): FlatNode[] {
  if (!isPlainObject(raw)) fail("el archivo no es un objeto JSON");
  const curriculum = raw.curriculum;
  if (typeof curriculum !== "string" || !SLUG_PATTERN.test(curriculum)) {
    fail(`campo "curriculum" ausente o fuera del patrón ${SLUG_PATTERN}`);
  }
  if (!Array.isArray(raw.nodes)) fail('campo "nodes" ausente o no es un array');

  const flat: FlatNode[] = [];
  const seenIds = new Set<string>();
  const seenSlugs = new Set<string>();

  const walk = (
    children: unknown[],
    parentId: string | null,
    depth: number
  ): void => {
    children.forEach((rawNode, position) => {
      if (!isPlainObject(rawNode)) {
        fail(`hijo #${position} de ${parentId ?? "(raíz)"} no es un objeto`);
      }

      // --- identidad ---
      const id = rawNode.id;
      if (typeof id !== "string" || !UUID_PATTERN.test(id)) {
        fail(`${label(rawNode)}: "id" ausente o no es un UUID`);
      }
      if (seenIds.has(id)) fail(`${label(rawNode)}: "id" duplicado en el archivo`);
      seenIds.add(id);

      // --- etiqueta pública ---
      const slug = rawNode.slug;
      if (typeof slug !== "string" || !SLUG_PATTERN.test(slug)) {
        fail(`${label(rawNode)}: "slug" ausente o fuera del patrón ${SLUG_PATTERN}`);
      }
      if (seenSlugs.has(slug)) {
        fail(`${label(rawNode)}: "slug" duplicado dentro del currículo`);
      }
      seenSlugs.add(slug);

      // --- campos obligatorios ---
      const kind = rawNode.kind;
      if (typeof kind !== "string" || kind.length === 0) {
        fail(`${label(rawNode)}: "kind" ausente o vacío`);
      }
      const title = rawNode.title;
      if (typeof title !== "string" || title.length === 0) {
        fail(`${label(rawNode)}: "title" ausente o vacío`);
      }

      const payload = rawNode.payload ?? {};
      if (!isPlainObject(payload)) fail(`${label(rawNode)}: "payload" no es un objeto`);

      const kids = rawNode.children ?? [];
      if (!Array.isArray(kids)) fail(`${label(rawNode)}: "children" no es un array`);

      // `title` es columna, no payload, pero alcanza el bloque de system igual.
      checkModelBoundValue(rawNode, "title", title);
      checkPayload(rawNode, kind, payload);

      flat.push({
        id,
        curriculum,
        slug,
        parentId,
        kind,
        title,
        position,
        payload,
        depth,
      });

      walk(kids, id, depth + 1);
    });
  };

  walk(raw.nodes, null, 0);

  if (flat.length > MAX_NODES) {
    fail(
      `el currículo "${curriculum}" declara ${flat.length} nodos y la cota es ${MAX_NODES}`
    );
  }

  // Cota del bloque compuesto: se mide LLAMANDO a la función real sobre el
  // bosque, no aproximando por suma de longitudes. Si el validador aproxima, lo
  // validado y lo que se factura divergen.
  checkComposedBlocks(flat);

  // Orden ascendente de profundidad: el padre existe cuando llega el hijo.
  return flat.sort((a, b) => a.depth - b.depth);
}

function checkPayload(
  rawNode: Record<string, unknown>,
  kind: string,
  payload: Record<string, unknown>
): void {
  const vocabulary = PAYLOAD_VOCABULARY[kind] ?? {};

  for (const [key, rule] of Object.entries(vocabulary)) {
    const value = payload[key];
    if (value === undefined || value === null) {
      if (rule.required) {
        fail(`${label(rawNode)}: falta la llave obligatoria "payload.${key}"`);
      }
      continue;
    }
    if (typeof value !== rule.type) {
      fail(
        `${label(rawNode)}: "payload.${key}" debe ser ${rule.type} y es ${typeof value}`
      );
    }
    if (rule.type === "string" && (value as string).length === 0) {
      fail(`${label(rawNode)}: "payload.${key}" está vacía`);
    }
    if (rule.modelBound) {
      checkModelBoundValue(rawNode, `payload.${key}`, value as string);
    }
  }

  // Las reglas de URL aplican a TODO valor del payload, declarado o no, y a
  // cualquier profundidad: `payload` es libre de llaves por diseño, así que un
  // `{"link": {"href": "…"}}` o un `{"links": ["…"]}` son representables y se
  // renderizarían igual. Mirar solo el primer nivel dejaba esa superficie
  // abierta por construcción.
  walkStrings(payload, "payload", (field, value) =>
    checkUrlSafety(rawNode, field, value)
  );
}

/** Recorre todos los strings de una estructura JSON, con su ruta. */
function walkStrings(
  value: unknown,
  path: string,
  visit: (field: string, value: string) => void
): void {
  if (typeof value === "string") return visit(path, value);
  if (Array.isArray(value)) {
    value.forEach((item, i) => walkStrings(item, `${path}[${i}]`, visit));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      walkStrings(child, `${path}.${key}`, visit);
    }
  }
}

/** Cota y filtro de todo lo que acaba en la entrada de un modelo. */
function checkModelBoundValue(
  rawNode: Record<string, unknown>,
  field: string,
  value: string
): void {
  if (value.length > MAX_SYSTEM_VALUE_CHARS) {
    fail(
      `${label(rawNode)}: "${field}" tiene ${value.length} caracteres y la cota del bloque de system es ${MAX_SYSTEM_VALUE_CHARS}`
    );
  }
  const imperative = value.match(IMPERATIVE_PATTERNS);
  if (imperative) {
    fail(
      `${label(rawNode)}: "${field}" contiene el patrón imperativo "${imperative[0]}" y ese valor viaja al bloque de system`
    );
  }
  checkUrlSafety(rawNode, field, value);
}

function checkUrlSafety(
  rawNode: Record<string, unknown>,
  field: string,
  value: string
): void {
  // Se normaliza ANTES de decidir: si se mira el valor crudo, un tabulador
  // dentro del esquema salta esta puerta entera — y esta puerta es la única,
  // así que ni el control de esquema ni la allowlist de host llegarían a correr.
  const normalized = stripUrlNoise(value);
  if (!URL_LIKE.test(normalized) && !DANGEROUS_SCHEME.test(normalized)) return;

  const trimmed = normalized.trim();
  // `//host/x` es relativo a protocolo: el navegador lo trata como cross-origin.
  const candidate = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    fail(`${label(rawNode)}: "${field}" parece una URL y no se puede parsear`);
  }

  if (url.protocol !== "https:") {
    fail(
      `${label(rawNode)}: "${field}" usa el esquema "${url.protocol}" y solo se admite https:`
    );
  }
  if (!URL_HOST_ALLOWLIST.includes(url.hostname)) {
    fail(
      `${label(rawNode)}: "${field}" apunta a "${url.hostname}", que no está en la allowlist de hosts`
    );
  }
}

/** Para toda lección del archivo, el bloque que recibiría el tutor cabe en la
 *  cota. Se mide sobre el bosque real y con la función real. */
function checkComposedBlocks(flat: FlatNode[]): void {
  const forest = buildForest(flat);
  for (const node of flat) {
    if (node.kind !== "lesson") continue;
    const { moduleLessons, ancestors } = lessonContextInputs(forest, node.slug);
    const block = buildLessonContext(moduleLessons, ancestors, node.slug);
    if (block.length > MAX_SYSTEM_BLOCK_CHARS) {
      fail(
        `nodo "${node.slug}": el bloque de system compuesto mide ${block.length} caracteres y la cota es ${MAX_SYSTEM_BLOCK_CHARS}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Ensamblado del bosque y recorridos — puros, compartidos con `curriculum.ts`
// ---------------------------------------------------------------------------

/**
 * Arma el bosque a partir de filas planas, **por `parentId`** — no por `depth`,
 * que las filas de Postgres no traen porque la profundidad no está en el
 * esquema. `curriculum.ts` reutiliza esto sobre lo que trae la base, de modo
 * que el ensamblado existe una sola vez en el repositorio.
 */
export function buildForest(nodes: Omit<FlatNode, "depth">[]): CurriculumNode[] {
  const byId = new Map<string, CurriculumNode>();
  for (const row of nodes) {
    byId.set(row.id, {
      id: row.id,
      slug: row.slug,
      kind: row.kind,
      title: row.title,
      payload: row.payload,
      children: [],
    });
  }

  // El orden entre hermanos es `position`; lo fijamos una vez sobre la entrada
  // para no reordenar cada lista de hijos después.
  const ordered = [...nodes].sort((a, b) => a.position - b.position);

  const roots: CurriculumNode[] = [];
  for (const row of ordered) {
    const node = byId.get(row.id)!;
    // Un `parentId` que no está en el conjunto (subárbol parcial) cuelga como
    // raíz en vez de desaparecer: perder nodos en silencio es peor.
    const parent = row.parentId ? byId.get(row.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** Recorrido en profundidad de todo el bosque, en orden de `position`. */
export function walkForest(forest: CurriculumNode[]): CurriculumNode[] {
  const out: CurriculumNode[] = [];
  const visit = (nodes: CurriculumNode[]) => {
    for (const node of nodes) {
      out.push(node);
      visit(node.children);
    }
  };
  visit(forest);
  return out;
}

/** Cadena de ancestros de un nodo, de la raíz hacia abajo. `[]` si no existe. */
export function ancestorsOf(
  forest: CurriculumNode[],
  slug: string
): CurriculumNode[] {
  const search = (
    nodes: CurriculumNode[],
    chain: CurriculumNode[]
  ): CurriculumNode[] | null => {
    for (const node of nodes) {
      if (node.slug === slug) return chain;
      const found = search(node.children, [...chain, node]);
      if (found) return found;
    }
    return null;
  };
  return search(forest, []) ?? [];
}

/** Lecciones bajo `rootSlug` a cualquier profundidad, en orden de recorrido en
 *  profundidad. Sin `rootSlug`, todas las del bosque. */
export function lessonsUnder(
  forest: CurriculumNode[],
  rootSlug?: string
): CurriculumNode[] {
  let scope = forest;
  if (rootSlug !== undefined) {
    const root = walkForest(forest).find((n) => n.slug === rootSlug);
    if (!root) return [];
    scope = root.children;
  }
  return walkForest(scope).filter((n) => n.kind === "lesson");
}

/**
 * Los dos argumentos que `buildLessonContext` necesita para una lección: las
 * lecciones de SU módulo (no las del currículo entero) y su cadena de
 * ancestros. Vive aquí, puro, para que el validador y `/api/chat` compongan el
 * bloque exactamente igual.
 */
export function lessonContextInputs(
  forest: CurriculumNode[],
  lessonSlug: string
): { moduleLessons: CurriculumNode[]; ancestors: CurriculumNode[] } {
  const ancestors = ancestorsOf(forest, lessonSlug);
  if (ancestors.length === 0) return { moduleLessons: [], ancestors: [] };
  const moduleNode = [...ancestors].reverse().find((a) => a.kind === "module");
  const scope = moduleNode ?? ancestors[ancestors.length - 1];
  return { moduleLessons: lessonsUnder(forest, scope.slug), ancestors };
}
