// "Cero cambio visible": el golden capturado con `lessons.ts` y `program.ts`
// ANTES de migrar (PRD-002 §10 paso 1) frente a lo que produce el árbol.
// Se ejecuta con: node scripts/check-curriculum-golden.ts
//
// Va en su propio script y corre PRIMERO: `node:assert` lanza al primer fallo,
// y agruparlo con las unitarias haría que un fallo trivial impidiera correr la
// comprobación más cargada del PRD.
//
// Cubre las filas 1, 2 y 22 de PRD-002 §9.
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

const ROOT = resolve(import.meta.dirname, "..");

type Golden = {
  lessonContext: Record<string, string>;
  program: {
    id: string; name: string; built: string; aiRole: string; milestone: string;
    hours: number; status: string; statusLabel: string;
    modules: string[] | null; stageData: string; hasDetails: boolean;
  }[];
  lessonOptions: { slug: string; title: string }[];
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

// No viaja `payload` al cliente.
for (const option of options) {
  assert.deepEqual(Object.keys(option).sort(), ["slug", "title"]);
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

console.log(
  `OK — cero cambio visible: ${Object.keys(golden.lessonContext).length - 1} bloques del tutor, ` +
    `${stages.length} etapas y ${options.length} opciones de selector idénticas al golden.`
);
