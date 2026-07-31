// El servicio de evidencia: qué código sale por cada rama y quién decide el
// `user_id`.
//
// Cubre las filas 31, 32, 33, 34, 35, 36, 37 y 38 de PRD-007 §9.
//
// CON DOBLES Y SIN POSTGRES: las ocho filas afirman sobre el CONTROL DE FLUJO
// del servicio —qué se escribe, cuándo NO se escribe, qué excepción sale, qué
// fila se devuelve—, no sobre SQL. La fila 31 en particular es un "cero
// escrituras", que contra una base real solo se podría afirmar espiando el pool.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { CurriculumRepository, ResolvedLesson } from "../curriculum/curriculum.repository.ts";
import { CurriculumUnavailableError } from "../curriculum/curriculum.repository.ts";
import type { LessonEvidenceRow } from "../db/schema.ts";
import type { SessionUser } from "../session/session.guard.ts";
import type { EvidenceDto } from "./evidence.dto.ts";
import type { EvidenceRepository } from "./evidence.repository.ts";
import type { EvidenceVerifier, VerificationResult } from "./evidence-verifier.ts";
import { EvidenceService } from "./evidence.service.ts";

const STUDENT: SessionUser = { userId: "user-1", email: "Estudiante@Ejemplo.test" };
const LESSON_NODE_ID = "11111111-1111-4111-8111-111111111111";
const URL_A = "https://ana.example.com/mi-web";
const URL_B = "https://ana.example.com/otra-web";

/** La lección de L1, que sí pide evidencia. */
const LESSON: ResolvedLesson = {
  id: LESSON_NODE_ID,
  payload: { outcome: "publicas tu web con tu nombre", evidenceKind: "url" },
};

function row(overrides: Partial<LessonEvidenceRow> = {}): LessonEvidenceRow {
  return {
    id: "row-1",
    userId: STUDENT.userId,
    lessonNodeId: LESSON_NODE_ID,
    url: URL_A,
    status: "declared",
    failureReason: null,
    checkedAt: null,
    createdAt: new Date("2026-07-31T18:00:00.000Z"),
    updatedAt: new Date("2026-07-31T18:00:00.000Z"),
    ...overrides,
  } as LessonEvidenceRow;
}

// ---------------------------------------------------------------------------
// Los dobles
// ---------------------------------------------------------------------------

type CurriculumScript = {
  lesson?: ResolvedLesson | null;
  /** Lanza en vez de resolver: el camino del 503. */
  throws?: Error;
  slugs?: Map<string, string>;
  slugsThrow?: Error;
};

function curriculumDouble(script: CurriculumScript) {
  return {
    resolveLesson: vi.fn(async () => {
      if (script.throws) throw script.throws;
      return script.lesson ?? null;
    }),
    slugsByNodeId: vi.fn(async () => {
      if (script.slugsThrow) throw script.slugsThrow;
      return script.slugs ?? new Map<string, string>();
    }),
  } as unknown as CurriculumRepository;
}

type EvidenceScript = {
  declared?: LessonEvidenceRow;
  /** `undefined` = el CAS afectó cero filas. */
  settled?: LessonEvidenceRow | undefined;
  reread?: LessonEvidenceRow;
  listed?: LessonEvidenceRow[];
};

function evidenceDouble(script: EvidenceScript = {}) {
  return {
    declare: vi.fn(async () => script.declared ?? row()),
    settleIfUrlUnchanged: vi.fn(async () => script.settled),
    findOne: vi.fn(async () => script.reread),
    listByUser: vi.fn(async () => script.listed ?? []),
  };
}

function verifierDouble(result: VerificationResult) {
  return { verify: vi.fn(async () => result) };
}

const VERIFIED: VerificationResult = { status: "verified", failureReason: null };
const FAILED: VerificationResult = { status: "failed", failureReason: "http_404" };

function build(
  curriculum: CurriculumScript,
  evidence: ReturnType<typeof evidenceDouble> = evidenceDouble(),
  verifier: ReturnType<typeof verifierDouble> = verifierDouble(VERIFIED)
) {
  const service = new EvidenceService(
    curriculumDouble(curriculum),
    evidence as unknown as EvidenceRepository,
    verifier as unknown as EvidenceVerifier
  );
  return { service, evidence, verifier };
}

const DTO: EvidenceDto = { lessonSlug: "L1", url: URL_A };

/** El código de una `HttpException` de Nest. */
function statusOf(err: unknown): number {
  return (err as { getStatus?: () => number }).getStatus?.() ?? 0;
}

function bodyOf(err: unknown): unknown {
  return (err as { getResponse?: () => unknown }).getResponse?.();
}

