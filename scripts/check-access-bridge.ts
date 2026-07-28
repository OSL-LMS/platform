// Comprobaciones del puente de acceso hacia apps/api, lado Next
// (src/lib/api-client.ts y src/app/api/t/route.ts). Se ejecuta con:
//   node scripts/check-access-bridge.ts
//
// Cubre las filas 34-39 y 41 de PRD-003 §9. Todas afirman sobre funciones
// puras a propósito (§9): este runner es Node pelado, no conoce los `paths`
// de tsconfig.json, no transforma JSX y no puede ejecutar `cookies()` de
// next/headers fuera del ámbito de una petición real — por eso api-client.ts
// se parte en la costura que sostiene estas filas (§5.3), y por eso las dos
// verificaciones que SÍ dependen del render manual de /chat viven en §10
// paso 3, no aquí.
import assert from "node:assert/strict";
import http, { type IncomingMessage, type ServerResponse } from "node:http";

import {
  decideTutorTurn,
  fetchAccess,
  fetchAccessTrial,
  resolveClientConfig,
  resolveSessionCookie,
} from "../src/lib/api-client.ts";
import { shouldEmitPageview } from "../src/lib/pixel.ts";

// ---------------------------------------------------------------------------
// Utilidad: servidor HTTP local desechable para las filas 34 y 36.
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) previous[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// Fila 37 — AUTH_COOKIE_NAME fuera del par válido (o ausente) → falla al
// arrancar. Fila 38 — sin API_BASE_URL, resolveClientConfig() lanza.
// ---------------------------------------------------------------------------
withEnv(
  { AUTH_COOKIE_NAME: "algo-que-no-es-una-cookie-de-authjs", API_BASE_URL: "http://localhost:3001" },
  () => {
    assert.throws(() => resolveClientConfig(), /AUTH_COOKIE_NAME/);
  }
);
withEnv({ AUTH_COOKIE_NAME: undefined, API_BASE_URL: "http://localhost:3001" }, () => {
  assert.throws(() => resolveClientConfig(), /AUTH_COOKIE_NAME/, "ausente también debe fallar");
});
withEnv({ AUTH_COOKIE_NAME: "authjs.session-token", API_BASE_URL: undefined }, () => {
  assert.throws(() => resolveClientConfig(), /API_BASE_URL/);
});
withEnv(
  { AUTH_COOKIE_NAME: "__Secure-authjs.session-token", API_BASE_URL: "http://localhost:3001", ACCESS_TIMEOUT_MS: undefined },
  () => {
    const config = resolveClientConfig();
    assert.equal(config.authCookieName, "__Secure-authjs.session-token");
    assert.equal(config.apiBaseUrl, "http://localhost:3001");
    assert.equal(config.accessTimeoutMs, 2000, "por defecto 2000ms si se omite ACCESS_TIMEOUT_MS");
  }
);

// ---------------------------------------------------------------------------
// Fila 35 — el resolutor de cookie falla ruidosamente en sus dos casos.
// ---------------------------------------------------------------------------
{
  // (a) Cookie troceada: lanza en vez de enviar un token truncado.
  const chunkedJar = new Map([["authjs.session-token.0", "primer-trozo"]]);
  assert.throws(() => resolveSessionCookie(chunkedJar, "authjs.session-token"));

  // (b) Nombre resuelto ≠ configurado: registra y devuelve {error:true} — SIN
  // lanzar, porque "nunca lanza" es lo que sostiene la política de §5.3.
  const mismatchJar = new Map([["__Secure-authjs.session-token", "un-token"]]);
  const originalConsoleError = console.error;
  let loggedCount = 0;
  console.error = () => {
    loggedCount++;
  };
  let mismatchResult: unknown;
  try {
    mismatchResult = resolveSessionCookie(mismatchJar, "authjs.session-token");
  } finally {
    console.error = originalConsoleError;
  }
  assert.deepEqual(mismatchResult, { error: true });
  assert.equal(loggedCount, 1, "debía registrar ruidosamente el desajuste");

  // Caso feliz: el nombre resuelto coincide con el configurado.
  const okJar = new Map([["authjs.session-token", "tok-123"]]);
  assert.equal(resolveSessionCookie(okJar, "authjs.session-token"), "tok-123");

  // §5.1: se prueba el prefijo __Secure- PRIMERO. Con las dos cookies
  // presentes a la vez, gana __Secure- aunque la plana aparezca "antes" en
  // cómo se insertó el mapa.
  const bothJar = new Map([
    ["authjs.session-token", "token-plano"],
    ["__Secure-authjs.session-token", "token-secure"],
  ]);
  assert.equal(
    resolveSessionCookie(bothJar, "__Secure-authjs.session-token"),
    "token-secure",
    "debía preferir __Secure- sobre la cookie plana"
  );

  // Sin cookie de sesión en absoluto: {error:true}, sin lanzar.
  assert.deepEqual(resolveSessionCookie(new Map(), "authjs.session-token"), { error: true });
}

// ---------------------------------------------------------------------------
// Fila 39 — sin ANALYTICS_SALT no se emite (shouldEmitPageview()).
// ---------------------------------------------------------------------------
{
  assert.equal(shouldEmitPageview(undefined), false);
  assert.equal(shouldEmitPageview(""), false, "una sal vacía también debe fallar cerrado");
  assert.equal(shouldEmitPageview("una-sal-de-verdad"), true);
}

// ---------------------------------------------------------------------------
// Fila 41 — con {error:true}, el turno del tutor da 503 y no emite
// (decideTutorTurn(), extraída junto a fetchAccess).
// ---------------------------------------------------------------------------
{
  assert.deepEqual(decideTutorTurn({ error: true }), { ok: false, status: 503 });
  assert.deepEqual(
    decideTutorTurn({ allowed: false, status: "canceled", trialDaysLeft: 0 }),
    { ok: false, status: 403 }
  );
  const okAccess = { allowed: true, status: "trial", trialDaysLeft: 5 } as const;
  assert.deepEqual(decideTutorTurn(okAccess), { ok: true, access: okAccess });
}

// ---------------------------------------------------------------------------
// Fila 34 — el timeout está cableado al fetch. Un servidor que ACEPTA la
// conexión y nunca responde debe degradar cerca de ACCESS_TIMEOUT_MS. Un
// servicio apagado (conexión rechazada) debe resolver mucho antes: es la
// distinción que esta fila existe para probar.
// ---------------------------------------------------------------------------
await (async () => {
  process.env.ACCESS_TIMEOUT_MS = "200";
  try {
    await withServer(
      () => {
        // A propósito: ni res.write() ni res.end(). El socket queda abierto.
      },
      async (baseUrl) => {
        const start = Date.now();
        const result = await fetchAccess("token-valido", baseUrl);
        const elapsed = Date.now() - start;
        assert.deepEqual(result, { error: true });
        assert.ok(elapsed < 1000, `debía degradar cerca de los 200ms, tardó ${elapsed}ms`);
        assert.ok(
          elapsed >= 150,
          `no debía resolver antes del timeout (tardó ${elapsed}ms) — sería indicio de conexión rechazada, no de timeout real`
        );
      }
    );

    // Contraste: puerto cerrado (nadie escucha) → conexión rechazada de
    // inmediato, muy por debajo del timeout.
    const closedPort = await new Promise<number>((resolve) => {
      const probe = http.createServer();
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        const port = typeof address === "object" && address ? address.port : 0;
        probe.close(() => resolve(port));
      });
    });
    const start = Date.now();
    const refused = await fetchAccess("token-valido", `http://127.0.0.1:${closedPort}`);
    const elapsed = Date.now() - start;
    assert.deepEqual(refused, { error: true });
    assert.ok(
      elapsed < 150,
      `un servicio apagado debía resolver muy por debajo del timeout, tardó ${elapsed}ms`
    );
  } finally {
    delete process.env.ACCESS_TIMEOUT_MS;
  }
})();

