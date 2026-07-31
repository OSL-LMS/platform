// El presupuesto de conexiones, ahora inyectado (PRD-004 §7.2).
//
// Cubre la fila 43 de PRD-004 §9 ENTERA, y por eso las dos mitades están en el
// mismo fichero: lo que la fila afirma no es "el servicio HTTP reserva 8" ni "el
// worker reserva 1", sino que LOS DOS valores salen del mismo punto de
// inyección y llegan al mismo `Pool` por la misma fábrica. Separarlas en dos
// ficheros dejaría esa afirmación sin dueño.
//
// El listener `error` se afirma aquí porque `docs/SYSTEM_ARTIFACT.md` (dominio
// `acceso`, Open Debt) lo declara como el único obstáculo entre un cliente
// OCIOSO caído y la muerte del proceso, y avisa de que un refactor puede
// borrarlo sin que nada se ponga rojo. Provocar el fallo de verdad exige matar
// la conexión desde el servidor; afirmar que el listener está REGISTRADO no lo
// sustituye, pero cierra el modo de fallo que el aviso describe: que desaparezca
// en silencio.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { Global, Module } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import {
  DEAD_DATABASE_URL,
  TEST_ANTHROPIC_KEY,
  TEST_AUTH_SECRET,
  TEST_COOKIE_NAME,
  TEST_CURRICULUM_SLUG,
  TEST_EVIDENCE_MAX_REDIRECTS,
  TEST_EVIDENCE_TIMEOUT_MS,
  TEST_PADDLE_SECRET,
} from "../../test/helpers.ts";
import { API_CONFIG, type ApiConfig, resolveApiConfig } from "../config.ts";
import { resolveWorkerConfig, type WorkerConfig } from "../worker-config.ts";
import { DrizzleModule, PG_POOL } from "./drizzle.module.ts";

/** Entorno mínimo, explícito y AISLADO de `process.env`: este fichero afirma
 *  sobre `resolveApiConfig()` y no quiere depender del shell de quien lo corra
 *  —que es justo el problema que el guarda de §8.1 introduce—. */
function env(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: DEAD_DATABASE_URL,
    AUTH_SECRET: TEST_AUTH_SECRET,
    AUTH_COOKIE_NAME: TEST_COOKIE_NAME,
    PADDLE_WEBHOOK_SECRET: TEST_PADDLE_SECRET,
    // Obligatorias desde PRD-005 §5.1: sin ellas `resolveApiConfig()` lanza y
    // este fichero fallaría nombrando el problema equivocado.
    ANTHROPIC_API_KEY: TEST_ANTHROPIC_KEY,
    CURRICULUM_SLUG: TEST_CURRICULUM_SLUG,
    // Y las dos de PRD-007 §5.4, por lo mismo.
    EVIDENCE_TIMEOUT_MS: TEST_EVIDENCE_TIMEOUT_MS,
    EVIDENCE_MAX_REDIRECTS: TEST_EVIDENCE_MAX_REDIRECTS,
  } as NodeJS.ProcessEnv;
}

/** Entorno mínimo del WORKER, también explícito. `PADDLE_API_KEY` va con un
 *  valor de pruebas a propósito: en esta máquina hay una viva exportada en el
 *  shell, y `resolveWorkerConfig()` la exige. */
function workerEnv(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: DEAD_DATABASE_URL,
    PADDLE_API_KEY: "pdl_apikey_de_pruebas",
    PADDLE_ENV: "sandbox",
  } as NodeJS.ProcessEnv;
}

/** Suministra `API_CONFIG` como lo hace `ConfigModule`: global y EXPORTADO. Un
 *  módulo global de Nest no registra sus providers globalmente, registra lo que
 *  exporta — y la fábrica de `PG_POOL` no importa nada. Acepta las dos
 *  configuraciones porque el token es el mismo en los dos procesos: la fábrica
 *  no sabe —ni tiene por qué— en cuál de los dos está. */
function stubConfigModule(config: ApiConfig | WorkerConfig) {
  @Global()
  @Module({
    providers: [{ provide: API_CONFIG, useValue: config }],
    exports: [API_CONFIG],
  })
  class StubConfigModule {}

  return StubConfigModule;
}

function buildContainer(config: ApiConfig | WorkerConfig): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: [stubConfigModule(config), DrizzleModule],
  }).compile();
}

