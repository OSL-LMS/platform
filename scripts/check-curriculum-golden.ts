// "Cero cambio visible": el golden capturado con `lessons.ts` y `program.ts`
// ANTES de migrar (PRD-002 §10 paso 1) frente a lo que produce el árbol.
// Se ejecuta con: node scripts/check-curriculum-golden.ts
//
// Va en su propio script y corre PRIMERO: `node:assert` lanza al primer fallo,
// y agruparlo con las unitarias haría que un fallo trivial impidiera correr la
// comprobación más cargada del PRD.
//
// Cubre las filas 1, 2 y 22 de PRD-002 §9, las filas 59 y 60 de PRD-007 §9, y
// la fila 20 de PRD-008 §9.
//
// ÉSTE es el único script de la raíz que importa `apps/web/src`, y el resto de
// los que lo hacen viven en `apps/web/scripts/` (ver el `//scripts` de
// package.json). La excepción es deliberada y está en PRD-008 §9 fila 20: lo
// que hay que comparar contra el golden son los textos de la home compuestos
// por las funciones REALES de `schedule.ts`, y el golden vive aquí. Se puede
// porque desde el paso D `schedule.ts` es puro: no importa nada.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  buildForest,
  lessonContextInputs,
  lessonsUnder,
  parseCurriculumFile,
  toStageViews,
} from "../packages/shared/src/curriculum-file.ts";
import { buildLessonContext } from "../packages/shared/src/curriculum-context.ts";
import {
  toEvidenceLessons,
  toLessonOptions,
} from "../packages/shared/src/curriculum.ts";
import { parseSeasonsFile } from "../packages/shared/src/broadcasts-file.ts";
import {
  agendaLine,
  closingHeading,
  formatSessionDate,
  nextSession,
  seasonAgenda,
} from "../apps/web/src/lib/schedule.ts";

const ROOT = resolve(import.meta.dirname, "..");

type Golden = {
  lessonContext: Record<string, string>;
  program: {
    id: string; name: string; built: string; aiRole: string; milestone: string;
    hours: number; status: string; statusLabel: string;
    modules: string[] | null; stageData: string; hasDetails: boolean;
  }[];
  lessonOptions: { slug: string; title: string }[];
  seasonHome: {
    now: string;
    pausedAt: string;
    season: string;
    agendaLine: { live: string; paused: string };
    closingHeading: { live: string; paused: string };
    rows: {
      lessonSlug: string; title: string; outcome: string;
      emitted: boolean; isNext: boolean; formattedDate: string; vodUrl: string | null;
    }[];
  };
};

const golden: Golden = JSON.parse(
  readFileSync(join(ROOT, "scripts/fixtures/curriculum-golden.json"), "utf8")
);

const forest = buildForest(
  parseCurriculumFile(JSON.parse(readFileSync(join(ROOT, "curriculum/contextia.json"), "utf8")))
);

// ---------------------------------------------------------------------------
// Fila 1 — equivalencia del contexto del tutor, lección a lección
// ---------------------------------------------------------------------------
for (const [slug, expected] of Object.entries(golden.lessonContext)) {
  if (slug === "") continue; // el caso sin lección no está en el alcance de §9 fila 1
  const { moduleLessons, ancestors } = lessonContextInputs(forest, slug);
  assert.equal(
    buildLessonContext(moduleLessons, ancestors, slug),
    expected,
    `el bloque del tutor cambió para ${slug}`
  );
}

// ---------------------------------------------------------------------------
// Fila 2 — equivalencia del MAPEO A PROPS del programa de la home
// ---------------------------------------------------------------------------
const stages = toStageViews(forest);
assert.equal(stages.length, golden.program.length);

stages.forEach((stage, i) => {
  const want = golden.program[i];
  assert.equal(stage.num, want.id, "el número visible de la etapa sale del slug");
  assert.equal(stage.name, want.name);
  assert.equal(stage.built, want.built);
  assert.equal(stage.aiRole, want.aiRole);
  assert.equal(stage.milestone, want.milestone);
  assert.equal(stage.hours, want.hours);
  assert.equal(stage.status, want.status);
  assert.equal(stage.statusLabel, want.statusLabel);
  assert.deepEqual(stage.modules ?? null, want.modules);

  // E3 y E4 no declaran módulos: la prop tiene que ser `undefined`, NO `[]` —
  // en JS `[] && x` es truthy y pintaría "0 módulos" donde hoy no hay nada.
  if (!want.hasDetails) {
    assert.equal(stage.modules, undefined, `${stage.num} debería llegar sin modules`);
  }

  // La cadena observable de la columna lateral, compuesta como en page.tsx.
  const stageData = `${stage.milestone} · ~${stage.hours} h${
    stage.modules ? ` · ${stage.modules.length} módulos` : ""
  }`;
  assert.equal(stageData, want.stageData);

  // `id` es un UUID y NUNCA se renderiza como texto: solo `key` de React.
  assert.match(stage.id, /^[0-9a-f-]{36}$/i);
  assert.notEqual(stage.id, stage.num);
});

