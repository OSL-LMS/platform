// Comprobaciones del turno del tutor, lado raíz: el proxy de src/lib/api-client.ts
// (streamTutorTurn) y las decisiones puras de src/lib/tutor-turn.ts. Se ejecuta con:
//   node scripts/check-tutor-turn.ts
//
// Cubre las filas 32, 33, 34, 35, 35b, 35c, 36, 37 y 38 de PRD-005 §9.
//
// Por qué aquí y no en un runner de componentes: no hay ninguno (§9, §11 punto
// 4). Las filas del cliente (36-38) prueban el módulo puro donde se extraen el
// cuerpo saliente, el mapeo de estados y la decisión de qué conservar al fallar
// —NO chat-client.tsx, que se verifica a mano en §10 paso B—; es el mismo
// reparto que format-message.ts ↔ check-format-message.ts.
//
// Las filas del proxy (32-35c) SÍ ejercitan el código real contra servidores
// HTTP locales desechables, porque son exactamente los fallos que un test
// unitario con dobles no vería: bufferizar el cuerpo, abortar después de las
// cabeceras, copiar cabeceras entrantes, seguir un 3xx y no propagar la
// cancelación.
import assert from "node:assert/strict";
import http, { type IncomingMessage, type ServerResponse } from "node:http";

// api-client.ts valida su configuración AL IMPORTARSE (PRD-003 goal 5), así que
// las dos variables obligatorias tienen que existir ANTES del import. El import
// es dinámico porque los estáticos se izan por encima de estas asignaciones.
// Los valores son de relleno: streamTutorTurn recibe baseUrl y timeoutMs como
// argumentos, nunca los relee del entorno (§5.3).
process.env.AUTH_COOKIE_NAME ??= "authjs.session-token";
process.env.API_BASE_URL ??= "http://127.0.0.1:1";

const { streamTutorTurn } = await import("../src/lib/api-client.ts");
const {
  TUTOR_MESSAGE_MAX_LENGTH,
  buildTurnBody,
  decideTurnFailure,
  tutorErrorMessage,
} = await import("../src/lib/tutor-turn.ts");

const BODY = JSON.stringify({ message: "hola", lesson: "L1" });

// ---------------------------------------------------------------------------
// Utilidades: servidor HTTP local desechable y un diferido para esperar eventos.
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

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function asResponse(result: Response | { error: true }): Response {
  assert.ok(!("error" in result), "esperaba una respuesta, no una degradación");
  return result as Response;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Fila 32 — el proxy NO bufferiza. El cuerpo se devuelve por identidad, sin
// releerlo: contra un servidor que emite dos chunks con una espera REAL entre
// ellos, el consumidor recibe dos lecturas Y MIDE ENTRE ELLAS un intervalo
// comparable a esa espera.
//
// La aserción es sobre el INTERVALO, no sobre el número de lecturas: un buffer
// rápido también puede producir dos lecturas, así que contar no distingue nada.
// Es la fila que separa el proxy del buffer, y el fallo que ningún test
// unitario vería de otra forma — el tutor "funcionaría", solo que sin streaming.
// ---------------------------------------------------------------------------
const GAP_MS = 300;
await withServer(
  (_req, res) => {
    res.socket?.setNoDelay(true);
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.write("primer-chunk");
    setTimeout(() => {
      res.write("segundo-chunk");
      res.end();
    }, GAP_MS);
  },
  async (baseUrl) => {
    const result = await streamTutorTurn("tok", BODY, { baseUrl, timeoutMs: 5000 });
    const res = asResponse(result);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(res.headers.get("cache-control"), "no-store");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const reads: { at: number; text: string }[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      reads.push({ at: performance.now(), text: decoder.decode(value, { stream: true }) });
    }

    assert.ok(reads.length >= 2, `esperaba ≥2 lecturas, hubo ${reads.length}`);
    const interval = reads[1].at - reads[0].at;
    assert.ok(
      interval >= GAP_MS * 0.6,
      `entre la primera y la segunda lectura pasaron ${Math.round(interval)}ms; ` +
        `con una espera real de ${GAP_MS}ms eso significa que el cuerpo se ` +
        "bufferizó (await res.text(), un ReadableStream intermedio o un " +
        "TextDecoder en medio) y el estudiante recibe la respuesta de golpe"
    );
    assert.equal(reads.map((r) => r.text).join(""), "primer-chunksegundo-chunk");
  }
);

// ---------------------------------------------------------------------------
// Fila 33 — el timeout es DE CABECERAS, no de stream.
//
// (a) Un upstream que tarda 500ms en la PRIMERA CABECERA con timeoutMs=200 →
//     {error:true} → 503.
// (b) Un upstream que responde cabeceras en 50ms y sigue emitiendo durante 2s
//     con el mismo timeoutMs=200 → EL CUERPO LLEGA ENTERO.
//
// (b) es la que importa: copiar el `AbortSignal.timeout` de fetchAccess cortaría
// todo turno real a media frase, sin error visible, porque abortar tras las
// cabeceras rompe el cuerpo a media lectura.
// ---------------------------------------------------------------------------
const TIMEOUT_MS = 200;

await withServer(
  (_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("tarde");
    }, 500);
  },
  async (baseUrl) => {
    const started = performance.now();
    const result = await streamTutorTurn("tok", BODY, { baseUrl, timeoutMs: TIMEOUT_MS });
    const elapsed = performance.now() - started;
    assert.deepEqual(result, { error: true }, "cabeceras tardías debían degradar");
    assert.ok(
      elapsed < 450,
      `debía cortar cerca de los ${TIMEOUT_MS}ms, tardó ${Math.round(elapsed)}ms`
    );
    assert.ok(
      elapsed >= TIMEOUT_MS * 0.75,
      `no debía resolver antes del timeout (tardó ${Math.round(elapsed)}ms)`
    );
  }
);

