// Comprobaciones del puente de evidencia hacia apps/api (src/lib/api-client.ts)
// y de las decisiones puras del panel (src/lib/evidence-panel.ts). Se ejecuta
// con:
//   node scripts/check-evidence-bridge.ts
//
// Cubre las filas 61, 62, 63 y 64 de PRD-007 §9.
//
// Las tres primeras SÍ ejercitan el código real contra servidores HTTP locales
// desechables, porque son exactamente los fallos que un test con dobles no
// vería: aceptar un 201 como si fuera un 200, colgarse sin timeout, o empezar a
// copiar cabeceras de entrada. La cuarta prueba el módulo puro —NO
// chat-client.tsx, que no tiene runner de componentes en este repositorio y se
// verifica a mano en §10 paso 7—; es el mismo reparto que tutor-turn.ts ↔
// check-tutor-turn.ts, que también mezcla el puente con un módulo puro.
import assert from "node:assert/strict";
import http, { type IncomingMessage, type ServerResponse } from "node:http";

// Sólo tipos, y por ruta relativa CON extensión: `scripts/` está excluido del
// tsconfig de esta app y Node no conoce sus `paths`, así que el alias `@shared`
// no significa nada aquí. Al ser `import type` se borra al ejecutar.
import type { EvidenceItem } from "../../../packages/shared/src/evidence.ts";
import type { EvidenceLoad } from "../src/lib/evidence-panel.ts";

// api-client.ts valida su configuración AL IMPORTARSE (PRD-003 goal 5), así que
// las dos variables obligatorias tienen que existir ANTES del import. El import
// es dinámico porque los estáticos se izan por encima de estas asignaciones. Los
// valores son de relleno: las dos funciones reciben baseUrl y timeoutMs como
// argumentos y nunca los releen del entorno (§5.3).
process.env.AUTH_COOKIE_NAME ??= "authjs.session-token";
process.env.API_BASE_URL ??= "http://127.0.0.1:1";

const { EVIDENCE_BRIDGE_TIMEOUT_MS, fetchEvidence, submitEvidence } = await import(
  "../src/lib/api-client.ts"
);
const { applySubmission, checkEvidenceUrl, decideEvidencePanel, findSubmission } = await import(
  "../src/lib/evidence-panel.ts"
);

const BODY = JSON.stringify({ lessonSlug: "L1", url: "https://ana.example.com/mi-web" });

// Fixtures con hosts de documentación (RFC 2606) y URLs sintéticas: §8.5
// prohíbe dato de estudiante en fixtures, y este repositorio es público.
const VERIFIED: EvidenceItem = {
  lessonSlug: "L1",
  url: "https://ana.example.com/mi-web",
  status: "verified",
  checkedAt: "2026-07-31T18:22:41.000Z",
  failureReason: null,
};

const FAILED: EvidenceItem = {
  lessonSlug: "L3",
  url: "https://ana.example.com/reto-3",
  status: "failed",
  checkedAt: "2026-07-31T18:30:02.000Z",
  failureReason: "http_404",
};

const DECLARED: EvidenceItem = {
  lessonSlug: "L5",
  url: "https://ana.example.com/repo",
  status: "declared",
  checkedAt: null,
  failureReason: null,
};

