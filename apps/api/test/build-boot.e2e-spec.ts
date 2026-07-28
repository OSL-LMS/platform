// La configuración de build de apps/api, vigilada por los dos caminos.
//
// Cubre las filas 1, 2 y 3 de PRD-003 §9.
//
// Por qué hay una fila que compila y arranca de verdad: el camino de BUILD es
// donde §Design Decisions demuestra que el import cruzado a
// `src/lib/schema.ts` se rompe, y el transformador de los tests es otro — pasar
// los tests no dice nada sobre `tsc`. Peor: con `"type": "module"` en
// `apps/api/package.json`, `tsc` sale 0 SIN UN SOLO AVISO y el arranque revienta
// con `SyntaxError: ... does not provide an export named 'subscriptions'`. La
// única forma de detectarlo es arrancar el fichero emitido.
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
    env: { ...process.env, ...env },
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