const SLOW_STREAM_CHUNKS = 8;
const SLOW_STREAM_STEP_MS = 250; // 8 × 250 = 2s emitiendo, con timeoutMs=200
await withServer(
  (_req, res) => {
    res.socket?.setNoDelay(true);
    setTimeout(() => {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      // writeHead() NO envía nada: Node retiene las cabeceras hasta el primer
      // write(). Sin este flush el servidor "responde cabeceras" a los 300ms
      // (50 + el primer intervalo) y la fila probaría otra cosa.
      res.flushHeaders();
      let sent = 0;
      const timer = setInterval(() => {
        res.write(`c${sent}`);
        if (++sent === SLOW_STREAM_CHUNKS) {
          clearInterval(timer);
          res.end();
        }
      }, SLOW_STREAM_STEP_MS);
      res.on("close", () => clearInterval(timer));
    }, 50);
  },
  async (baseUrl) => {
    const result = await streamTutorTurn("tok", BODY, { baseUrl, timeoutMs: TIMEOUT_MS });
    const res = asResponse(result);

    // El fallo natural aquí no es un cuerpo corto: es que LA LECTURA LANZA
    // (TimeoutError) tras haber recibido las cabeceras, porque abortar un fetch
    // después de ellas termina en "error response's body with error". Se
    // convierte en aserción para que el script diga qué se rompió.
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      assert.fail(
        "leer el cuerpo lanzó " +
          `${(err as Error)?.name ?? "un error"}: el timeout sigue armado ` +
          "después de las cabeceras. Todo turno que siga emitiendo al vencer " +
          "TUTOR_TIMEOUT_MS se corta a media frase y el estudiante ve una " +
          "respuesta truncada SIN error, porque el navegador ya pintó lo que llegó"
      );
    }

    const expected = Array.from({ length: SLOW_STREAM_CHUNKS }, (_, i) => `c${i}`).join("");
    assert.equal(
      text,
      expected,
      "el cuerpo llegó truncado: el timeout está abortando DESPUÉS de las " +
        "cabeceras (falta el clearTimeout tras el await fetch, o se usó " +
        "AbortSignal.timeout, que no se puede desarmar)"
    );
  }
);

// ---------------------------------------------------------------------------
// Fila 34 — el conjunto de cabeceras SALIENTES es cerrado.
//
// Afirmado como allowlist y no como "no lleva Cookie": el fallo probable es
// esparcir las cabeceras entrantes para dejar pasar una traza, y eso arrastra la
// Cookie —que tendría precedencia sobre el Bearer dentro de getToken()— Y el
// X-Forwarded-For del cliente hacia un servicio con `trust proxy` puesto.
// ---------------------------------------------------------------------------
// Las que pone el runtime (undici) por su cuenta y no dicen nada del proxy.
const RUNTIME_HEADERS = new Set([
  "host",
  "connection",
  "accept",
  "accept-encoding",
  "accept-language",
  "content-length",
  "user-agent",
  "sec-fetch-mode",
]);

