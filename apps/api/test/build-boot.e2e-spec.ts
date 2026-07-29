// La configuración de build de apps/api, vigilada por los dos caminos.
//
// Cubre las filas 1, 2 y 3 de PRD-003 §9, y las filas 40, 41 y 42 de PRD-004 §9.
//
// Por qué hay una fila que compila y arranca de verdad: el camino de BUILD es
// donde §Design Decisions demuestra que el import cruzado a
// `src/lib/schema.ts` se rompe, y el transformador de los tests es otro — pasar
// los tests no dice nada sobre `tsc`. Peor: con `"type": "module"` en
// `apps/api/package.json`, `tsc` EMITE IGUAL —reporta errores de tipo de
// drizzle-orm por el doble resolution-mode, pero sin `noEmitOnError` escribe el
// `dist` de todas formas— y el arranque revienta con
// `SyntaxError: ... does not provide an export named 'subscriptions'`. La única
// forma de detectarlo es arrancar el fichero emitido.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccessService } from "../src/access/access.service.ts";
import { SubscriptionsRepository } from "../src/access/subscriptions.repository.ts";
import { AnalyticsService } from "../src/analytics/analytics.service.ts";
import { AppModule } from "../src/app.module.ts";
import { resolveApiConfig } from "../src/config.ts";
import { SessionGuard } from "../src/session/session.guard.ts";
import {
  API_ROOT,
  DEAD_DATABASE_URL,
  REPO_ROOT,
  TEST_AUTH_SECRET,
  TEST_COOKIE_NAME,
  TEST_PADDLE_SECRET,
  applyApiEnv,
} from "./helpers.ts";

/** El entrypoint emitido es `dist/apps/api/src/main.js`, NO `dist/main.js`: el
 *  `rootDir` inferido por tsc es la raíz del repositorio. */
const ENTRYPOINT = "dist/apps/api/src/main.js";

/** El SEGUNDO entrypoint (PRD-004 §5.1), emitido por el mismo `rootDir`
 *  inferido. Es el que el paso 3 de §10 pone como arranque del servicio de cron
 *  en Railway, así que su ruta es parte del plan de despliegue. */
const WORKER_ENTRYPOINT = "dist/apps/api/src/worker.js";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

type SpawnResult = { code: number | null; stderr: string; stdout: string };

