// El arranque del worker, desde un proceso hijo de verdad.
//
// Cubre las filas 35, 36, 37, 37b, 38, 39 y 39b de PRD-004 §9.
//
// POR QUÉ DESDE UN PROCESO HIJO: los códigos de salida solo se afirman así
// (`spawn` + `child.on("exit")`), y lo que estas filas prueban es el goal 8 —"el
// worker DEBERÁ FALLAR AL ARRANCAR nombrando la variable"—, que es una
// propiedad del proceso, no de una función.
//
// NINGUNA FILA DE AQUÍ ALCANZA LA API DE PADDLE, y hay dos barreras
// independientes que lo garantizan:
//
//  1. Las filas de configuración inválida salen ANTES de construir el
//     contenedor, y la configuración se resuelve antes que nada.
//  2. Las dos filas que sí pasan la configuración corren con
//     `DEAD_DATABASE_URL` (puerto 1, rechaza al instante) y el barrido carga la
//     tabla ANTES de iterar Paddle: la pasada muere en Postgres. Además el test
//     mata al hijo en cuanto ve la línea de arranque.
//
// El entorno del hijo se construye EXPLÍCITAMENTE, con todas las variables del
// worker borradas antes del spread: esta máquina tiene una `PADDLE_API_KEY` viva
// exportada en el shell, y sin ese borrado la fila 35 —que prueba su ausencia—
// pasaría a probar otra cosa o dejaría de fallar.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { execFileSync, spawn } from "node:child_process";

import { beforeAll, describe, expect, it } from "vitest";

import { API_ROOT, DEAD_DATABASE_URL, REPO_ROOT } from "./helpers.ts";

/** Mismo `rootDir` inferido que `main.js` (§5.1). La fila 40 vigila que exista. */
const WORKER_ENTRYPOINT = "dist/apps/api/src/worker.js";

/** Clave FALSA. Ninguna fila la usa contra la red; está para pasar el guarda de
 *  `resolveWorkerConfig()`. */
const FAKE_API_KEY = "pdl_apikey_de_pruebas";

/** La línea que `worker.ts` emite justo tras resolver la configuración (§5.1).
 *  Es lo que permite afirmar sobre el arranque sin esperar a un fallo posterior,
 *  que solo podría venir de llamar a Paddle. */
const CONFIG_LINE = "reconcile: config resuelta";

type SpawnResult = { code: number | null; output: string };