await withServer(
  (req, res) => {
    const seen = Object.keys(req.headers)
      .map((h) => h.toLowerCase())
      .filter((h) => !RUNTIME_HEADERS.has(h))
      .sort();
    assert.deepEqual(
      seen,
      ["authorization", "content-type"],
      `el conjunto saliente debía ser exactamente Authorization + Content-Type; llegó: ${seen.join(", ")}`
    );
    assert.equal(req.headers.authorization, "Bearer tok-34");
    assert.equal(req.headers["content-type"], "application/json");
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/v1/tutor/turn");

    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      assert.equal(body, BODY, "el cuerpo se reenvía tal cual");
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("ok");
    });
  },
  async (baseUrl) => {
    const res = asResponse(
      await streamTutorTurn("tok-34", BODY, { baseUrl, timeoutMs: 5000 })
    );
    assert.equal(await res.text(), "ok");
  }
);

// Una baseUrl con barra final no debe producir `//v1/tutor/turn`.
await withServer(
  (req, res) => {
    assert.equal(req.url, "/v1/tutor/turn");
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("ok");
  },
  async (baseUrl) => {
    const res = asResponse(
      await streamTutorTurn("tok", BODY, { baseUrl: `${baseUrl}/`, timeoutMs: 5000 })
    );
    assert.equal(await res.text(), "ok");
  }
);

// ---------------------------------------------------------------------------
// Fila 35 — degradación del proxy. Upstream caído (conexión rechazada) o que
// agota el timeout → {error:true}, NUNCA lanza; el handler lo traduce a 503.
// ---------------------------------------------------------------------------
{
  // Puerto cerrado: conexión rechazada de inmediato, muy por debajo del timeout
  // (mismo contraste que check-access-bridge.ts:206).
  const started = performance.now();
  const refused = await streamTutorTurn("tok", BODY, {
    baseUrl: "http://127.0.0.1:1",
    timeoutMs: 5000,
  });
  assert.deepEqual(refused, { error: true });
  assert.ok(
    performance.now() - started < 1000,
    "un upstream apagado debía resolver muy por debajo del timeout"
  );

  // Un token que no sea string (p. ej. {error:true} de readSessionToken()) ni
  // siquiera llega a hacer la petición.
  assert.deepEqual(
    await streamTutorTurn({ error: true }, BODY, {
      baseUrl: "http://127.0.0.1:1",
      timeoutMs: 5000,
    }),
    { error: true }
  );
}

// Un servidor que ACEPTA la conexión y nunca responde: es el caso que el
// timeout existe para cubrir, y el que un `fetch` sin señal colgaría para
// siempre.
await withServer(
  () => {
    // A propósito: ni res.write() ni res.end(). El socket queda abierto.
  },
  async (baseUrl) => {
    const started = performance.now();
    const result = await streamTutorTurn("tok", BODY, { baseUrl, timeoutMs: TIMEOUT_MS });
    const elapsed = performance.now() - started;
    assert.deepEqual(result, { error: true });
    assert.ok(elapsed < 1000, `debía degradar cerca de los ${TIMEOUT_MS}ms`);
    assert.ok(elapsed >= TIMEOUT_MS * 0.75, "no debía resolver antes del timeout");
  }
);

// ---------------------------------------------------------------------------
// Fila 35b — LA CANCELACIÓN LLEGA A apps/api.
//
// Cancelar el stream que devuelve streamTutorTurn debe destruir el socket hacia
// arriba: el servidor observa `close` CON `res.writableEnded === false`. Y el
// caso de control —leer el cuerpo entero— observa `close` con
// `res.writableEnded === true`.
//
// LAS DOS ASERCIONES, NO SOLO LA PRIMERA: `close` dispara idéntico en los dos
// casos (y `destroyed` también), así que una comprobación que solo afirme
// `close` pasa aunque la cancelación no se propague. `aborted` sí discrimina
// pero está deprecado desde Node 16. Cubre el eslabón Next → apps/api de goal
// 8, el que se paga en la factura sin ningún otro síntoma.
// ---------------------------------------------------------------------------
{
  const closed = deferred<boolean>(); // writableEnded observado al cerrar
  await withServer(
    (_req, res) => {
      res.socket?.setNoDelay(true);
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.write("uno");
      const timer = setInterval(() => res.write("mas"), 40);
      res.on("close", () => {
        clearInterval(timer);
        closed.resolve(res.writableEnded);
      });
      // Red de seguridad: si la cancelación no se propagara, el turno terminaría
      // solo y la aserción de abajo lo delataría en vez de colgar el script.
      setTimeout(() => {
        clearInterval(timer);
        if (!res.writableEnded) res.end();
      }, 3000);
    },
    async (baseUrl) => {
      const res = asResponse(
        await streamTutorTurn("tok", BODY, { baseUrl, timeoutMs: 5000 })
      );
      const reader = res.body!.getReader();
      await reader.read(); // primer chunk: el turno ya está en marcha
      await reader.cancel(); // el estudiante se va

      const writableEnded = await closed.promise;
      assert.equal(
        writableEnded,
        false,
        "el servidor vio un cierre LIMPIO: la cancelación no cruzó hasta " +
          "apps/api y el turno abandonado se sigue facturando en Anthropic"
      );
    }
  );
}

