// La evidencia por lección contra Postgres de verdad, con el verificador
// sustituido por un doble.
//
// Cubre las filas 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51 y 52 de
// PRD-007 §9.
//
// ESCRIBEN Y BORRAN en `lesson_evidence`, `curriculum_nodes`, `conversations`,
// `subscriptions` y `user`: exigen `API_TEST_DATABASE_URL` apuntando a una base
// desechable, y abortan si coincide con `DATABASE_URL`.
//
// NINGUNA FILA HACE DNS NI HTTPS REALES. `EvidenceVerifier` está sustituido en
// el contenedor entero (`.overrideProvider`), el mismo movimiento que
// `subscriptions.repository.ts:1-3` documenta para las filas 13-18 de PRD-003.
// Sin eso, `pnpm test` saldría a internet contra un tercero desde la máquina que
// lo ejecute: dependencia nueva y fuente de intermitencia. El camino de red real
// lo ejercitan solo las filas 9-30, que reciben el resolutor y `fetch`
// inyectados — y la fila 52 de aquí, que reutiliza el verificador DE VERDAD con
// esos dos dobles para que la cadena de redirección ocurra.
//
// TRES COSAS QUE ESTE FICHERO HACE Y NO SON OBVIAS:
//
//  1. **Un estudiante nuevo por fila.** `EVIDENCE_THROTTLE` son 5/min POR
//     CREDENCIAL, así que compartir token entre filas haría que la sexta
//     petición de la suite —no de la fila— fuese un 429, y el fallo aparecería
//     en la fila equivocada.
//  2. **Los tres bloques de tasa comparten aplicación y VAN EN ORDEN.** El cubo
//     `evidence-outbound` es global y de 60/min, y su `skipIf` lo acota al
//     handler `submit`: el `GET` no entra en él ni gasta de él (por eso la
//     hermana de la fila 47 puede pasar de 60 lecturas sin ver un 429). Lo que
//     sí comparte cubo es la fila 45, que lo agota, y la 46 comprueba DESPUÉS
//     que agotarlo no ha tocado al webhook. Ese orden es la mitad de la
//     afirmación, no una casualidad.
//  3. **El usuario se inserta en `user`.** `lesson_evidence.user_id` es FK con
//     `onDelete: cascade`; sin la fila padre toda escritura falla con violación
//     de clave ajena.
//
// Regla de código: identificadores en inglés, comentarios en español.

import type Anthropic from "@anthropic-ai/sdk";
import { Test, type TestingModule } from "@nestjs/testing";
import { and, count, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AnalyticsService } from "../src/analytics/analytics.service.ts";
import { AppModule } from "../src/app.module.ts";
import * as schema from "../src/db/schema.ts";
import {
  verifyEvidenceUrl,
  EvidenceVerifier,
  type EvidenceResolver,
  type VerificationResult,
} from "../src/evidence/evidence-verifier.ts";
import {
  EVIDENCE_OUTBOUND_PER_MINUTE,
  EVIDENCE_PER_CREDENTIAL_PER_MINUTE,
} from "../src/throttle.ts";
import { ANTHROPIC_CLIENT, type TutorStream } from "../src/tutor/anthropic.client.ts";
import { TUTOR_TURNS_PER_MINUTE } from "../src/throttle.ts";
import {
  applyApiEnv,
  migrateTestDatabase,
  requireTestDatabaseUrl,
  sessionToken,
  startApp,
  stopApp,
  TEST_CURRICULUM_SLUG,
  type RunningApp,
} from "./helpers.ts";

// ---------------------------------------------------------------------------
// El currículo de pruebas
// ---------------------------------------------------------------------------

/** Ids fijos: el `id` ES la identidad del nodo y sobrevive a renombrados, que es
 *  justo lo que prueba la fila 49. */
const L1 = "aaaaaaaa-0000-4000-8000-000000000001";
const L2 = "aaaaaaaa-0000-4000-8000-000000000002";
const L3 = "aaaaaaaa-0000-4000-8000-000000000003";
/** Lección EXCLUSIVA de la fila 51: el agregado por lección cuenta las filas de
 *  todos los estudiantes, así que compartir nodo con otra fila la contaminaría. */