// ---------------------------------------------------------------------------

describe("EvidenceService.submit", () => {
  // -------------------------------------------------------------------------
  // Fila 31 — la lección no pide evidencia
  // -------------------------------------------------------------------------
  it("fila 31: una lección sin evidenceKind es 409 y NO escribe fila", async () => {
    const { service, evidence, verifier } = build({
      lesson: { id: LESSON_NODE_ID, payload: { outcome: "algo" } },
    });

    const err = await service.submit(STUDENT, DTO).catch((e: unknown) => e);

    expect(statusOf(err)).toBe(409);
    // El cuerpo es un OBJETO, no una cadena: el panel tiene que distinguir esto
    // de "esa lección no existe".
    expect(bodyOf(err)).toEqual({ error: "lesson_accepts_no_evidence" });
    // Y la afirmación que hace la fila interesante: el 409 va ANTES de la
    // primera escritura, así que no queda una fila `declared` huérfana.
    expect(evidence.declare).not.toHaveBeenCalled();
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it("fila 31 (hermana): un evidenceKind fuera del vocabulario también es 409", async () => {
    // El `payload` que llega de Postgres es `Record<string, unknown>`: se
    // ESTRECHA en vez de afirmarlo con `as`, para que un valor que el archivo no
    // debería contener se lea como "no pide evidencia" y no pinte un panel de un
    // tipo que no existe.
    const { service, evidence } = build({
      lesson: { id: LESSON_NODE_ID, payload: { evidenceKind: "repo" } },
    });

    const err = await service.submit(STUDENT, DTO).catch((e: unknown) => e);

    expect(statusOf(err)).toBe(409);
    expect(evidence.declare).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Filas 32 y 33 — el 404
  // -------------------------------------------------------------------------
  it("fila 32: un slug inexistente es 404 lesson_not_found", async () => {
    const { service, evidence } = build({ lesson: null });

    const err = await service.submit(STUDENT, DTO).catch((e: unknown) => e);

    expect(statusOf(err)).toBe(404);
    expect(bodyOf(err)).toEqual({ error: "lesson_not_found" });
    expect(evidence.declare).not.toHaveBeenCalled();
  });

  it("fila 33: el slug de una etapa o un módulo es 404, NO 409", async () => {
    // `PAYLOAD_VOCABULARY` está indexado por `kind` y `checkPayload` solo recorre
    // el vocabulario de ese kind, así que un `evidenceKind` colgado de una etapa
    // NUNCA pasa por el control de enum: `{"kind":"stage","payload":
    // {"evidenceKind":"repo"}}` parsea limpio en el archivo. Quien resolviera
    // solo por slug guardaría el id de una etapa en `lesson_node_id` y
    // contestaría 409 donde toca 404.
    //
    // El doble devuelve `null` porque el filtro `kind === "lesson"` vive en el
    // repositorio: lo que esta fila fija es que el servicio TRADUCE ese `null` a
    // 404 y no lo confunde con "existe y no pide evidencia".
    const curriculum = curriculumDouble({ lesson: null });
    const evidence = evidenceDouble();
    const service = new EvidenceService(
      curriculum,
      evidence as unknown as EvidenceRepository,
      verifierDouble(VERIFIED) as unknown as EvidenceVerifier
    );

    const err = await service.submit(STUDENT, { lessonSlug: "E1", url: URL_A }).catch((e) => e);

    expect(statusOf(err)).toBe(404);
    expect(bodyOf(err)).toEqual({ error: "lesson_not_found" });
    expect(curriculum.resolveLesson).toHaveBeenCalledWith("E1");
  });

  // -------------------------------------------------------------------------
  // Fila 34 — 404 y 503 se distinguen
  // -------------------------------------------------------------------------
  it("fila 34: si el currículo no se puede leer es 503, no 404", async () => {
    // ES LA RAZÓN DE §7.1. `lessonContext()` colapsa "no existe" y "Postgres
    // falló" en el par vacío, y ese contrato es correcto PARA EL TUTOR — un 500
    // allí tumbaría el turno por no poder decorarlo. Aquí es inservible:
    // un 404 le diría al estudiante que su lección no existe cuando lo que pasa
    // es que la base no contesta.
    const { service, evidence } = build({
      throws: new CurriculumUnavailableError("no se pudo leer el currículo"),
    });

    const err = await service.submit(STUDENT, DTO).catch((e: unknown) => e);

    expect(statusOf(err)).toBe(503);
    expect(bodyOf(err)).toEqual({ error: "curriculum_unavailable" });
    expect(evidence.declare).not.toHaveBeenCalled();
  });

  it("fila 34 (hermana): un error que NO es del currículo se repropaga y sale como 500", async () => {
    // Convertir cualquier excepción en un 503 con código conocido haría que un
    // fallo de programación pareciese una respuesta operativa, y nadie miraría.
    const bug = new TypeError("undefined is not a function");
    const { service } = build({ throws: bug });

    await expect(service.submit(STUDENT, DTO)).rejects.toBe(bug);
  });

  // -------------------------------------------------------------------------
  // Fila 35 — un fallo de verificación es 200
  // -------------------------------------------------------------------------
  it("fila 35: un veredicto failed devuelve el item, no una excepción", async () => {
    // Goal 4: un `failed` es un estado de la FILA, no un error de la petición.
    // La entrega quedó registrada y el estudiante puede seguir y reenviar.
    const settled = row({
      status: "failed",
      failureReason: "http_404",
      checkedAt: new Date("2026-07-31T18:30:02.000Z"),
    });
    const { service } = build({ lesson: LESSON }, evidenceDouble({ settled }), verifierDouble(FAILED));

    await expect(service.submit(STUDENT, DTO)).resolves.toEqual({
      lessonSlug: "L1",
      url: URL_A,
      status: "failed",
      // El literal ISO, no un `Date`: es lo que sale por el cable (§5.1).
      checkedAt: "2026-07-31T18:30:02.000Z",
      failureReason: "http_404",
    });
  });

  // -------------------------------------------------------------------------
  // Fila 36 — el userId sale del token
  // -------------------------------------------------------------------------
  it("fila 36: un userId en el cuerpo no alcanza al repositorio ni aunque burlase el pipe", async () => {
    // El pipe ya lo rechaza con 400 (fila 2), pero el control de §8.1 no puede
    // depender de una sola capa: aquí se le mete el campo al DTO por la fuerza y
    // se comprueba que el servicio no lo mira. La identidad sale de
    // `request.user`, que la puso `SessionGuard`.
    const hostile = { ...DTO, userId: "user-2", email: "otra@ejemplo.test" } as EvidenceDto;
    const evidence = evidenceDouble({ settled: row() });
    const { service } = build({ lesson: LESSON }, evidence);

    await service.submit(STUDENT, hostile);

    expect(evidence.declare).toHaveBeenCalledWith(STUDENT.userId, LESSON_NODE_ID, URL_A);
    expect(evidence.settleIfUrlUnchanged).toHaveBeenCalledWith(
      STUDENT.userId,
      LESSON_NODE_ID,
      URL_A,
      { status: "verified", failureReason: null }
    );
  });

  // -------------------------------------------------------------------------
  // Fila 37 — el CAS descarta un veredicto tardío
  // -------------------------------------------------------------------------
  it("fila 37: si la URL cambió entre las dos escrituras, el veredicto se descarta y se devuelve la fila releída", async () => {
    // Dos entregas solapadas: A escribe `url=A` → B escribe `url=B` → vuelve el
    // verificador de A. Sin el compare-and-set, A estamparía `verified` sobre la
    // fila que ya lleva la URL de B — una fila verificada para una URL que nadie
    // comprobó, que es lo que el goal 2 prohíbe.
    const upsert = row({ url: URL_A });
    const winner = row({ url: URL_B, status: "declared", updatedAt: new Date("2026-07-31T18:40:00.000Z") });
    const evidence = evidenceDouble({ declared: upsert, settled: undefined, reread: winner });
    const { service } = build({ lesson: LESSON }, evidence);

    const item = await service.submit(STUDENT, DTO);

    // Se releyó con un SELECT: un `RETURNING` sobre cero filas no devuelve nada,
    // así que sin la relectura este camino no tendría qué responder.
    expect(evidence.findOne).toHaveBeenCalledWith(STUDENT.userId, LESSON_NODE_ID);
    // Y lo que vuelve es la fila del GANADOR, no la del upsert inicial, que ya
    // es obsoleta.
    expect(item.url).toBe(URL_B);
    expect(item.status).toBe("declared");
    expect(item.failureReason).toBeNull();
  });

  it("fila 37 (contraste): si el CAS SÍ afectó una fila, no se relee nada", async () => {
    // El contraste que hace significativa la fila de arriba: el camino normal no
    // paga un `SELECT` de más.
    const evidence = evidenceDouble({ settled: row({ status: "verified" }) });
    const { service } = build({ lesson: LESSON }, evidence);

    const item = await service.submit(STUDENT, DTO);

    expect(evidence.findOne).not.toHaveBeenCalled();
    expect(item.status).toBe("verified");
  });

  // -------------------------------------------------------------------------
  // Fila 38 — la URL no sale hacia ninguna analítica
  // -------------------------------------------------------------------------
  it("fila 38: el módulo de evidencia no puede emitir a analítica", async () => {
    // DESVIACIÓN DECLARADA respecto a la letra de la fila 38, que dice "el doble
    // de `AnalyticsService` no se llama": este módulo NO DEPENDE de
    // `AnalyticsService`, así que no hay doble que inyectar y un espía sobre uno
    // suelto pasaría por vacuidad. Se afirma la propiedad más fuerte —que no
    // puede llamarse— leyendo el código, que es lo que ya hace
    // `scripts/check-boundaries.ts` para una invariante de la misma clase.
    //
    // POR QUÉ NO SE EMITE NADA. §8.5 acota las propiedades de un evento de
    // evidencia a `{lessonSlug, status, failureReason}` PERO el union de
    // `packages/shared/src/analytics-events.ts` no tiene ningún miembro de
    // evidencia, y ensancharlo no está en la tabla de Impacted Projects de este
    // PRD. La línea natural que §8.5 describe —seguir el precedente de embudo de
    // PRD-003 y emitir `{lessonSlug, url, status}`— exportaría la URL, que es
    // dato personal por construcción, a un procesador tercero atada al correo
    // del estudiante y fuera de la garantía de `onDelete: "cascade"`.
    const directory = import.meta.dirname;
    const sources = readdirSync(directory).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".spec.ts")
    );

    // Afirmación positiva primero: si el filtro dejara de encontrar ficheros,
    // el bucle de abajo pasaría por vacuidad.
    expect(sources).toContain("evidence.service.ts");
    expect(sources.length).toBeGreaterThanOrEqual(6);

    for (const name of sources) {
      const source = readFileSync(join(directory, name), "utf8");
      // Sin el bloque de comentario, que sí nombra `AnalyticsService` para
      // explicar por qué no está.
      const code = source.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

      expect(code, `${name} no puede importar AnalyticsService`).not.toContain("AnalyticsService");
      expect(code, `${name} no puede emitir a analítica`).not.toContain(".track(");
    }
  });
});

// ---------------------------------------------------------------------------

describe("EvidenceService.list", () => {
  it("devuelve solo las filas del propio estudiante, con su slug resuelto", async () => {
    const otra = "22222222-2222-4222-8222-222222222222";
    const evidence = evidenceDouble({
      listed: [
        row({ url: URL_A, status: "verified", checkedAt: new Date("2026-07-31T18:22:41.000Z") }),
        row({ id: "row-2", lessonNodeId: otra, url: URL_B, status: "failed", failureReason: "http_404" }),
      ],
    });
    const { service } = build(
      { slugs: new Map([[LESSON_NODE_ID, "L1"], [otra, "L3"]]) },
      evidence
    );

    await expect(service.list(STUDENT)).resolves.toEqual({
      items: [
        {
          lessonSlug: "L1",
          url: URL_A,
          status: "verified",
          checkedAt: "2026-07-31T18:22:41.000Z",
          failureReason: null,
        },
        {
          lessonSlug: "L3",
          url: URL_B,
          status: "failed",
          checkedAt: null,
          failureReason: "http_404",
        },
      ],
    });
    expect(evidence.listByUser).toHaveBeenCalledWith(STUDENT.userId);
  });

  it("omite la fila de un nodo retirado del temario, y no la borra", async () => {
    // §6.3: el trabajo del estudiante existió, el temario cambió. La fila
    // sobrevive y vuelve sola si el nodo regresa.
    const retirado = "33333333-3333-4333-8333-333333333333";
    const evidence = evidenceDouble({
      listed: [row(), row({ id: "row-2", lessonNodeId: retirado })],
    });
    const { service } = build({ slugs: new Map([[LESSON_NODE_ID, "L1"]]) }, evidence);

    const { items } = await service.list(STUDENT);

    expect(items).toHaveLength(1);
    expect(items[0].lessonSlug).toBe("L1");
    // Ninguna consulta las borra: el servicio solo lee.
    expect(evidence).not.toHaveProperty("delete");
  });

  it("si el currículo no se puede leer, el GET también es 503", async () => {
    const evidence = evidenceDouble({ listed: [row()] });
    const { service } = build(
      { slugsThrow: new CurriculumUnavailableError("no se pudo leer el currículo") },
      evidence
    );

    const err = await service.list(STUDENT).catch((e: unknown) => e);

    expect(statusOf(err)).toBe(503);
    expect(bodyOf(err)).toEqual({ error: "curriculum_unavailable" });
  });
});