{
  // Control: mismo servidor, pero se lee el cuerpo entero. `close` dispara
  // igual — con writableEnded true. Sin este caso, la aserción de arriba no
  // demuestra nada.
  const closed = deferred<boolean>();
  await withServer(
    (_req, res) => {
      res.socket?.setNoDelay(true);
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.write("uno");
      res.on("close", () => closed.resolve(res.writableEnded));
      setTimeout(() => res.end("dos"), 60);
    },
    async (baseUrl) => {
      const res = asResponse(
        await streamTutorTurn("tok", BODY, { baseUrl, timeoutMs: 5000 })
      );
      assert.equal(await res.text(), "unodos");
      assert.equal(
        await closed.promise,
        true,
        "un turno completo debía cerrar con writableEnded=true"
      );
    }
  );
}

{
  // El otro extremo del mismo eslabón: una señal del cliente YA ABORTADA antes
  // de llamar. El listener no dispararía (una señal abortada no vuelve a
  // emitir), y por eso streamTutorTurn comprueba `aborted` ANTES de registrarlo.
  const hits = { count: 0 };
  await withServer(
    (_req, res) => {
      hits.count++;
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("no debería llegar a leerse");
    },
    async (baseUrl) => {
      const controller = new AbortController();
      controller.abort();
      const result = await streamTutorTurn("tok", BODY, {
        baseUrl,
        timeoutMs: 5000,
        clientSignal: controller.signal,
      });
      assert.deepEqual(
        result,
        { error: true },
        "con la señal del cliente ya abortada el fetch no debía prosperar"
      );
    }
  );
}

// ---------------------------------------------------------------------------
// Fila 35c — un 3xx del upstream NO SE SIGUE.
//
// Con `redirect: "follow"` (el defecto de fetch) un 3xx same-origin reenviaría
// el Bearer a una ruta que nadie decidió, un cross-origin lo descartaría en
// silencio —401, "tu sesión expiró", con la sesión intacta— y un 302
// convertiría el POST en GET descartando el cuerpo.
// ---------------------------------------------------------------------------
{
  const destination = { hits: 0 };
  await withServer(
    (_req, res) => {
      destination.hits++;
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("destino del Location");
    },
    async (destinationUrl) => {
      for (const status of [302, 307]) {
        await withServer(
          (_req, res) => {
            res.writeHead(status, { location: `${destinationUrl}/v1/tutor/turn` });
            res.end();
          },
          async (baseUrl) => {
            const result = await streamTutorTurn("tok", BODY, {
              baseUrl,
              timeoutMs: 5000,
            });
            assert.deepEqual(
              result,
              { error: true },
              `un ${status} del upstream debía degradar a {error:true} → 503`
            );
          }
        );
      }
      // Margen para que una petición mal disparada llegara a contarse.
      await sleep(50);
      assert.equal(
        destination.hits,
        0,
        "la petición se repitió contra el destino del Location: el Bearer viajó " +
          "a una ruta que nadie decidió (falta redirect: \"manual\")"
      );
    }
  );
}