const L4 = "aaaaaaaa-0000-4000-8000-000000000005";
const SIN_EVIDENCIA = "aaaaaaaa-0000-4000-8000-000000000004";
const ETAPA = "aaaaaaaa-0000-4000-8000-00000000000e";
/** Un nodo que se BORRA tras usarse: la fila 48 necesita un `lesson_node_id`
 *  huérfano, y §6.3 dice que eso es legal porque no hay clave foránea. */
const RETIRADO = "aaaaaaaa-0000-4000-8000-00000000000f";

const URL_A = "https://ana.example.com/mi-web";
const URL_B = "https://ana.example.com/otra-web";
const URL_C = "https://ana.example.com/tercera";

function lessonRow(id: string, slug: string, payload: Record<string, unknown>) {
  return {
    id,
    curriculum: TEST_CURRICULUM_SLUG,
    parentId: null,
    kind: "lesson",
    slug,
    title: `Lección ${slug}`,
    position: 0,
    payload,
  };
}

const PIDE_EVIDENCIA = { outcome: "publicas tu web", evidenceKind: "url", evidencePrompt: "Pega la URL" };

// ---------------------------------------------------------------------------
// El doble del verificador
// ---------------------------------------------------------------------------

type VerifierScript = {
  /** Veredicto por URL. Lo que no esté aquí se verifica. */
  byUrl: Record<string, VerificationResult>;
  /** Milisegundos antes de contestar. Es lo que abre la ventana de la fila 40. */
  delayMs: number;
  /** Cadena de redirección en memoria: la fila 52 corre el verificador DE
   *  VERDAD con `fetch` y resolutor dobles, para que el salto ocurra. */
  redirects?: Record<string, string>;
};

const script: VerifierScript = { byUrl: {}, delayMs: 0 };

const VERIFIED: VerificationResult = { status: "verified", failureReason: null };

/** Resolutor que contesta siempre una dirección pública de documentación. */
function resolverDouble(): EvidenceResolver {
  return {
    resolve4: async () => ["93.184.216.34"],
    resolve6: async () => {
      throw Object.assign(new Error("ENODATA"), { code: "ENODATA" });
    },
    cancel: () => {},
  };
}

const verifierDouble = {
  async verify(url: string): Promise<VerificationResult> {
    if (script.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, script.delayMs));

    if (script.redirects) {
      // El verificador REAL, con la red sustituida: la cadena de redirección
      // ocurre de verdad y la URL que contesta 200 no es la entregada.
      const chain = script.redirects;
      return verifyEvidenceUrl(
        url,
        { timeoutMs: 3_000, maxRedirects: 3 },
        {
          createResolver: resolverDouble,
          fetch: (async (input: RequestInfo | URL) => {
            const target = String(input);
            const location = chain[target];
            return {
              status: location ? 302 : 200,
              headers: new Headers(location ? { location } : {}),
            } as Response;
          }) as typeof globalThis.fetch,
        }
      );
    }

    return script.byUrl[url] ?? VERIFIED;
  },
};

/** Doble mínimo de Anthropic para la fila 46: un delta y a cerrar. */
const anthropicDouble = {
  messages: {
    stream(): TutorStream {
      return {
        abort() {},
        async *[Symbol.asyncIterator]() {
          yield {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "ok" },
          } as Anthropic.MessageStreamEvent;
        },
      };
    },
  },
};

// ---------------------------------------------------------------------------
// Infraestructura compartida
// ---------------------------------------------------------------------------

let pool: Pool;
let db: NodePgDatabase<typeof schema>;
let nextStudent = 0;

async function compileApp(): Promise<TestingModule> {
  return Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(EvidenceVerifier)
    .useValue(verifierDouble)
    .overrideProvider(ANTHROPIC_CLIENT)
    .useValue(anthropicDouble)
    .overrideProvider(AnalyticsService)
    .useValue({ track: () => {} })
    .compile();
}

type Student = { id: string; email: string; token: string };

/** Un estudiante nuevo, con su fila en `user` y su token de sesión. Uno por
 *  fila: la cota de 5/min es POR CREDENCIAL. */
async function newStudent(): Promise<Student> {
  nextStudent += 1;
  const id = `evidencia-${nextStudent}`;
  const email = `evidencia-${nextStudent}@ejemplo.test`;
  await db.insert(schema.users).values({ id, email }).onConflictDoNothing();
  return { id, email, token: await sessionToken({ id, email }) };
}

type ApiResponse = { status: number; body: unknown };