function spawnWorker(env: Record<string, string | undefined>) {
  return spawn(process.execPath, [WORKER_ENTRYPOINT], {
    cwd: API_ROOT,
    env: {
      ...process.env,
      // Todas borradas ANTES del spread: cada fila declara exactamente el
      // entorno que quiere probar y nada se hereda del shell.
      DATABASE_URL: undefined,
      PADDLE_API_KEY: undefined,
      PADDLE_ENV: undefined,
      POSTHOG_API_KEY: undefined,
      POSTHOG_HOST: undefined,
      RECONCILE_APPLY: undefined,
      RECONCILE_DEADLINE_MS: undefined,
      // Los tres secretos del servicio HTTP también fuera: el goal 13 es que el
      // worker arranque SIN ellos, y heredarlos del shell escondería un
      // `ConfigModule` importado por error.
      AUTH_SECRET: undefined,
      AUTH_COOKIE_NAME: undefined,
      PADDLE_WEBHOOK_SECRET: undefined,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function collect(child: ReturnType<typeof spawn>): { read: () => string } {
  let output = "";
  child.stdout?.on("data", (chunk) => (output += String(chunk)));
  child.stderr?.on("data", (chunk) => (output += String(chunk)));
  return { read: () => output };
}

async function runWorker(env: Record<string, string | undefined>): Promise<SpawnResult> {
  const child = spawnWorker(env);
  const collected = collect(child);
  return new Promise((resolve) => {
    child.on("exit", (code) => resolve({ code, output: collected.read() }));
  });
}

/** Espera a que el hijo escriba `needle` y lo MATA. No se espera a la salida a
 *  propósito: lo único que hay entre la configuración y el final es la carga de
 *  la tabla y la llamada a Paddle, y ningún test puede permitirse la segunda. */
async function runUntilLine(
  env: Record<string, string | undefined>,
  needle: string,
  timeoutMs = 30_000
): Promise<string> {
  const child = spawnWorker(env);
  const collected = collect(child);

  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (collected.read().includes(needle)) return collected.read();
      if (child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return collected.read();
  } finally {
    child.kill("SIGKILL");
  }
}

describe("arranque del worker de reconciliación", () => {
  beforeAll(() => {
    execFileSync("pnpm", ["--filter", "api", "build"], { cwd: REPO_ROOT, stdio: "pipe" });
  }, 240_000);

  // -------------------------------------------------------------------------
  // Fila 35 — sin PADDLE_API_KEY
  // -------------------------------------------------------------------------
  it("fila 35: sin PADDLE_API_KEY sale distinto de 0 y la nombra, sin tocar Postgres", async () => {
    const result = await runWorker({
      DATABASE_URL: DEAD_DATABASE_URL,
      PADDLE_ENV: "sandbox",
    });

    expect(result.code).not.toBe(0);
    expect(result.output).toContain("PADDLE_API_KEY");
    // La configuración se resuelve ANTES de construir el contenedor, así que el
    // pool no llega a existir: si hubiera intentado conectar, `DEAD_DATABASE_URL`
    // (puerto 1) habría dejado su rechazo en la salida.
    expect(result.output).not.toContain("ECONNREFUSED");
    expect(result.output).not.toContain(CONFIG_LINE);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Fila 36 — sin DATABASE_URL
  // -------------------------------------------------------------------------
  it("fila 36: sin DATABASE_URL sale distinto de 0 y la nombra", async () => {
    const result = await runWorker({
      PADDLE_API_KEY: FAKE_API_KEY,
      PADDLE_ENV: "sandbox",
    });

    expect(result.code).not.toBe(0);
    expect(result.output).toContain("DATABASE_URL");
  }, 60_000);

  // -------------------------------------------------------------------------
  // Fila 37 — PADDLE_ENV ausente o inexacta
  // -------------------------------------------------------------------------
  it("fila 37: PADDLE_ENV ausente, `Production`, `prod` o con espacio salen 1 nombrándola", async () => {
    // Aquí NO se reproduce el `?? sandbox` de `config.ts:105`, y la divergencia
    // es el §6.3 entero: en el servicio HTTP un entorno equivocado sigue
    // verificando firmas igual; aquí significa leer la cuenta de sandbox y
    // escribir la tabla de producción, sin error y sin señal, tomando por
    // evidencia unas suscripciones de prueba con correos reales.
    for (const value of [undefined, "Production", "prod", " sandbox", ""]) {
      const result = await runWorker({
        DATABASE_URL: DEAD_DATABASE_URL,
        PADDLE_API_KEY: FAKE_API_KEY,
        PADDLE_ENV: value,
      });

      expect(result.code, `PADDLE_ENV=${JSON.stringify(value)} debería tumbar el arranque`).toBe(1);
      expect(result.output).toContain("PADDLE_ENV");
      expect(result.output).not.toContain(CONFIG_LINE);
    }
  }, 120_000);

  it("fila 37: `production` y `sandbox` exactas sí pasan", async () => {
    for (const value of ["production", "sandbox"]) {
      const output = await runUntilLine(
        {
          DATABASE_URL: DEAD_DATABASE_URL,
          PADDLE_API_KEY: FAKE_API_KEY,
          PADDLE_ENV: value,
        },
        CONFIG_LINE
      );

      expect(output).toContain(`${CONFIG_LINE} env=${value}`);
    }
  }, 120_000);

  // -------------------------------------------------------------------------
  // Fila 37b — RECONCILE_DEADLINE_MS invalida tumba el arranque
  // -------------------------------------------------------------------------
  it("fila 37b: RECONCILE_DEADLINE_MS no numérico o no positivo sale 1 nombrándola", async () => {
    // El validador existe en `worker-config.ts` pero PRD-004 §7.1 solo pedía
    // "opcional, defecto 300 000": nada obligaba a rechazar una entrada mala, y
    // sin esta fila un `Number(raw) || DEFAULT` volvería a colarse sin que nada
    // se ponga rojo. Importa porque el deadline es el ÚNICO freno de un barrido
    // sin límite de páginas (§8.4) y porque su invariante —menor que el periodo
    // del cron (§5.1)— deja de comprobarse si el valor cae en silencio al
    // defecto. Hallazgo de la re-revisión post-implementación, ronda 1.
    // La cadena vacía NO va aquí: `worker-config.ts:92` la trata como ausencia y
    // cae al defecto, igual que el `!value` de `required()` en ese mismo fichero.
    for (const value of ["abc", "0", "-1", "5.5"]) {
      const result = await runWorker({
        DATABASE_URL: DEAD_DATABASE_URL,
        PADDLE_API_KEY: FAKE_API_KEY,
        PADDLE_ENV: "sandbox",
        RECONCILE_DEADLINE_MS: value,
      });

      expect(
        result.code,
        `RECONCILE_DEADLINE_MS=${JSON.stringify(value)} debería tumbar el arranque`
      ).toBe(1);
      expect(result.output).toContain("RECONCILE_DEADLINE_MS");
      expect(result.output).not.toContain(CONFIG_LINE);
    }
  }, 120_000);

  it("fila 37b: ausente, vacía o válida arrancan", async () => {
    for (const value of [undefined, "", "1000"]) {
      const output = await runUntilLine(
        {
          DATABASE_URL: DEAD_DATABASE_URL,
          PADDLE_API_KEY: FAKE_API_KEY,
          PADDLE_ENV: "sandbox",
          RECONCILE_DEADLINE_MS: value,
        },
        CONFIG_LINE
      );

      expect(output).toContain(CONFIG_LINE);
    }
  }, 120_000);

  // -------------------------------------------------------------------------
  // Fila 38 — POSTHOG_API_KEY con la escritura activada
  // -------------------------------------------------------------------------
  it("fila 38: con RECONCILE_APPLY=true y sin POSTHOG_API_KEY sale 1 nombrándola", async () => {
    // Sin clave, `AnalyticsService` deja el cliente a `null` y `track()` retorna
    // en la primera línea: el goal 14 —rastro duradero de cada escritura— sería
    // un no-op silencioso en producción sin que nada se pusiera rojo.
    const result = await runWorker({
      DATABASE_URL: DEAD_DATABASE_URL,
      PADDLE_API_KEY: FAKE_API_KEY,
      PADDLE_ENV: "sandbox",
      RECONCILE_APPLY: "true",
    });

    expect(result.code).toBe(1);
    expect(result.output).toContain("POSTHOG_API_KEY");
  }, 60_000);

  it("fila 38: sin RECONCILE_APPLY arranca aunque falte POSTHOG_API_KEY", async () => {
    // Se puede observar sin telemetría; no se puede ESCRIBIR sin rastro.
    const output = await runUntilLine(
      {
        DATABASE_URL: DEAD_DATABASE_URL,
        PADDLE_API_KEY: FAKE_API_KEY,
        PADDLE_ENV: "sandbox",
      },
      CONFIG_LINE
    );

    expect(output).toContain(CONFIG_LINE);
    expect(output).not.toContain("POSTHOG_API_KEY");
  }, 60_000);

  it("fila 38: solo el valor exacto `true` activa la escritura", async () => {
    // Cualquier otra cosa es modo sin escritura (goal 7), así que tampoco exige
    // la clave de PostHog.
    for (const value of ["TRUE", "1", "yes", "true "]) {
      const output = await runUntilLine(
        {
          DATABASE_URL: DEAD_DATABASE_URL,
          PADDLE_API_KEY: FAKE_API_KEY,
          PADDLE_ENV: "sandbox",
          RECONCILE_APPLY: value,
        },
        CONFIG_LINE
      );

      expect(output, `RECONCILE_APPLY=${JSON.stringify(value)} no debería exigir PostHog`).toContain(
        CONFIG_LINE
      );
      expect(output).not.toContain("POSTHOG_API_KEY");
    }
  }, 120_000);

  // -------------------------------------------------------------------------
  // Fila 39 — el worker no exige los secretos del servicio HTTP
  // -------------------------------------------------------------------------
  it("fila 39: arranca sin AUTH_SECRET, AUTH_COOKIE_NAME ni PADDLE_WEBHOOK_SECRET", async () => {
    // Goal 13. Es lo que sostiene que `WorkerModule` no importe `ConfigModule`:
    // esa fábrica es `@Global()` y corre al construir el contenedor exigiendo
    // los tres, así que un worker que lo importara moriría en cada pasada
    // nombrando `AUTH_SECRET` — y el atajo de dárselos metería el secreto de
    // sesión, falsificable y sin revocación individual, en un tercer servicio.
    //
    // El helper de spawn ya borra los tres del entorno del hijo.
    const output = await runUntilLine(
      {
        DATABASE_URL: DEAD_DATABASE_URL,
        PADDLE_API_KEY: FAKE_API_KEY,
        PADDLE_ENV: "sandbox",
      },
      CONFIG_LINE
    );

    expect(output).toContain(CONFIG_LINE);
    expect(output).not.toContain("AUTH_SECRET");
    expect(output).not.toContain("AUTH_COOKIE_NAME");
    expect(output).not.toContain("PADDLE_WEBHOOK_SECRET");
    // Y el valor de la credencial no aparece nunca en la salida.
    expect(output).not.toContain(FAKE_API_KEY);
  }, 60_000);

  it("fila 39b: y el contenedor SE CONSTRUYE de verdad — muere en Postgres, no en la DI", async () => {
    // Ver la línea de configuración no prueba que el grafo resuelva: eso ocurre
    // después. Sin esta afirmación, un `WorkerModule` que no construyera —un
    // `API_CONFIG` sin exportar, un provider que `ReconcileModule` no ve— pasaría
    // la fila de arriba igual, porque el test mata al hijo antes.
    //
    // Se deja terminar a propósito, y es SEGURO: el barrido carga la tabla ANTES
    // de iterar Paddle, así que con `DEAD_DATABASE_URL` (puerto 1, rechaza al
    // instante) la pasada muere en Postgres y la API de Paddle no se llega a
    // tocar. Es la misma barrera que protege a todas las filas de este fichero.
    const result = await runWorker({
      DATABASE_URL: DEAD_DATABASE_URL,
      PADDLE_API_KEY: FAKE_API_KEY,
      PADDLE_ENV: "sandbox",
    });

    expect(result.code).toBe(1);
    expect(result.output).toContain(CONFIG_LINE);
    // El mensaje distingue los dos fallos porque se arreglan distinto: éste es
    // "la pasada falló", no "fallo construyendo el contenedor".
    expect(result.output).not.toContain("fallo construyendo el contenedor");
    expect(result.output).toContain("la pasada falló");
    // Registrado bajo §8.2: solo `name` y `code`.
    expect(result.output).toContain("code=ECONNREFUSED");
    expect(result.output).not.toContain("@");
  }, 60_000);
});