// ---------------------------------------------------------------------------
// Fila 22 — los dos selectores: contenido, orden, forma y selección inicial
// ---------------------------------------------------------------------------
const options = lessonsUnder(forest).map((l) => ({ slug: l.slug, title: l.title }));
assert.deepEqual(options, golden.lessonOptions, "la lista de los selectores cambió");

// No viaja `payload` al cliente. PRD-007 fila 59: esta aserción es lo que
// protege `/registro`, que es pública y sin login, y se queda TAL CUAL.
for (const option of options) {
  assert.deepEqual(Object.keys(option).sort(), ["slug", "title"]);
}

// La misma exigencia sobre la FUNCIÓN REAL. La de arriba mide un objeto armado
// a mano en este script, así que por sí sola no vería un `toLessonOptions`
// ensanchado — que es exactamente lo que la fila 59 dice vigilar. PRD-007 §6.6
// añadió `toEvidenceLessons` en vez de ensanchar ésta, precisamente porque
// `registro/page.tsx` la llama sin sesión: `evidencePrompt` no puede viajar ahí.
for (const option of toLessonOptions(lessonsUnder(forest))) {
  assert.deepEqual(
    Object.keys(option).sort(),
    ["slug", "title"],
    "toLessonOptions se ensanchó — /registro es pública y sin login"
  );
}

// La selección inicial es `lessons[0]?.slug`, no el literal "L1" que estaba
// escrito a mano en los dos componentes.
for (const file of [
  "apps/web/src/app/chat-client.tsx",
  "apps/web/src/app/registro/registro-form.tsx",
]) {
  const text = readFileSync(join(ROOT, file), "utf8");
  assert.match(text, /lessons\[0\]\?\.slug/, `${file} no deriva la selección inicial del currículo`);
  assert.doesNotMatch(text, /useState\("L1"\)|defaultValue="L1"/, `${file} sigue con el literal "L1"`);
}

// ---------------------------------------------------------------------------
// PRD-007 fila 60 — `toEvidenceLessons` SÍ lleva las dos llaves
// ---------------------------------------------------------------------------
//
// Se llama a la función real y no se rearman las opciones a mano como hace la
// fila 22 de arriba: lo que hay que ver es que la proyección de `/chat` arrastra
// el payload de evidencia, y un objeto construido en este script lo arrastraría
// aunque la función no lo hiciera.
const evidenceLessons = toEvidenceLessons(lessonsUnder(forest));

assert.deepEqual(
  evidenceLessons.map((l) => l.slug),
  options.map((o) => o.slug),
  "toEvidenceLessons cambió el contenido o el orden respecto al selector"
);

for (const l of evidenceLessons) {
  assert.deepEqual(
    Object.keys(l).sort(),
    ["evidenceKind", "evidencePrompt", "slug", "title"],
    `${l.slug}: la forma de EvidenceLesson cambió`
  );
}

// Las siete lecciones del archivo real declaran evidencia desde PRD-007 §10
// paso C, y `evidenceKind` solo admite `"url"` (§6.4).
for (const l of evidenceLessons) {
  assert.equal(l.evidenceKind, "url", `${l.slug} perdió su evidenceKind`);
  assert.equal(typeof l.evidencePrompt, "string");
  assert.ok(l.evidencePrompt!.length > 0, `${l.slug} tiene el evidencePrompt vacío`);
}