// ---------------------------------------------------------------------------
// Utilidad: servidor HTTP local desechable, igual que en check-access-bridge.ts.
// ---------------------------------------------------------------------------
async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  fn: (baseUrl: string) => Promise<void>
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// Fila 61 — REGLA POSITIVA: sólo un 200 con la forma esperada produce un
// resultado; todo lo demás, sin excepción, es {error:true}. El caso a servir
// viaja en el propio Bearer para no tocar la firma pública de las dos funciones.
// ---------------------------------------------------------------------------
await (async () => {
  const TEST_TIMEOUT_MS = 2000;

  await withServer(
    (req, res) => {
      const kind = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      switch (kind) {
        case "verified":
          return json(res, 200, VERIFIED);
        case "failed":
          return json(res, 200, FAILED);
        case "declared":
          return json(res, 200, DECLARED);
        // Un 201 con cuerpo VÁLIDO: es el fallo que `@HttpCode(HttpStatus.OK)`
        // existe para evitar en el otro lado (§5.1), y aquí no puede colarse
        // como éxito.
        case "201":
          return json(res, 201, VERIFIED);
        case "malformed":
          return json(res, 200, { ok: true });
        // 200 con un `status` fuera del enum de §6.1: forma equivocada.
        case "badstatus":
          return json(res, 200, { ...VERIFIED, status: "pendiente" });
        // 200 al que le falta `checkedAt`: no es un EvidenceItem.
        case "partial":
          return json(res, 200, { lessonSlug: "L1", url: "https://a.example.com/", status: "verified" });
        case "badjson":
          res.writeHead(200, { "content-type": "application/json" });
          return void res.end("{esto no es json");
        case "empty":
          res.writeHead(200);
          return void res.end();
        case "redirect":
          res.writeHead(302, { location: "https://otro.example.com/" });
          return void res.end();
        default: {
          // "400", "401", "404", "409", "413", "429", "500", "503": el cuerpo de
          // error de apps/api es un OBJETO (§5.1) y aun así no produce resultado.
          const status = Number(kind);
          if (Number.isInteger(status)) {
            return json(res, status, { error: "lesson_accepts_no_evidence" });
          }
          res.writeHead(500);
          return void res.end();
        }
      }
    },
    async (baseUrl) => {
      // El único camino que produce resultado: 200 + forma.
      assert.deepEqual(
        await submitEvidence("verified", BODY, baseUrl, TEST_TIMEOUT_MS),
        VERIFIED
      );

      // UN `failed` NO ES UN FALLO DE ESTE PUENTE. Llega con 200 y forma
      // válida, así que viaja como resultado: que la comprobación no cuadre es
      // un estado de la fila, no un error de la petición (goal 4). Confundirlos
      // haría que el panel pintase "no se pudo guardar" sobre una entrega que
      // sí quedó guardada.
      assert.deepEqual(
        await submitEvidence("failed", BODY, baseUrl, TEST_TIMEOUT_MS),
        FAILED
      );
      assert.deepEqual(
        await submitEvidence("declared", BODY, baseUrl, TEST_TIMEOUT_MS),
        DECLARED
      );

      for (const kind of [
        "201",
        "malformed",
        "badstatus",
        "partial",
        "badjson",
        "empty",
        "redirect",
        "400",
        "401",
        "404",
        "409",
        "413",
        "429",
        "500",
        "503",
      ]) {
        assert.deepEqual(
          await submitEvidence(kind, BODY, baseUrl, TEST_TIMEOUT_MS),
          { error: true },
          `POST caso "${kind}" debía degradar a {error:true}`
        );
      }

      // Un token que no sea string (p. ej. {error:true} de readSessionToken())
      // nunca llega a hacer la petición.
      assert.deepEqual(
        await submitEvidence({ error: true }, BODY, baseUrl, TEST_TIMEOUT_MS),
        { error: true }
      );
      assert.deepEqual(await fetchEvidence({ error: true }, baseUrl, TEST_TIMEOUT_MS), {
        error: true,
      });
    }
  );

  // El GET tiene su propia forma —`{items: [...]}`— y su propia regla positiva:
  // una lista con UN elemento malformado no se sirve a medias.
  await withServer(
    (req, res) => {
      const kind = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      switch (kind) {
        case "two":
          return json(res, 200, { items: [VERIFIED, FAILED] });
        case "none":
          return json(res, 200, { items: [] });
        case "notarray":
          return json(res, 200, { items: VERIFIED });
        case "nokey":
          return json(res, 200, {});
        case "onebad":
          return json(res, 200, { items: [VERIFIED, { lessonSlug: "L9" }] });
        default:
          res.writeHead(503);
          return void res.end();
      }
    },
    async (baseUrl) => {
      assert.deepEqual(await fetchEvidence("two", baseUrl, TEST_TIMEOUT_MS), {
        items: [VERIFIED, FAILED],
      });
      assert.deepEqual(await fetchEvidence("none", baseUrl, TEST_TIMEOUT_MS), { items: [] });
      for (const kind of ["notarray", "nokey", "onebad", "503"]) {
        assert.deepEqual(
          await fetchEvidence(kind, baseUrl, TEST_TIMEOUT_MS),
          { error: true },
          `GET caso "${kind}" debía degradar a {error:true}`
        );
      }
    }
  );
})();