// ---------------------------------------------------------------------------
// Fila 36 — cuerpo saliente del cliente: { message, lesson } y NO el hilo.
// ---------------------------------------------------------------------------
{
  assert.deepEqual(buildTurnBody("¿por qué falla?", "L1"), {
    message: "¿por qué falla?",
    lesson: "L1",
  });

  // Sin selección la clave se OMITE, no viaja vacía ni nula: turn.dto.ts la
  // declara @IsOptional y forbidNonWhitelisted no perdona una clave presente
  // con valor inválido.
  assert.deepEqual(buildTurnBody("hola", ""), { message: "hola" });
  assert.deepEqual(buildTurnBody("hola", null), { message: "hola" });
  assert.deepEqual(buildTurnBody("hola", undefined), { message: "hola" });
  assert.deepEqual(buildTurnBody("hola"), { message: "hola" });

  // Una lección que no encaja en el patrón tampoco viaja.
  assert.deepEqual(buildTurnBody("hola", "../etc"), { message: "hola" });
  assert.deepEqual(buildTurnBody("hola", "L1;drop"), { message: "hola" });
  assert.deepEqual(buildTurnBody("hola", "x".repeat(65)), { message: "hola" });
  assert.deepEqual(buildTurnBody("hola", "x".repeat(64)), {
    message: "hola",
    lesson: "x".repeat(64),
  });

  // El hilo NO viaja, en ninguna forma. Es la propiedad del goal 2.
  for (const lesson of ["L1", undefined]) {
    const keys = Object.keys(buildTurnBody("hola", lesson)).sort();
    assert.ok(
      !keys.includes("messages"),
      "el cuerpo saliente no puede llevar el hilo: el cliente volvería a poder " +
        "fabricar turnos `assistant`"
    );
    assert.deepEqual(keys, lesson ? ["lesson", "message"] : ["message"]);
  }

  assert.equal(TUTOR_MESSAGE_MAX_LENGTH, 4000);
}

// ---------------------------------------------------------------------------
// Fila 37 — mapeo de errores del cliente. 401/403/400 conservan su copy actual;
// 413, 429 y 503 tienen copy propio (no el genérico).
// ---------------------------------------------------------------------------
{
  assert.equal(
    tutorErrorMessage(401),
    "Tu sesión expiró. Vuelve a iniciar sesión para seguir."
  );
  assert.equal(
    tutorErrorMessage(403),
    "Necesitas una suscripción activa para hablar con el tutor."
  );
  assert.equal(
    tutorErrorMessage(400),
    "No pudimos procesar tu mensaje. Recarga la página e intenta otra vez."
  );

  const generic = tutorErrorMessage(500);
  for (const status of [413, 429, 503]) {
    const copy = tutorErrorMessage(status);
    assert.notEqual(copy, generic, `${status} debía tener copy propio`);
    assert.ok(copy.length > 0);
  }

  // 413 es accionable por el estudiante y el genérico le dice lo contrario
  // ("reintenta en un momento" no arregla un mensaje demasiado largo).
  assert.match(tutorErrorMessage(413), /largo/i);
  assert.match(tutorErrorMessage(429), /espera/i);

  // Cualquier otro status cae al genérico.
  assert.equal(tutorErrorMessage(418), generic);
  assert.equal(tutorErrorMessage(0), generic);
}

// ---------------------------------------------------------------------------
// Fila 38 — qué se conserva al fallar.
//
// CUBRE LA DECISIÓN, NO LA CLASIFICACIÓN: verifica qué hacer DADA la fase, no
// que el componente sepa en qué fase está. Lo segundo es la comprobación manual
// obligatoria de §10 paso B — una implementación que conserve el `catch` único
// y pase siempre "request" hace pasar esto con el fallo intacto.
// ---------------------------------------------------------------------------
{
  const request = decideTurnFailure({ phase: "request" });
  assert.equal(request.keepPartial, false, "antes del stream no hay nada que conservar");
  assert.equal(request.notice, tutorErrorMessage(0));

  for (const status of [400, 401, 403, 413, 429, 503]) {
    const byStatus = decideTurnFailure({ phase: "status", status });
    assert.equal(byStatus.keepPartial, false, `!res.ok (${status}) recorta el hueco`);
    assert.equal(byStatus.notice, tutorErrorMessage(status));
  }

  const stream = decideTurnFailure({ phase: "stream" });
  assert.equal(
    stream.keepPartial,
    true,
    "un fallo del bucle de lectura debe CONSERVAR el texto parcial: borrarlo es " +
      "la diferencia entre 'se cortó' y 'no pasó nada'"
  );
  assert.ok(stream.notice.length > 0, "y añadir el aviso de reintento");
  assert.notEqual(stream.notice, request.notice);
}


console.log(
  "check-tutor-turn: OK — filas 32, 33, 34, 35, 35b, 35c, 36, 37 y 38 de PRD-005 §9 cubiertas."
);