describe("resolveApiConfig().poolMax", () => {
  // -------------------------------------------------------------------------
  // Fila 43 — el servicio HTTP declara 8
  // -------------------------------------------------------------------------
  it("fila 43: el servicio HTTP reserva 8 conexiones", () => {
    // Reparto de §7.2: 8 Next, 8 aquí, 1 el worker, 3 de margen para
    // `drizzle-kit migrate` y los scripts.
    expect(resolveApiConfig(env()).poolMax).toBe(8);
  });

  it("fila 43: no se lee del entorno — el reparto no es una perilla", () => {
    const tampered = { ...env(), POOL_MAX: "50", DB_POOL_MAX: "50" } as NodeJS.ProcessEnv;
    expect(resolveApiConfig(tampered).poolMax).toBe(8);
  });
});

describe("resolveWorkerConfig().poolMax", () => {
  // -------------------------------------------------------------------------
  // Fila 43 — el worker declara 1
  // -------------------------------------------------------------------------
  it("fila 43: el worker reserva 1 conexión", () => {
    // Una pasada es un recorrido secuencial: no hay nada que paralelizar, y el
    // reparto de §7.2 no tiene sitio para más (8 + 8 + 1 + 3 de margen).
    expect(resolveWorkerConfig(workerEnv()).poolMax).toBe(1);
  });

  it("fila 43: tampoco se lee del entorno", () => {
    const tampered = { ...workerEnv(), POOL_MAX: "50", DB_POOL_MAX: "50" } as NodeJS.ProcessEnv;
    expect(resolveWorkerConfig(tampered).poolMax).toBe(1);
  });

  it("fila 43: la MISMA fábrica propaga el 1 del worker al Pool", async () => {
    // La afirmación de la fila: los dos valores salen del mismo punto de
    // inyección y llegan al Pool por la misma fábrica — la que registra el
    // listener `error`. Una segunda fábrica para el worker podría olvidarlo, y
    // su ausencia mata el proceso en silencio.
    const moduleRef = await buildContainer(resolveWorkerConfig(workerEnv()));
    try {
      expect(moduleRef.get<Pool>(PG_POOL).options.max).toBe(1);
      expect(moduleRef.get<Pool>(PG_POOL).listenerCount("error")).toBe(1);
    } finally {
      await moduleRef.close();
    }
  });
});

describe("la fábrica de PG_POOL", () => {
  // -------------------------------------------------------------------------
  // Fila 43 — el `max` llega al Pool, y el listener sigue puesto
  // -------------------------------------------------------------------------
  it("fila 43: propaga el `max` de la configuración inyectada al Pool", async () => {
    // El valor NO es 8 a propósito: con 8 pasaría igual una constante horneada,
    // que es exactamente lo que este cambio retira.
    const moduleRef = await buildContainer({ ...resolveApiConfig(env()), poolMax: 3 });
    try {
      expect(moduleRef.get<Pool>(PG_POOL).options.max).toBe(3);
    } finally {
      await moduleRef.close();
    }
  });

  it("fila 43: con la configuración del servicio HTTP el Pool queda en 8", async () => {
    const moduleRef = await buildContainer(resolveApiConfig(env()));
    try {
      expect(moduleRef.get<Pool>(PG_POOL).options.max).toBe(8);
    } finally {
      await moduleRef.close();
    }
  });

  it("fila 43: el listener `error` del pool queda registrado", async () => {
    const moduleRef = await buildContainer(resolveApiConfig(env()));
    try {
      // Uno, no cero y no dos: sin él un cliente ocioso caído es una excepción
      // no capturada que tumba el proceso, y es el único camino por el que una
      // excepción esquiva el filtro global (no nace dentro de una petición).
      expect(moduleRef.get<Pool>(PG_POOL).listenerCount("error")).toBe(1);
    } finally {
      await moduleRef.close();
    }
  });

  it("construir el pool NO abre ninguna conexión", async () => {
    // Lo que hace cierto el goal 3 de PRD-003 (un 401 no toca Postgres) y lo que
    // permite que `/health` responda con la base caída. `DEAD_DATABASE_URL`
    // rechaza al instante: si la fábrica conectara, esto lanzaría.
    const moduleRef = await buildContainer(resolveApiConfig(env()));
    try {
      expect(moduleRef.get<Pool>(PG_POOL).totalCount).toBe(0);
    } finally {
      await moduleRef.close();
    }
  });
});