// ---------------------------------------------------------------------------
// Fila 62 — el timeout está cableado al fetch: un apps/api que ACEPTA la
// conexión y nunca responde degrada, nunca lanza y nunca cuelga. Contraste con
// un servicio apagado, que resuelve mucho antes: es la distinción que esta fila
// existe para probar.
// ---------------------------------------------------------------------------
await (async () => {
  const TEST_TIMEOUT_MS = 200;

  // El valor de producción es otro y vive donde §5.4 lo pone; aquí se afirma
  // que existe y que está por encima del presupuesto total de la comprobación
  // en apps/api (EVIDENCE_TIMEOUT_MS = 3000), porque el margen es lo que evita
  // que un `failed` legítimo llegue al estudiante como un 503 del proxy.
  assert.equal(EVIDENCE_BRIDGE_TIMEOUT_MS, 6000);
  assert.ok(EVIDENCE_BRIDGE_TIMEOUT_MS > 3000);

  await withServer(
    () => {
      // A propósito: ni res.write() ni res.end(). El socket queda abierto.
    },
    async (baseUrl) => {
      for (const [label, call] of [
        ["POST", () => submitEvidence("t", BODY, baseUrl, TEST_TIMEOUT_MS)],
        ["GET", () => fetchEvidence("t", baseUrl, TEST_TIMEOUT_MS)],
      ] as const) {
        const start = Date.now();
        const result = await call();
        const elapsed = Date.now() - start;
        assert.deepEqual(result, { error: true }, `${label} debía degradar sin lanzar`);
        assert.ok(elapsed < 1000, `${label} debía degradar cerca de los 200ms, tardó ${elapsed}ms`);
        assert.ok(
          elapsed >= 150,
          `${label} no debía resolver antes del timeout (tardó ${elapsed}ms) — sería indicio ` +
            "de conexión rechazada, no de timeout real"
        );
      }
    }
  );

  // Contraste: puerto cerrado (nadie escucha) → conexión rechazada de inmediato,
  // muy por debajo del timeout, y también sin lanzar.
  const closedPort = await new Promise<number>((resolve) => {
    const probe = http.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
  const start = Date.now();
  const refused = await submitEvidence(
    "t",
    BODY,
    `http://127.0.0.1:${closedPort}`,
    TEST_TIMEOUT_MS
  );
  const elapsed = Date.now() - start;
  assert.deepEqual(refused, { error: true });
  assert.ok(
    elapsed < 150,
    `un servicio apagado debía resolver muy por debajo del timeout, tardó ${elapsed}ms`
  );
})();

// ---------------------------------------------------------------------------
// Fila 63 — LAS CABECERAS SE CONSTRUYEN. Lleva Authorization y Content-Type, y
// NO lleva Cookie: la cookie tendría precedencia sobre el Bearer dentro de
// getToken() (segundo canal de credencial no declarado) y un X-Forwarded-For del
// cliente llegaría a un servicio con `trust proxy` puesto (§5.3, §8.2). Es la
// fila que se pone roja el día que alguien empiece a esparcir las cabeceras
// entrantes "para dejar pasar una traza".
// ---------------------------------------------------------------------------
await (async () => {
  const TEST_TIMEOUT_MS = 2000;
  const seen: Array<{ method: string; headers: IncomingMessage["headers"]; body: string }> = [];

  await withServer(
    (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push({
          method: req.method ?? "",
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        json(res, 200, req.method === "GET" ? { items: [] } : VERIFIED);
      });
    },
    async (baseUrl) => {
      await submitEvidence("tok-post", BODY, baseUrl, TEST_TIMEOUT_MS);
      await fetchEvidence("tok-get", baseUrl, TEST_TIMEOUT_MS);
    }
  );

  assert.equal(seen.length, 2);
  const [post, get] = seen;

  assert.equal(post.method, "POST");
  assert.equal(post.headers.authorization, "Bearer tok-post");
  assert.equal(post.headers["content-type"], "application/json");
  // El cuerpo se reenvía TAL CUAL: la validación de forma es de evidence.dto.ts
  // (§5.1) y su 400 es exactamente lo que el otro lado tiene que decidir.
  assert.equal(post.body, BODY);

  assert.equal(get.method, "GET");
  assert.equal(get.headers.authorization, "Bearer tok-get");

  for (const [label, req] of [
    ["POST", post],
    ["GET", get],
  ] as const) {
    assert.equal(req.headers.cookie, undefined, `${label} no debía reenviar la cabecera Cookie`);
    assert.equal(
      req.headers["x-forwarded-for"],
      undefined,
      `${label} no debía reenviar el X-Forwarded-For del cliente`
    );
  }
})();

// ---------------------------------------------------------------------------
// Fila 64 — UN `failed` NO SE PINTA COMO ERROR.
//
// Es lo único automático que impide la regresión de copiar la caja roja
// `role="alert"` de chat-client.tsx:241-245 (§4.3). Prueba la DECISIÓN, que es
// lo que evidence-panel.ts existe para poder probar; que chat-client.tsx la
// renderice en vez de escribir un `role="alert"` a mano es el paso 7 de §10, a
// mano y obligatorio.
// ---------------------------------------------------------------------------
{
  const LESSON = { slug: "L3", evidenceKind: "url", evidencePrompt: "Pega la dirección." };
  const READY: EvidenceLoad = { phase: "ready", items: [FAILED] };

  const view = decideEvidencePanel({
    lesson: LESSON,
    load: READY,
    submitting: false,
    submitFailed: false,
  });

  assert.ok(view.visible, "una lección con evidenceKind y estado leído tiene panel");
  assert.equal(view.submittedUrl, FAILED.url, "la URL guardada se sigue mostrando");
  assert.ok(view.status, "un `failed` lleva su línea accionable");

  // Las tres afirmaciones que son la fila entera.
  assert.equal(
    view.status.role,
    "status",
    'un `failed` se anuncia por role="status" (aria-live polite), NUNCA por role="alert": ' +
      "ese rol es el del error del tutor y es lo que arrastra la lectura de castigo"
  );
  assert.notEqual(view.status.role, "alert");
  assert.equal(
    view.status.tone,
    "neutral",
    "el tratamiento es neutro, no de error: el estado es de la comprobación, no del estudiante"
  );
  assert.ok(
    !/error/i.test(view.status.text),
    `la línea de un \`failed\` no puede llevar la palabra "error" (§4.3): "${view.status.text}"`
  );
  // Y es ACCIONABLE: dice qué hacer, no sólo que algo no salió.
  assert.ok(/reenv/i.test(view.status.text), "la línea tiene que decir que puede reenviar");

  // El resto de la tabla de §4.3, de arriba abajo.
  {
    // Lección sin `evidenceKind` → no hay panel. Su ausencia ES la declaración
    // de "esta lección no pide evidencia" (§6.4).
    assert.deepEqual(
      decideEvidencePanel({
        lesson: { slug: "L9" },
        load: READY,
        submitting: false,
        submitFailed: false,
      }),
      { visible: false }
    );
    // Sin lección seleccionada (rama sin sesión) tampoco.
    assert.deepEqual(
      decideEvidencePanel({ load: READY, submitting: false, submitFailed: false }),
      { visible: false }
    );

    // GET de montaje EN VUELO → el panel no se pinta todavía. No hay esqueleto:
    // aparecer y saltar es peor que aparecer una vez.
    assert.deepEqual(
      decideEvidencePanel({
        lesson: LESSON,
        load: { phase: "loading" },
        submitting: false,
        submitFailed: false,
      }),
      { visible: false }
    );

    // Sin entrega → el prompt del currículo, y ninguna línea de estado.
    const pristine = decideEvidencePanel({
      lesson: LESSON,
      load: { phase: "ready", items: [] },
      submitting: false,
      submitFailed: false,
    });
    assert.ok(pristine.visible);
    assert.equal(pristine.prompt, LESSON.evidencePrompt);
    assert.equal(pristine.submittedUrl, null);
    assert.equal(pristine.status, null);
    assert.equal(pristine.submitDisabled, false);

    // Una lección que pide evidencia pero no declara `evidencePrompt`: las dos
    // llaves son independientes (§6.4), así que el panel sabe pedir algo igual.
    const noPrompt = decideEvidencePanel({
      lesson: { slug: "L4", evidenceKind: "url" },
      load: { phase: "ready", items: [] },
      submitting: false,
      submitFailed: false,
    });
    assert.ok(noPrompt.visible);
    assert.ok(noPrompt.prompt.length > 0);

    // `declared` → sin adorno de éxito ni de fallo.
    const declared = decideEvidencePanel({
      lesson: { slug: DECLARED.lessonSlug, evidenceKind: "url" },
      load: { phase: "ready", items: [DECLARED] },
      submitting: false,
      submitFailed: false,
    });
    assert.ok(declared.visible && declared.status);
    assert.equal(declared.status.tone, "neutral");
    assert.equal(declared.status.role, "status");
    assert.ok(!/error/i.test(declared.status.text));

    // `verified` → marca afirmativa junto a la URL.
    const verified = decideEvidencePanel({
      lesson: { slug: VERIFIED.lessonSlug, evidenceKind: "url" },
      load: { phase: "ready", items: [VERIFIED] },
      submitting: false,
      submitFailed: false,
    });
    assert.ok(verified.visible && verified.status);
    assert.equal(verified.status.tone, "affirmative");
    assert.equal(verified.status.role, "status");
    assert.equal(verified.submittedUrl, VERIFIED.url);

    // Comprobación EN VUELO → el control de envío deshabilitado. Es el guarda de
    // doble envío: el viaje dura hasta EVIDENCE_BRIDGE_TIMEOUT_MS, y un segundo
    // envío durante esa ventana es justo lo que el CAS de §5.5 tiene que
    // descartar en el otro lado.
    const inFlight = decideEvidencePanel({
      lesson: LESSON,
      load: READY,
      submitting: true,
      submitFailed: false,
    });
    assert.ok(inFlight.visible && inFlight.status);
    assert.equal(inFlight.submitDisabled, true);
    assert.equal(inFlight.status.role, "status");
    assert.equal(inFlight.status.tone, "neutral");

    // GET de montaje FALLIDO → el panel se pinta en estado "sin entrega", con
    // una línea que dice que no se pudo leer el estado anterior, y NUNCA
    // bloquea la entrega.
    const unavailable = decideEvidencePanel({
      lesson: LESSON,
      load: { phase: "unavailable", items: [] },
      submitting: false,
      submitFailed: false,
    });
    assert.ok(unavailable.visible && unavailable.status);
    assert.equal(unavailable.submitDisabled, false, "un estado ilegible no puede bloquear la entrega");
    assert.equal(unavailable.status.role, "status");
    assert.equal(unavailable.status.tone, "neutral");
    assert.ok(!/error/i.test(unavailable.status.text));

    // El envío que no aterrizó (§4.2, última fila: el proxy devolvió 503) tiene
    // su PROPIA línea, distinta de la de un `failed`: una dice que no se pudo
    // guardar, la otra que se guardó y no se pudo comprobar. Confundirlas le
    // diría al estudiante que revise una URL que nadie llegó a mirar.
    const notSaved = decideEvidencePanel({
      lesson: LESSON,
      load: READY,
      submitting: false,
      submitFailed: true,
    });
    assert.ok(notSaved.visible && notSaved.status);
    assert.notEqual(notSaved.status.text, view.status.text);
    assert.equal(notSaved.status.role, "status");
    assert.equal(notSaved.status.tone, "neutral");
    assert.ok(!/error/i.test(notSaved.status.text));
  }

  // findSubmission / applySubmission: la fila de una lección es UNA (la llave de
  // §6.1 es `(usuario, lección)`), así que reenviar reemplaza y nunca duplica.
  {
    const load: EvidenceLoad = { phase: "ready", items: [VERIFIED, FAILED] };
    assert.deepEqual(findSubmission(load, FAILED.lessonSlug), FAILED);
    assert.equal(findSubmission(load, "L404"), null);
    assert.equal(findSubmission({ phase: "loading" }, FAILED.lessonSlug), null);

    const resubmitted = { ...FAILED, status: "verified", failureReason: null } as EvidenceItem;
    const after = applySubmission(load, resubmitted);
    assert.equal(after.phase, "ready");
    assert.equal(
      after.items.filter((i) => i.lessonSlug === FAILED.lessonSlug).length,
      1,
      "reenviar reemplaza la fila de esa lección, no añade otra"
    );
    assert.deepEqual(findSubmission(after, FAILED.lessonSlug), resubmitted);

    // Una lectura de montaje fallida se QUEDA `unavailable` aunque una entrega
    // sí aterrice: lo que no se pudo leer sigue sin leerse, y ascender a `ready`
    // pintaría las demás lecciones como "sin entrega" sobre una lista que nunca
    // llegó. La entrega recién hecha sí es conocimiento firme y se conserva.
    const afterFailedLoad = applySubmission({ phase: "unavailable", items: [] }, VERIFIED);
    assert.equal(afterFailedLoad.phase, "unavailable");
    assert.deepEqual(findSubmission(afterFailedLoad, VERIFIED.lessonSlug), VERIFIED);

    // Y con esa fila conocida, el panel de ESA lección muestra su estado en vez
    // de la línea de "no pudimos leer".
    const recovered = decideEvidencePanel({
      lesson: { slug: VERIFIED.lessonSlug, evidenceKind: "url" },
      load: afterFailedLoad,
      submitting: false,
      submitFailed: false,
    });
    assert.ok(recovered.visible && recovered.status);
    assert.equal(recovered.status.tone, "affirmative");
  }

  // Fila 64b — la comprobación de forma, antes de salir del navegador.
  //
  // Existe porque la regla positiva del puente (§5.3) convierte el 400 del
  // ValidationPipe en el mismo `{error:true}` que un 503, y por tanto en
  // "reinténtalo en un momento" — que para un esquema equivocado es falso:
  // reintentar igual falla igual. §5.1 dejó el hueco declarado.
  {
    assert.deepEqual(checkEvidenceUrl("https://ana.github.io/mi-web"), { ok: true });
    // El parser WHATWG borra el puerto por defecto, así que :443 es "" (§5.1).
    assert.deepEqual(checkEvidenceUrl("https://ana.github.io:443/"), { ok: true });

    for (const bad of ["http://ana.github.io/", "ftp://ana.github.io/"]) {
      const verdict = checkEvidenceUrl(bad);
      assert.equal(verdict.ok, false, `${bad} debería rechazarse`);
      assert.ok(!verdict.ok && /https:\/\//.test(verdict.text), "el mensaje dice qué hacer");
    }

    const port = checkEvidenceUrl("https://ana.github.io:8443/");
    assert.equal(port.ok, false);

    const garbage = checkEvidenceUrl("ana.github.io");
    assert.equal(garbage.ok, false);

    // Y el mensaje sale POR EL MISMO SITIO que los demás, con el mismo
    // tratamiento: si se pintara aparte, la garantía de la fila 64 —neutro,
    // `role="status"`, sin la palabra "error"— dejaría de cubrirlo.
    const shaped = decideEvidencePanel({
      lesson: { slug: "L1", evidenceKind: "url" },
      load: { phase: "ready", items: [] },
      submitting: false,
      submitFailed: false,
      shapeError: "La dirección tiene que empezar por https:// para poder comprobarla.",
    });
    assert.ok(shaped.visible && shaped.status);
    assert.equal(shaped.status.role, "status");
    assert.notEqual(shaped.status.role, "alert");
    assert.equal(shaped.status.tone, "neutral");
    assert.ok(!/error/i.test(shaped.status.text), "la línea no dice 'error'");

    // Precedencia: la forma manda sobre `submitFailed`. Si no hubo viaje, decir
    // "reinténtalo" sería exactamente el mensaje falso que esto cierra.
    const both = decideEvidencePanel({
      lesson: { slug: "L1", evidenceKind: "url" },
      load: { phase: "ready", items: [] },
      submitting: false,
      submitFailed: true,
      shapeError: "La dirección tiene que empezar por https:// para poder comprobarla.",
    });
    assert.ok(both.visible && both.status);
    assert.ok(/https:\/\//.test(both.status.text), "gana la línea de forma, no la de reintento");
  }
}

console.log(
  "check-evidence-bridge: OK — filas 61, 62, 63 y 64 (con 64b) de PRD-007 §9 cubiertas."
);