// ---------------------------------------------------------------------------
// Fila 36 — solo un 200 válido produce un Access. Tabulado: 200 válido →
// Access; 200 malformado, 400, 401, 404, 413, 5xx y JSON no parseable →
// {error:true}. El caso a servir viaja en el propio Bearer para no tocar la
// firma pública de fetchAccess().
// ---------------------------------------------------------------------------
await (async () => {
  const validAccess = { allowed: true, status: "trial", trialDaysLeft: 3 } as const;

  await withServer(
    (req, res) => {
      const kind = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      switch (kind) {
        case "valid":
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(validAccess));
          return;
        case "malformed":
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        case "badjson":
          res.writeHead(200, { "content-type": "application/json" });
          res.end("{esto no es json");
          return;
        case "400":
          res.writeHead(400);
          res.end("bad request");
          return;
        case "401":
          res.writeHead(401);
          res.end("unauthorized");
          return;
        case "404":
          res.writeHead(404);
          res.end("not found");
          return;
        case "413":
          res.writeHead(413);
          res.end("payload too large");
          return;
        case "500":
          res.writeHead(500);
          res.end("internal error");
          return;
        default:
          res.writeHead(500);
          res.end();
      }
    },
    async (baseUrl) => {
      assert.deepEqual(await fetchAccess("valid", baseUrl), validAccess);
      for (const kind of ["malformed", "badjson", "400", "401", "404", "413", "500"]) {
        const result = await fetchAccess(kind, baseUrl);
        assert.deepEqual(result, { error: true }, `caso "${kind}" debía degradar a {error:true}`);
      }
    }
  );

  // fetchAccessTrial() comparte el mismo mapeo; solo cambia método y ruta.
  await withServer(
    (req, res) => {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/v1/access/trial");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(validAccess));
    },
    async (baseUrl) => {
      assert.deepEqual(await fetchAccessTrial("valid", baseUrl), validAccess);
    }
  );

  // Un token que no sea string (p. ej. {error:true} de readSessionToken())
  // nunca llega a hacer la petición.
  assert.deepEqual(await fetchAccess({ error: true }, "http://127.0.0.1:1"), { error: true });
})();

console.log(
  "check-access-bridge: OK — filas 34-39 y 41 de PRD-003 §9 cubiertas."
);
