// Límite de tasa (ver `src/throttle.ts` y `src/common/bridge-throttler.guard.ts`).
//
// NO toca Postgres: usa `DEAD_DATABASE_URL`, porque las afirmaciones de aquí se
// cumplen en caminos que nunca abren conexión — un 401 no llega a la base
// (goal 3) y /health tampoco (§5.2).
//
// Regla de código: identificadores en inglés, comentarios en español.

import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module.ts";
import { DEFAULT_THROTTLE } from "../src/throttle.ts";
import { applyApiEnv, startApp, stopApp, type RunningApp } from "./helpers.ts";

const { limit } = DEFAULT_THROTTLE;

/** Peticiones en serie, devolviendo la lista de códigos. En serie y no en
 *  paralelo a propósito: el contador del throttler es un `Map` en memoria y con
 *  peticiones concurrentes el orden de incremento no está garantizado, así que
 *  "la número N+1 es la que corta" dejaría de ser una afirmación estable. */
async function burst(url: string, times: number, headers?: HeadersInit): Promise<number[]> {
  const codes: number[] = [];
  for (let i = 0; i < times; i++) {
    const res = await fetch(url, headers ? { headers } : undefined);
    codes.push(res.status);
  }
  return codes;
}

describe("límite de tasa", () => {
  let running: RunningApp;
  let accessUrl: string;

  beforeAll(async () => {
    applyApiEnv();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    running = await startApp(moduleRef);
    accessUrl = `${running.baseUrl}/v1/access`;
  });

  afterAll(async () => {
    await stopApp(running?.app);
  });

  it("sin credencial cuenta por IP y corta ANTES de autenticar", async () => {
    // Cada una respondería 401. Que la que sobra devuelva 429 y no 401 es lo
    // que demuestra que el guard de tasa corre por delante del de sesión — si
    // se invirtieran, un flujo anónimo pagaría la verificación del token en
    // cada petición antes de ser rechazado, que es justo el trabajo que este
    // límite existe para no hacer.
    const codes = await burst(accessUrl, limit + 1);

    expect(codes.slice(0, limit).every((c) => c === 401)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });

  it("cuenta por credencial: agotar el cubo de un token no toca el de otro", async () => {
    // La afirmación que sostiene todo el diseño. El único llamante de
    // /v1/access* es el servidor de Next, así que todos los estudiantes
    // comparten IP de origen; si el contador fuera por IP, la última línea
    // vería un 429 y en producción un estudiante agotaría la cuota de todos.
    // Los tokens son basura a propósito: lo que se prueba es la CLAVE del
    // contador, no la sesión.
    const exhausted = await burst(accessUrl, limit + 1, { authorization: "Bearer estudiante-a" });
    expect(exhausted.at(-1)).toBe(429);

    const otherStudent = await burst(accessUrl, 1, { authorization: "Bearer estudiante-b" });
    expect(otherStudent).toEqual([401]);
  });

  it("no corta /health, que es lo que sondea Railway", async () => {
    const codes = await burst(`${running.baseUrl}/health`, limit + 20);

    expect(codes.every((c) => c === 200)).toBe(true);
  });
});