// La otra mitad: donde el currículo NO las declara, `undefined` — no `null`, no
// cadena vacía. Es la rama "esta lección no pide evidencia", que es la que
// decide que no se pinte panel, y hoy no la cubre ninguna lección del archivo
// real. Un currículo adoptante que no declare la llave es el goal 6.
{
  const adoptante = buildForest(
    parseCurriculumFile({
      curriculum: "adoptante",
      nodes: [
        {
          id: "3f6a1c02-8d55-4b71-9e08-7c4a2b6d0f13",
          slug: "leccion-sin-evidencia",
          kind: "lesson",
          title: "Una lección que no pide evidencia",
          payload: { outcome: "sabes hacer algo", stuck: "el atasco típico" },
        },
      ],
    })
  );
  const [sinEvidencia] = toEvidenceLessons(lessonsUnder(adoptante));
  assert.equal(sinEvidencia.evidenceKind, undefined);
  assert.equal(sinEvidencia.evidencePrompt, undefined);
  assert.equal(sinEvidencia.slug, "leccion-sin-evidencia");
}

// ---------------------------------------------------------------------------
// PRD-008 fila 20 — con UNA temporada, los cuatro textos de la home no cambian
// ---------------------------------------------------------------------------
//
// NO ES UN TEST DE RENDER: este repositorio no tiene runner de componentes
// React. Es la técnica de la "Fila 2" de arriba —componer la cadena observable
// como lo hace `page.tsx`— llevada a su conclusión: en vez de copiar aquí las
// plantillas, se llaman las funciones REALES que `page.tsx` llama, porque un
// golden que copia plantillas compara su propia copia contra sí misma.
//
// El golden se capturó con el código anterior al paso D —`SEASON_SESSIONS` en
// `schedule.ts` y las cuatro plantillas en línea en `page.tsx`— sobre las siete
// emisiones de hoy, así que lo que afirma es "cero cambio visible".
//
// El `now` es fijo y sale del propio golden: `nextSession` depende del reloj, y
// un golden que se moviera con el calendario no compararía nada.
//
// Lo que esta fila NO puede probar es que el JSX cablee estos valores al DOM.
// Eso se verifica a mano — PRD-008 §10, punto 1 de la verificación.
//
// Está atado al archivo de temporadas REAL, y eso es a propósito: es la
// afirmación "cero cambio visible" de esta migración, no una prueba genérica del
// agrupado (ésa es la fila 18, con fixtures propios en
// apps/web/scripts/check-schedule.ts). El día que se cargue una segunda
// temporada, esta sección del golden se recaptura o se acota — y que salte es
// justo lo que avisa de que la home cambió de forma.
{
  const want = golden.seasonHome;
  const { broadcasts } = parseSeasonsFile(
    JSON.parse(readFileSync(join(ROOT, "curriculum/contextia.seasons.json"), "utf8"))
  );

  const next = nextSession(broadcasts, new Date(want.now));
  assert.ok(next, "el golden se capturó con una próxima clase; sin ella no compara nada");
  assert.equal(
    nextSession(broadcasts, new Date(want.pausedAt)),
    null,
    "la rama de pausa exige que no quede ninguna emisión futura"
  );

  assert.equal(agendaLine(next), want.agendaLine.live, "el renglón de agenda cambió");
  assert.equal(agendaLine(null), want.agendaLine.paused, "el renglón de agenda en pausa cambió");
  assert.equal(closingHeading(next), want.closingHeading.live, "el titular del cierre cambió");
  assert.equal(
    closingHeading(null),
    want.closingHeading.paused,
    "el titular del cierre en pausa cambió"
  );

  const groups = seasonAgenda(broadcasts, lessonsUnder(forest), new Date(want.now));
  assert.equal(
    groups.length,
    1,
    "con UNA temporada cargada el agrupado no debe verse. Si acabas de añadir una " +
      "segunda temporada al archivo, la home cambia de forma a propósito (§4.4): " +
      "recaptura `seasonHome` en scripts/fixtures/curriculum-golden.json"
  );
  assert.equal(groups[0].season, want.season);

  const rows = groups[0].rows.map((row) => ({
    lessonSlug: row.broadcast.lessonSlug,
    title: row.title,
    outcome: row.outcome,
    emitted: row.emitted,
    isNext: row.isNext,
    formattedDate: formatSessionDate(row.broadcast),
    vodUrl: row.broadcast.vodUrl,
  }));
  assert.deepEqual(rows, want.rows, "las filas de la tabla de temporada cambiaron");
}

console.log(
  `OK — cero cambio visible: ${Object.keys(golden.lessonContext).length - 1} bloques del tutor, ` +
    `${stages.length} etapas y ${options.length} opciones de selector idénticas al golden. ` +
    `${evidenceLessons.length} lecciones con evidencia declarada. ` +
    `${golden.seasonHome.rows.length} emisiones y los cuatro textos de la home, sin cambio.`
);