function bootEntrypoint(env: Record<string, string | undefined>) {
  return spawn(process.execPath, [ENTRYPOINT], {
    cwd: API_ROOT,
    // `PADDLE_API_KEY: undefined` va ANTES del spread de `env` y es
    // load-bearing: este entrypoint esparce `...process.env`, así que una
    // variable exportada en la shell del desarrollador llega al `main.js`
    // lanzado y el guarda de PRD-004 §8.1 lo mata — con lo que las filas 1 y 3
    // de PRD-003 §9 fallarían nombrando el problema equivocado. `applyApiEnv()`
    // no cubre este camino: aquí no se llama (§8.1, "dos sitios, no uno").
    // `spawn` omite del entorno las claves con valor `undefined`, que es lo
    // mismo que ya hace la fila 3 con `AUTH_COOKIE_NAME`. Va antes del spread
    // para que la fila 41 pueda ponerla a propósito.
    env: { ...process.env, PADDLE_API_KEY: undefined, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<SpawnResult> {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
  return new Promise((resolve) => {
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function waitForHealth(port: number, timeoutMs: number): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await fetch(`http://127.0.0.1:${port}/health`);
    } catch (err: unknown) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw new Error(`/health no respondió en ${timeoutMs} ms: ${String(lastError)}`);
}

describe("build y arranque", () => {
  beforeAll(() => {
    // El build de verdad, con el `tsc` y el tsconfig del paquete.
    execFileSync("pnpm", ["--filter", "api", "build"], { cwd: REPO_ROOT, stdio: "pipe" });
  });

  // -------------------------------------------------------------------------
  // Fila 1 — apps/api compila y arranca
  // -------------------------------------------------------------------------
  it("fila 1: compila, emite dist/apps/api/src/main.js y sirve /health", async () => {
    // El árbol emitido es el que fija §Design Decisions: la salida cuelga del
    // rootDir inferido (la raíz del repo), no de `src/`.
    const emitted = readFileSync(join(API_ROOT, ENTRYPOINT), "utf8");
    expect(emitted).toContain("require(");

    // Y el esquema de la raíz viaja al bundle como CommonJS, en su propia rama.
    const schema = readFileSync(join(API_ROOT, "dist/src/lib/schema.js"), "utf8");
    expect(schema).toContain("subscriptions");

    const port = await freePort();
    const child = bootEntrypoint({
      PORT: String(port),
      DATABASE_URL: DEAD_DATABASE_URL,
      AUTH_SECRET: TEST_AUTH_SECRET,
      AUTH_COOKIE_NAME: TEST_COOKIE_NAME,
      PADDLE_WEBHOOK_SECRET: TEST_PADDLE_SECRET,
    });

    try {
      const response = await waitForHealth(port, 20_000);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ status: "ok" });
    } finally {
      child.kill("SIGKILL");
    }
  }, 180_000);

  // -------------------------------------------------------------------------
  // Fila 3 — sin AUTH_COOKIE_NAME, apps/api no arranca
  // -------------------------------------------------------------------------
  it("fila 3: sin AUTH_COOKIE_NAME el proceso muere al arrancar y dice por qué", async () => {
    // Goal 5: la configuración que el puente necesita falla AL ARRANCAR, no en
    // la primera petición de un estudiante. `AUTH_COOKIE_NAME` es el `salt` de
    // Auth.js y no puede tener defecto (§5.1).
    const child = bootEntrypoint({
      PORT: String(await freePort()),
      DATABASE_URL: DEAD_DATABASE_URL,
      AUTH_SECRET: TEST_AUTH_SECRET,
      AUTH_COOKIE_NAME: undefined,
      PADDLE_WEBHOOK_SECRET: TEST_PADDLE_SECRET,
    });

    const result = await waitForExit(child);
    expect(result.code).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("AUTH_COOKIE_NAME");
  }, 60_000);

  it("fila 3 (hermanas): las otras tres variables obligatorias también tumban el arranque", async () => {
    for (const missing of ["DATABASE_URL", "AUTH_SECRET", "PADDLE_WEBHOOK_SECRET"]) {
      const env: Record<string, string | undefined> = {
        PORT: String(await freePort()),
        DATABASE_URL: DEAD_DATABASE_URL,
        AUTH_SECRET: TEST_AUTH_SECRET,
        AUTH_COOKIE_NAME: TEST_COOKIE_NAME,
        PADDLE_WEBHOOK_SECRET: TEST_PADDLE_SECRET,
      };
      env[missing] = undefined;

      const result = await waitForExit(bootEntrypoint(env));
      expect(result.code, `${missing} ausente debería tumbar el arranque`).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain(missing);
    }
  }, 120_000);

  // -------------------------------------------------------------------------
  // Fila 40 de PRD-004 — el entrypoint del worker existe donde se dice
  // -------------------------------------------------------------------------
  it("fila 40 (PRD-004): el build emite dist/apps/api/src/worker.js", () => {
    // La misma trampa que la fila 1 vigila para `main.js`: la salida cuelga del
    // `rootDir` INFERIDO —la raíz del repositorio— y no de `src/`, así que los
    // defaults de las herramientas apuntan a `dist/worker.js`, que no existe.
    // El paso 3 de §10 configura este arranque a mano en Railway; si la ruta
    // cambiara, el servicio de cron levantaría el `CMD` de la imagen, que es el
    // servidor HTTP — y eso no parece un fallo, parece un despliegue correcto.
    const emitted = readFileSync(join(API_ROOT, WORKER_ENTRYPOINT), "utf8");
    expect(emitted).toContain("require(");

    // Y `package.json` lo lanza por esa misma ruta: dos sitios, una ruta.
    const pkg = JSON.parse(readFileSync(join(API_ROOT, "package.json"), "utf8"));
    expect(pkg.scripts["start:worker"]).toContain(WORKER_ENTRYPOINT);
  });

  // -------------------------------------------------------------------------
  // Fila 41 de PRD-004 — el servicio HTTP se niega a arrancar con PADDLE_API_KEY
  // -------------------------------------------------------------------------
  it("fila 41 (PRD-004): con PADDLE_API_KEY presente el proceso sale 1 y la nombra", async () => {
    // Es el ÚNICO guarda que se dispara porque una variable SÍ está (§8.1). Se
    // afirma desde un proceso hijo y no llamando a `resolveApiConfig()` porque
    // lo que el control promete es que el SERVICIO no arranque: los dos caminos
    // por los que la credencial llega aquí —una sobrescritura de arranque
    // ignorada por Railway, un `.env` compartido en auto-hospedaje— producen
    // exactamente este `spawn` de `main.js` con la variable puesta.
    const child = bootEntrypoint({
      PORT: String(await freePort()),
      DATABASE_URL: DEAD_DATABASE_URL,
      AUTH_SECRET: TEST_AUTH_SECRET,
      AUTH_COOKIE_NAME: TEST_COOKIE_NAME,
      PADDLE_WEBHOOK_SECRET: TEST_PADDLE_SECRET,
      PADDLE_API_KEY: "pdl_apikey_de_pruebas",
    });

    const result = await waitForExit(child);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.code).toBe(1);
    expect(output).toContain("PADDLE_API_KEY");
    // El mensaje nombra la variable; el VALOR no se registra nunca.
    expect(output).not.toContain("pdl_apikey_de_pruebas");
  }, 60_000);

  it("fila 41 (PRD-004): una PADDLE_API_KEY vacía también tumba el arranque", async () => {
    // "Presente" es presente, con valor o sin él: lo que el operador comprueba
    // es "está o no está", y un segundo criterio invisible sería justo lo que
    // este guarda existe para no tener.
    const child = bootEntrypoint({
      PORT: String(await freePort()),
      DATABASE_URL: DEAD_DATABASE_URL,
      AUTH_SECRET: TEST_AUTH_SECRET,
      AUTH_COOKIE_NAME: TEST_COOKIE_NAME,
      PADDLE_WEBHOOK_SECRET: TEST_PADDLE_SECRET,
      PADDLE_API_KEY: "",
    });

    const result = await waitForExit(child);
    expect(result.code).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("PADDLE_API_KEY");
  }, 60_000);

  // -------------------------------------------------------------------------
  // Fila 42 de PRD-004 — la suite existente sobrevive al guarda
  // -------------------------------------------------------------------------
  it("fila 42 (PRD-004): con PADDLE_API_KEY exportada por el desarrollador, los dos sitios la limpian", async () => {
    // El guarda de §8.1 convierte una variable exportada en la shell en un fallo
    // de TODA la suite. Los dos sitios que la limpian son distintos y ninguno
    // cubre al otro: `applyApiEnv()` (filas 2 y las suites de acceso, cobro y
    // límite de tasa) y `bootEntrypoint` (filas 1 y 3, que esparcen
    // `...process.env` sin pasar por `applyApiEnv()`).
    const exported = "pdl_apikey_exportada_por_el_desarrollador";
    process.env.PADDLE_API_KEY = exported;

    try {
      // Sitio 1 — `applyApiEnv()`, el camino de las filas 2 y 3 de PRD-003 §9.
      applyApiEnv();
      expect(process.env.PADDLE_API_KEY).toBeUndefined();
      expect(() => resolveApiConfig()).not.toThrow();

      // Sitio 2 — `bootEntrypoint`, el camino de la fila 1: el proceso hijo
      // hereda `process.env`, así que se vuelve a ensuciar a propósito.
      process.env.PADDLE_API_KEY = exported;
      const port = await freePort();
      const child = bootEntrypoint({
        PORT: String(port),
        DATABASE_URL: DEAD_DATABASE_URL,
        AUTH_SECRET: TEST_AUTH_SECRET,
        AUTH_COOKIE_NAME: TEST_COOKIE_NAME,
        PADDLE_WEBHOOK_SECRET: TEST_PADDLE_SECRET,
      });

      try {
        const response = await waitForHealth(port, 20_000);
        expect(response.status).toBe(200);
      } finally {
        child.kill("SIGKILL");
      }
    } finally {
      delete process.env.PADDLE_API_KEY;
    }
  }, 60_000);
});

describe("DI bajo Vitest", () => {
  // -------------------------------------------------------------------------
  // Fila 2 — la DI de NestJS resuelve bajo Vitest
  // -------------------------------------------------------------------------
  it("fila 2: Test.createTestingModule instancia AccessService con sus dependencias", async () => {
    // Falla si se pierde `unplugin-swc` o `emitDecoratorMetadata`: el
    // transformador por defecto de Vitest no emite metadatos de decorador, y
    // sin ellos Nest no sabe qué inyectar en un constructor.
    applyApiEnv();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    try {
      const service = moduleRef.get(AccessService);
      expect(service).toBeInstanceOf(AccessService);

      // Y las dependencias del constructor están resueltas de verdad, no
      // rellenadas con undefined.
      expect(moduleRef.get(SubscriptionsRepository)).toBeInstanceOf(SubscriptionsRepository);
      expect(moduleRef.get(AnalyticsService)).toBeInstanceOf(AnalyticsService);
      expect(moduleRef.get(SessionGuard)).toBeInstanceOf(SessionGuard);
    } finally {
      await moduleRef.close();
    }
  });
});

afterAll(() => {
  // Nada que limpiar: `dist/` es artefacto de build y `.gitignore` lo cubre.
});