function post(base: string, student: Student | null, body: unknown): Promise<ApiResponse> {
  return request(`${base}/v1/evidence`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(student ? { authorization: `Bearer ${student.token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function get(base: string, student: Student | null): Promise<ApiResponse> {
  return request(`${base}/v1/evidence`, {
    headers: student ? { authorization: `Bearer ${student.token}` } : {},
  });
}

async function request(url: string, init?: RequestInit): Promise<ApiResponse> {
  const response = await fetch(url, init);
  // Se consume SIEMPRE el cuerpo: sin ello la conexión queda abierta y el
  // siguiente `fetch` puede reordenarse contra el contador del throttler.
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* el cuerpo no era JSON: se deja la cadena */
  }
  return { status: response.status, body };
}

function rowsOf(userId: string) {
  return db.select().from(schema.lessonEvidence).where(eq(schema.lessonEvidence.userId, userId));
}

beforeAll(async () => {
  const databaseUrl = requireTestDatabaseUrl();
  migrateTestDatabase(databaseUrl);
  applyApiEnv({ DATABASE_URL: databaseUrl });

  pool = new Pool({ connectionString: databaseUrl });
  db = drizzle(pool, { schema });

  await db.delete(schema.lessonEvidence);
  await db.delete(schema.conversations);
  await db.delete(schema.subscriptions);
  await db.delete(schema.users);
  await db.delete(schema.curriculumNodes);

  await db.insert(schema.curriculumNodes).values([
    lessonRow(L1, "L1", PIDE_EVIDENCIA),
    lessonRow(L2, "L2", PIDE_EVIDENCIA),
    lessonRow(L3, "L3", PIDE_EVIDENCIA),
    lessonRow(L4, "L4", PIDE_EVIDENCIA),
    lessonRow(SIN_EVIDENCIA, "L9", { outcome: "algo que no se entrega" }),
    lessonRow(RETIRADO, "L-retirada", PIDE_EVIDENCIA),
    // Una ETAPA con `evidenceKind` colgado: parsea limpio en el archivo porque
    // `PAYLOAD_VOCABULARY` está indexado por `kind` (§7.1). Existe para que el
    // 404 de un slug que no es de lección sea comprobable de punta a punta.
    {
      id: ETAPA,
      curriculum: TEST_CURRICULUM_SLUG,
      parentId: null,
      kind: "stage",
      slug: "E1",
      title: "Etapa 1",
      position: 0,
      payload: { evidenceKind: "url" },
    },
  ]);
});

afterAll(async () => {
  await pool?.end();
});

// ---------------------------------------------------------------------------
// Filas 39 a 44 y 48 a 52 — el comportamiento
// ---------------------------------------------------------------------------

describe("evidencia por lección", () => {
  let running: RunningApp;
  let base: string;

  beforeAll(async () => {
    running = await startApp(await compileApp());
    base = running.baseUrl;
  });

  afterAll(async () => {
    await stopApp(running?.app);
  });

  // -------------------------------------------------------------------------
  // Fila 39
  // -------------------------------------------------------------------------
  it("fila 39: reenviar ACTUALIZA la fila, no la duplica", async () => {
    const student = await newStudent();
    script.byUrl = { [URL_B]: { status: "failed", failureReason: "http_404" } };

    const first = await post(base, student, { lessonSlug: "L1", url: URL_A });
    expect(first.status).toBe(200);

    const [afterFirst] = await rowsOf(student.id);
    expect(afterFirst.status).toBe("verified");

    const second = await post(base, student, { lessonSlug: "L1", url: URL_B });
    expect(second.status).toBe(200);

    const rows = await rowsOf(student.id);
    expect(rows).toHaveLength(1);

    const [row] = rows;
    expect(row.url).toBe(URL_B);
    // `created_at` INTACTO: la fila conserva su primera entrega.
    expect(row.createdAt.getTime()).toBe(afterFirst.createdAt.getTime());
    // `updated_at` AVANZADO: sin nombrarlo en el `set` conservaría el valor de
    // inserción, porque el esquema no tiene `$onUpdate`.
    expect(row.updatedAt.getTime()).toBeGreaterThan(afterFirst.updatedAt.getTime());
    // Y el veredicto se RECALCULÓ: una URL nueva no hereda el de la anterior.
    expect(row.status).toBe("failed");
    expect(row.failureReason).toBe("http_404");

    script.byUrl = {};
  });

  // -------------------------------------------------------------------------
  // Fila 40
  // -------------------------------------------------------------------------
  it("fila 40: dos entregas en paralelo con URLs distintas dejan UNA fila cuyo status corresponde a SU url", async () => {
    // CONTAR FILAS NO BASTA. El upsert garantiza una fila; no garantiza una
    // COHERENTE. Sin el compare-and-set de §5.5 el veredicto de la entrega
    // perdedora se estampa sobre la fila de la ganadora, y el resultado es una
    // fila `verified` para una URL que nadie verificó — lo que el goal 2 prohíbe.
    const student = await newStudent();
    script.byUrl = {
      [URL_A]: VERIFIED,
      [URL_B]: { status: "failed", failureReason: "http_404" },
    };
    // La ventana que hace posible el entrelazado.
    script.delayMs = 60;

    const [a, b] = await Promise.all([
      post(base, student, { lessonSlug: "L1", url: URL_A }),
      post(base, student, { lessonSlug: "L1", url: URL_B }),
    ]);

    script.delayMs = 0;
    script.byUrl = {};

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    const rows = await rowsOf(student.id);
    expect(rows).toHaveLength(1);

    const [row] = rows;
    // El estado tiene que CORRESPONDER a la url de la fila, o ser `declared`
    // —los dos veredictos descartados—, y nunca el del otro.
    const expected: Record<string, string[]> = {
      [URL_A]: ["verified", "declared"],
      [URL_B]: ["failed", "declared"],
    };
    expect(
      expected[row.url],
      `fila con url=${row.url} y status=${row.status}`
    ).toContain(row.status);
  });

  // -------------------------------------------------------------------------
  // Fila 41
  // -------------------------------------------------------------------------
  it("fila 41: cada estudiante ve solo lo suyo", async () => {
    const ana = await newStudent();
    const luis = await newStudent();

    await post(base, ana, { lessonSlug: "L1", url: URL_A });
    await post(base, luis, { lessonSlug: "L1", url: URL_B });

    const deAna = await get(base, ana);
    const deLuis = await get(base, luis);

    expect(deAna.status).toBe(200);
    expect(deAna.body).toEqual({
      items: [expect.objectContaining({ lessonSlug: "L1", url: URL_A })],
    });
    expect(deLuis.body).toEqual({
      items: [expect.objectContaining({ lessonSlug: "L1", url: URL_B })],
    });
  });

  // -------------------------------------------------------------------------
  // Fila 42
  // -------------------------------------------------------------------------
  it("fila 42: un estudiante con tres lecciones ve los tres estados", async () => {
    // Es la forma LITERAL que promete el goal 5: qué lecciones entregó y cuáles
    // quedaron verificadas, con una consulta.
    const student = await newStudent();
    script.byUrl = {
      [URL_B]: { status: "failed", failureReason: "http_500" },
    };

    await post(base, student, { lessonSlug: "L1", url: URL_A });
    await post(base, student, { lessonSlug: "L2", url: URL_B });
    await post(base, student, { lessonSlug: "L3", url: URL_C });
    script.byUrl = {};

    // La tercera se deja en `declared` a mano: es el estado de una entrega cuyo
    // veredicto se descartó, y no hay otra forma de llegar a él sin una carrera.
    await db
      .update(schema.lessonEvidence)
      .set({ status: "declared", checkedAt: null, failureReason: null })
      .where(
        and(
          eq(schema.lessonEvidence.userId, student.id),
          eq(schema.lessonEvidence.lessonNodeId, L3)
        )
      );

    const { status, body } = await get(base, student);
    expect(status).toBe(200);

    const items = (body as { items: Array<Record<string, unknown>> }).items;
    expect(items).toHaveLength(3);

    const byLesson = Object.fromEntries(items.map((item) => [item.lessonSlug, item]));
    expect(byLesson.L1).toMatchObject({ status: "verified", url: URL_A, failureReason: null });
    expect(byLesson.L2).toMatchObject({ status: "failed", url: URL_B, failureReason: "http_500" });
    expect(byLesson.L3).toMatchObject({ status: "declared", url: URL_C, checkedAt: null });
    // El literal ISO, no `2026-07-31 18:22:41`, que es lo que devolvería Drizzle
    // sin `{ mode: "date" }` en la columna.
    expect(byLesson.L1.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });

  // -------------------------------------------------------------------------
  // Fila 43
  // -------------------------------------------------------------------------
  it("fila 43: sin token, los dos endpoints son 401", async () => {
    expect((await post(base, null, { lessonSlug: "L1", url: URL_A })).status).toBe(401);
    expect((await get(base, null)).status).toBe(401);

    // Y con un Bearer que no descifra, también.
    const basura = await request(`${base}/v1/evidence`, {
      headers: { authorization: "Bearer no-es-un-jwe" },
    });
    expect(basura.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // Fila 44
  // -------------------------------------------------------------------------
  it("fila 44: el POST responde 200, no el 201 por defecto de Nest", async () => {
    const student = await newStudent();

    const { status, body } = await post(base, student, { lessonSlug: "L1", url: URL_A });

    expect(status).toBe(200);
    expect(body).toEqual({
      lessonSlug: "L1",
      url: URL_A,
      status: "verified",
      checkedAt: expect.any(String),
      failureReason: null,
    });
  });

  // -------------------------------------------------------------------------
  // Las ramas de error de §4.2 que llegan hasta el cable
  // -------------------------------------------------------------------------
  it("filas 31-33 y 3 (integración): 404 para un slug inexistente, 404 para una etapa, 409 para una lección sin evidencia, 400 para un cuerpo malo", async () => {
    const student = await newStudent();

    const inexistente = await post(base, student, { lessonSlug: "no-existe", url: URL_A });
    expect(inexistente.status).toBe(404);
    expect(inexistente.body).toEqual({ error: "lesson_not_found" });

    // El slug de una ETAPA cae en el 404, no en el 409, aunque su payload lleve
    // `evidenceKind`: `resolveLesson` casa solo `kind === "lesson"` (§7.1).
    const etapa = await post(base, student, { lessonSlug: "E1", url: URL_A });
    expect(etapa.status).toBe(404);
    expect(etapa.body).toEqual({ error: "lesson_not_found" });

    const sinEvidencia = await post(base, student, { lessonSlug: "L9", url: URL_A });
    expect(sinEvidencia.status).toBe(409);
    expect(sinEvidencia.body).toEqual({ error: "lesson_accepts_no_evidence" });

    const malformada = await post(base, student, { lessonSlug: "L1", url: "http://ana.example.com/" });
    expect(malformada.status).toBe(400);

    // Y NINGUNA de las cuatro dejó fila.
    expect(await rowsOf(student.id)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Fila 48
  // -------------------------------------------------------------------------
  it("fila 48: una fila cuyo nodo ya no existe se omite del GET y SIGUE en la tabla", async () => {
    const student = await newStudent();

    await post(base, student, { lessonSlug: "L-retirada", url: URL_A });
    await post(base, student, { lessonSlug: "L1", url: URL_B });
    expect(await rowsOf(student.id)).toHaveLength(2);

    // Retirar una lección es una edición de temario. SIN clave foránea (§6.3),
    // así que el borrado funciona y no aborta por el trabajo ya hecho.
    await db.delete(schema.curriculumNodes).where(eq(schema.curriculumNodes.id, RETIRADO));

    const { body } = await get(base, student);
    const items = (body as { items: unknown[] }).items;
    expect(items).toEqual([expect.objectContaining({ lessonSlug: "L1", url: URL_B })]);

    // Y LA FILA SIGUE AHÍ: ninguna consulta la borra. El trabajo del estudiante
    // existió; el temario cambió.
    const rows = await rowsOf(student.id);
    expect(rows).toHaveLength(2);
    expect(rows.some((row) => row.lessonNodeId === RETIRADO)).toBe(true);

    // Y VUELVE SOLA si el nodo regresa, porque el `id` es identidad estable.
    await db.insert(schema.curriculumNodes).values(lessonRow(RETIRADO, "L-retirada", PIDE_EVIDENCIA));
    const again = await get(base, student);
    expect((again.body as { items: unknown[] }).items).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Fila 49
  // -------------------------------------------------------------------------
  it("fila 49: se renombra el slug del nodo y la evidencia sobrevive, bajo el slug nuevo", async () => {
    // Es la afirmación de D1, que ninguna otra fila prueba: la identidad de la
    // lección es el UUID del nodo, no el `slug`, que es MUTABLE por contrato de
    // PRD-002. Guardar el slug desconectaría en silencio toda la evidencia de esa
    // lección el día que alguien la renombre.
    const student = await newStudent();
    await post(base, student, { lessonSlug: "L2", url: URL_A });

    const antes = await get(base, student);
    expect((antes.body as { items: Array<{ lessonSlug: string }> }).items[0].lessonSlug).toBe("L2");

    await db
      .update(schema.curriculumNodes)
      .set({ slug: "L2-renombrada" })
      .where(eq(schema.curriculumNodes.id, L2));

    try {
      const despues = await get(base, student);
      const items = (despues.body as { items: Array<Record<string, unknown>> }).items;

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ lessonSlug: "L2-renombrada", url: URL_A });
    } finally {
      await db
        .update(schema.curriculumNodes)
        .set({ slug: "L2" })
        .where(eq(schema.curriculumNodes.id, L2));
    }
  });

  // -------------------------------------------------------------------------
  // Fila 50
  // -------------------------------------------------------------------------
  it("fila 50: la baja del usuario se lleva sus filas por cascada", async () => {
    const student = await newStudent();
    await post(base, student, { lessonSlug: "L1", url: URL_A });
    expect(await rowsOf(student.id)).toHaveLength(1);

    await db.delete(schema.users).where(eq(schema.users.id, student.id));

    expect(await rowsOf(student.id)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Fila 51
  // -------------------------------------------------------------------------
  it("fila 51: el agregado por lección responde el dato de abandono", async () => {
    // D5: el criterio de aceptación "cuántos estudiantes completaron la lección
    // Y" se satisface con el modelo de datos y su índice, consultable por SQL.
    // Una superficie HTTP para el operador llegaría antes de que exista el dato.
    const uno = await newStudent();
    const dos = await newStudent();
    const tres = await newStudent();

    script.byUrl = { [URL_B]: { status: "failed", failureReason: "http_404" } };
    await post(base, uno, { lessonSlug: "L4", url: URL_A });
    await post(base, dos, { lessonSlug: "L4", url: URL_B });
    await post(base, tres, { lessonSlug: "L4", url: URL_C });
    script.byUrl = {};

    await db
      .update(schema.lessonEvidence)
      .set({ status: "declared", checkedAt: null, failureReason: null })
      .where(
        and(
          eq(schema.lessonEvidence.userId, tres.id),
          eq(schema.lessonEvidence.lessonNodeId, L4)
        )
      );

    const rows = await db
      .select({ status: schema.lessonEvidence.status, total: count() })
      .from(schema.lessonEvidence)
      .where(eq(schema.lessonEvidence.lessonNodeId, L4))
      .groupBy(schema.lessonEvidence.status);

    expect(Object.fromEntries(rows.map((row) => [row.status, row.total]))).toEqual({
      verified: 1,
      failed: 1,
      declared: 1,
    });
  });

  // -------------------------------------------------------------------------
  // Fila 52
  // -------------------------------------------------------------------------
  it("fila 52: un destino que redirige SÍ aterriza el veredicto en la fila", async () => {
    // FALLA SI EL CAS COMPARA CONTRA EL DESTINO FINAL en vez de contra la URL
    // entregada (§5.5): eso deja en `declared` TODO destino con redirección,
    // incluido `apex→www` de GitHub Pages, que es el artefacto de L1 — la
    // primera lección del curso no llegaría nunca a `verified`, con 200 y sin
    // error en ningún sitio.
    //
    // Aquí corre el verificador DE VERDAD con `fetch` y resolutor dobles, así
    // que la cadena existe: la URL que contesta 200 no es la que se entregó.
    const student = await newStudent();
    script.redirects = {
      [URL_A]: "https://www.example.com/mi-web",
      "https://www.example.com/mi-web": "https://www.example.com/mi-web/",
    };

    try {
      const { status, body } = await post(base, student, { lessonSlug: "L1", url: URL_A });

      expect(status).toBe(200);
      expect(body).toMatchObject({ status: "verified", url: URL_A });

      const [row] = await rowsOf(student.id);
      expect(row.status).toBe("verified");
      // La columna guarda LA URL ENTREGADA; el destino final no se guarda en
      // ninguna columna.
      expect(row.url).toBe(URL_A);
      expect(row.checkedAt).not.toBeNull();
    } finally {
      script.redirects = undefined;
    }
  });
});

// ---------------------------------------------------------------------------
// Filas 47, 45 y 46 — las cotas, EN ESTE ORDEN
// ---------------------------------------------------------------------------

describe("evidencia: las cotas", () => {
  let running: RunningApp;
  let base: string;

  beforeAll(async () => {
    // Aplicación PROPIA: el almacenamiento del throttler es un `Map` en memoria
    // por contenedor, así que compartirla con el bloque de arriba mezclaría los
    // contadores de veintitantas peticiones con las cuentas de aquí.
    running = await startApp(await compileApp());
    base = running.baseUrl;
  });

  afterAll(async () => {
    await stopApp(running?.app);
  });

  // -------------------------------------------------------------------------
  // Fila 47 — va PRIMERA porque comparte el cubo global con la 45
  // -------------------------------------------------------------------------
  it("fila 47: seis GET seguidos son 200 — el GET no hereda la cota del POST", async () => {
    // FALLA SI `@Throttle` ACABÓ EN LA CLASE, que es lo que hace el único
    // precedente del repositorio (`tutor.controller.ts:34-37`): el `GET` se
    // quedaría con los 5/min de las escrituras y la sexta lectura del panel
    // sería un 429.
    const student = await newStudent();

    const codes: number[] = [];
    for (let i = 0; i < EVIDENCE_PER_CREDENTIAL_PER_MINUTE + 1; i++) {
      codes.push((await get(base, student)).status);
    }

    expect(codes.every((code) => code === 200), `códigos: ${codes}`).toBe(true);
  });

  it("fila 47 (hermana): el GET tampoco hereda el cubo GLOBAL de salida", async () => {
    // FALLA SI EL `skipIf` ACOTA POR CLASE Y NO POR HANDLER. `EvidenceController`
    // tiene los dos, y el `generateKey` por defecto incluye el nombre del
    // handler, así que con la clase sola el `GET` recibía su propio cubo
    // `evidence-outbound`: 60/min GLOBAL —entre todos los estudiantes— donde
    // §5.2 promete 120/min por credencial. El eje global acota conexiones
    // SALIENTES y el `GET` no abre ninguna.
    //
    // Es el caso que la mitad de arriba no puede ver: seis peticiones caben de
    // sobra en 60. Hay que pasarse del tope global para que se note.
    const student = await newStudent();

    const codes: number[] = [];
    for (let i = 0; i < EVIDENCE_OUTBOUND_PER_MINUTE + 5; i++) {
      codes.push((await get(base, student)).status);
    }

    expect(codes.every((code) => code === 200), `códigos: ${codes}`).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Fila 45
  // -------------------------------------------------------------------------
  it("fila 45: la sexta entrega del minuto es 429, otra credencial es 200, y el tope global corta la rotación", async () => {
    const student = await newStudent();

    const propias: number[] = [];
    for (let i = 0; i < EVIDENCE_PER_CREDENTIAL_PER_MINUTE; i++) {
      propias.push((await post(base, student, { lessonSlug: "L1", url: URL_A })).status);
    }
    expect(propias.every((code) => code === 200), `códigos: ${propias}`).toBe(true);
    expect((await post(base, student, { lessonSlug: "L1", url: URL_A })).status).toBe(429);

    // Y el cubo es POR CREDENCIAL: el estudiante de al lado no paga la cuota del
    // primero. Si el contador fuera por IP esto sería 429, y en producción un
    // solo estudiante dejaría a la clase entera sin poder entregar.
    const otro = await newStudent();
    expect((await post(base, otro, { lessonSlug: "L1", url: URL_A })).status).toBe(200);

    // LA MITAD QUE IMPORTA. El eje per-credencial NO ES UN TECHO: el login es
    // magic-link con sesión JWT, así que un buzón firmado N veces son N tokens
    // válidos y N cubos, sin coste. Cada credencial de aquí gasta UNA petición,
    // así que un 429 sobre una credencial estrenada solo puede venir del cubo
    // global.
    //
    // Esta mitad falla si el throttler `evidence-outbound` no quedó REGISTRADO
    // en `app.module.ts`, o si le falta su `getTracker` propio — sin él, la
    // precedencia del guard clava el cubo "global" en el hash de credencial otra
    // vez y no puede dispararse nunca (§5.4).
    let cortadoEn = 0;
    for (let i = 0; i < EVIDENCE_OUTBOUND_PER_MINUTE + 5 && cortadoEn === 0; i++) {
      const fresco = await newStudent();
      if ((await post(base, fresco, { lessonSlug: "L1", url: URL_A })).status === 429) {
        cortadoEn = i + 1;
      }
    }

    // Y CORTÓ POR EL CUBO GLOBAL, no por otro: cada credencial de la rotación
    // gastó UNA petición, así que un corte antes de la sexta sería el eje
    // per-credencial disparándose donde no toca, y un corte por encima del tope
    // global querría decir que el cubo no cuenta lo que dice contar.
    expect(cortadoEn, "la rotación de credenciales no encontró nunca el tope global").toBeGreaterThan(
      EVIDENCE_PER_CREDENTIAL_PER_MINUTE
    );
    expect(cortadoEn).toBeLessThanOrEqual(EVIDENCE_OUTBOUND_PER_MINUTE);
  }, 120_000);

  // -------------------------------------------------------------------------
  // Fila 46 — va DESPUÉS de la 45, y ese orden ES la afirmación
  // -------------------------------------------------------------------------
  it("fila 46 (la que NO detecta un skipIf ausente): con el cubo global de evidencia AGOTADO, el turno del tutor sigue llegando a sus 10/min", async () => {
    // El modo de fallo que vigila es el `skipIf` ausente, que acota el servicio
    // ENTERO — turno del tutor, `/v1/access` y webhook de Paddle incluidos.
    //
    // El orden respecto a la fila 45 es load-bearing: sin el cubo de evidencia
    // ya agotado, esta fila no afirma nada.
    const student = await newStudent();

    const codes: number[] = [];
    for (let i = 0; i < TUTOR_TURNS_PER_MINUTE; i++) {
      const response = await fetch(`${base}/v1/tutor/turn`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${student.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ message: "hola" }),
      });
      await response.text();
      codes.push(response.status);
    }

    expect(codes.every((code) => code === 200), `códigos del tutor: ${codes}`).toBe(true);

    // Y el `GET` de acceso, que es otra ruta más y otro cubo más.
    const access = await request(`${base}/v1/access`, {
      headers: { authorization: `Bearer ${student.token}` },
    });
    expect(access.status).toBe(200);
  }, 120_000);

  // -------------------------------------------------------------------------
  // Fila 46 (segunda mitad) — la que DE VERDAD detecta el `skipIf` ausente
  // -------------------------------------------------------------------------
  it("fila 46 (la que SÍ lo detecta): sin `skipIf`, el webhook de Paddle perdería sus 600/min — con él los conserva", async () => {
    // POR QUÉ LA MITAD DE ARRIBA NO BASTA, medido contra
    // `@nestjs/throttler@6`: el `generateKey` por defecto del guard es
    // `sha256(\`${ClassName}-${handlerName}-${throttlerName}-${tracker}\`)`
    // (`throttler.guard.js`), o sea que la CLAVE incluye la ruta. El
    // `getTracker: () => "global"` quita el eje de credencial, no el de ruta:
    // sin `skipIf`, cada handler del servicio recibiría SU PROPIO cubo de
    // 60/min, no uno compartido.
    //
    // La consecuencia es que un endpoint provisionado POR DEBAJO de 60 no puede
    // notar la ausencia: los diez turnos del tutor caben en su cubo de 60 y la
    // mitad de arriba pasaría igual con `skipIf` y sin él (comprobado quitándolo
    // y corriendo la suite). El único punto donde la ausencia SE VE es un
    // endpoint provisionado POR ENCIMA de 60 — y §5.4 nombra exactamente ese:
    // el webhook de Paddle, al que `WEBHOOK_THROTTLE` da 600/min a propósito
    // porque Paddle entrega en ráfaga.
    //
    // La firma es inválida a propósito: lo que se mide es el CONTADOR, que corre
    // en el `APP_GUARD` mucho antes de que nadie verifique un HMAC. Lo único que
    // importa es que ninguna respuesta sea 429.
    const codes = new Set<number>();
    for (let i = 0; i < EVIDENCE_OUTBOUND_PER_MINUTE + 5; i++) {
      const response = await fetch(`${base}/v1/webhooks/paddle`, {
        method: "POST",
        headers: { "content-type": "application/json", "paddle-signature": "ts=1;h1=nada" },
        body: "{}",
      });
      await response.text();
      codes.add(response.status);
    }

    expect([...codes], `el webhook no debería ver un 429 por debajo de 600/min`).not.toContain(429);
  }, 120_000);
});
