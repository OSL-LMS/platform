// El bloque de temario: qué se consulta, cuándo NO se consulta, y qué pasa
// cuando la consulta falla.
//
// Cubre las filas 25, 26 y 27 de PRD-005 §9.
//
// Con un doble de `DRIZZLE` y no contra Postgres: las tres filas afirman sobre
// el CONTROL DE FLUJO del repositorio —cuántas consultas se lanzan, qué se hace
// con lo que devuelven, qué se hace cuando lanzan—, no sobre SQL. La fila 27 en
// particular es un "cero consultas", que contra una base real solo se podría
// afirmar espiando el pool.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { describe, expect, it } from "vitest";

import type { ApiConfig } from "../config.ts";
import type { Database } from "../db/drizzle.module.ts";
import { captureOutput, TEST_CURRICULUM_SLUG } from "../../test/helpers.ts";
import { CurriculumRepository } from "./curriculum.repository.ts";

/** Una fila de `curriculum_nodes` con lo que `buildForest` necesita. */
type Row = {
  id: string;
  curriculum: string;
  slug: string;
  parentId: string | null;
  kind: string;
  title: string;
  position: number;
  payload: Record<string, unknown>;
};

function node(
  slug: string,
  kind: string,
  title: string,
  parentId: string | null,
  position: number,
  payload: Record<string, unknown> = {}
): Row {
  return {
    id: `id-${slug}`,
    curriculum: TEST_CURRICULUM_SLUG,
    slug,
    parentId,
    kind,
    title,
    position,
    payload,
  };
}

/** Dos módulos con lecciones bajo la misma etapa. Es el escenario de la fila 25:
 *  con un solo módulo, "las lecciones del módulo" y "las del currículo" son el
 *  mismo conjunto y la fila pasaría sin ejercitar nada. */
const FOREST: Row[] = [
  node("E1", "stage", "Fundamentos", null, 0),
  node("M1", "module", "HTML y CSS", "id-E1", 0, { audience: "principiantes" }),
  node("L1", "lesson", "Tu primera página", "id-M1", 0, { outcome: "publicarás", stuck: "las rutas" }),
  node("L2", "lesson", "Estilos", "id-M1", 1, { outcome: "darás color", stuck: "la cascada" }),
  node("M2", "module", "Git", "id-E1", 1, { audience: "los mismos" }),
  node("L9", "lesson", "Tu primer commit", "id-M2", 0, { outcome: "versionarás", stuck: "el staging" }),
];

/** Doble de `DRIZZLE` que cuenta consultas. `onQuery` permite hacerla lanzar. */
function databaseDouble(rows: Row[], onQuery?: () => never) {
  const counter = { selects: 0 };
  const db = {
    select: () => {
      counter.selects++;
      return {
        from: () => ({
          where: () => {
            if (onQuery) {
              try {
                onQuery();
              } catch (err) {
                return Promise.reject(err);
              }
            }
            return Promise.resolve(rows);
          },
        }),
      };
    },
  } as unknown as Database;
  return { db, counter };
}

const config = { curriculumSlug: TEST_CURRICULUM_SLUG } as ApiConfig;

describe("CurriculumRepository", () => {
  // -------------------------------------------------------------------------
  // Fila 25 — el índice se acota AL MÓDULO de la lección declarada
  // -------------------------------------------------------------------------
  it("fila 25: `moduleLessons` solo trae las lecciones del módulo de la lección", async () => {
    // Sin este recorte, la línea "Lecciones del módulo:" del bloque de system
    // pasaría a listar el temario entero mal etiquetado en cuanto un segundo
    // módulo recibiera su primera clase — y eso viaja al modelo como verdad.
    const { db } = databaseDouble(FOREST);
    const repo = new CurriculumRepository(db, config);

    const { moduleLessons, ancestors } = await repo.lessonContext("L1");

    expect(moduleLessons.map((l) => l.slug)).toEqual(["L1", "L2"]);
    expect(moduleLessons.map((l) => l.slug)).not.toContain("L9");
    // Y la cadena de ancestros llega hasta la etapa, que es de donde
    // `buildLessonContext` saca el módulo en curso.
    expect(ancestors.map((a) => a.slug)).toEqual(["E1", "M1"]);
  });

  it("fila 25: la lección del otro módulo ve el suyo, no el primero", async () => {
    const { db } = databaseDouble(FOREST);
    const repo = new CurriculumRepository(db, config);

    const { moduleLessons } = await repo.lessonContext("L9");

    expect(moduleLessons.map((l) => l.slug)).toEqual(["L9"]);
  });

  // -------------------------------------------------------------------------
  // Fila 26 — un currículo sin cargar NO tumba el tutor
  // -------------------------------------------------------------------------
  it("fila 26: con la tabla vacía devuelve el par vacío, no lanza", async () => {
    // Es la rama "el estudiante no ha declarado lección": el tutor pregunta. Un
    // 500 aquí tumbaría el turno entero por no poder decorarlo.
    const { db } = databaseDouble([]);
    const repo = new CurriculumRepository(db, config);

    await expect(repo.lessonContext("L1")).resolves.toEqual({ moduleLessons: [], ancestors: [] });
  });

  it("fila 26: un slug que no existe tampoco lanza", async () => {
    const { db } = databaseDouble(FOREST);
    const repo = new CurriculumRepository(db, config);

    await expect(repo.lessonContext("no-existe")).resolves.toEqual({
      moduleLessons: [],
      ancestors: [],
    });
  });

  it("fila 26: una consulta que LANZA devuelve el par vacío y registra solo name y code", async () => {
    const { db } = databaseDouble([], () => {
      const err = new Error("Failed query: select … params: Estudiante@Ejemplo.test");
      err.name = "DrizzleQueryError";
      (err as Error & { cause?: unknown }).cause = { code: "ECONNREFUSED" };
      throw err;
    });
    const repo = new CurriculumRepository(db, config);

    const capture = captureOutput();
    let output: string;
    let result: Awaited<ReturnType<typeof repo.lessonContext>>;
    try {
      result = await repo.lessonContext("L1");
    } finally {
      output = capture.stop();
    }

    expect(result).toEqual({ moduleLessons: [], ancestors: [] });
    // Reglas de §8 de PRD-003: el `message` de DrizzleQueryError lleva los
    // parámetros ligados, o sea el correo.
    expect(output).toContain("name=DrizzleQueryError");
    expect(output).toContain("code=ECONNREFUSED");
    expect(output).not.toContain("@");
    expect(output).not.toContain("params:");
  });

  // -------------------------------------------------------------------------
  // Fila 27 — sin lección declarada, cero consultas
  // -------------------------------------------------------------------------
  it("fila 27: sin `lesson` no se consulta `curriculum_nodes` ni una vez", async () => {
    // El corto circuito de `curriculum.ts:174`, replicado. El selector de lección
    // es OPCIONAL en la UI, así que un turno sin lección es un camino corriente:
    // sin esto, cada uno de esos turnos pasaría de cero consultas a un SELECT del
    // currículo entero.
    const { db, counter } = databaseDouble(FOREST);
    const repo = new CurriculumRepository(db, config);

    await expect(repo.lessonContext(undefined)).resolves.toEqual({
      moduleLessons: [],
      ancestors: [],
    });
    await expect(repo.lessonContext("")).resolves.toEqual({ moduleLessons: [], ancestors: [] });

    expect(counter.selects).toBe(0);

    // Contraste: CON lección sí consulta, una sola vez. Sin esta línea la de
    // arriba pasaría también con un repositorio que no consultara nunca.
    await repo.lessonContext("L1");
    expect(counter.selects).toBe(1);
  });
});
