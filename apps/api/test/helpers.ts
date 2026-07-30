// Utilidades compartidas por los tests de apps/api. NO es un fichero de test:
// `vitest.config.ts` solo recoge `*.spec.ts` y `*.e2e-spec.ts`.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { resolve } from "node:path";

import { encode } from "@auth/core/jwt";
import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { TestingModule } from "@nestjs/testing";

import { configureApp } from "../src/bootstrap.ts";

export const API_ROOT = resolve(import.meta.dirname, "..");
export const REPO_ROOT = resolve(import.meta.dirname, "../../..");

export const TEST_AUTH_SECRET = "secreto-de-pruebas-suficientemente-largo-para-hkdf";
export const TEST_COOKIE_NAME = "authjs.session-token";
export const SECURE_COOKIE_NAME = "__Secure-authjs.session-token";
export const TEST_PADDLE_SECRET = "pdl_ntfset_secreto_de_pruebas";

/** Clave FALSA de Anthropic. NINGUNA fila la usa contra la red: los tests del
 *  tutor sustituyen `ANTHROPIC_CLIENT` con un doble, y donde no lo sustituyen
 *  (acceso, cobro, tasa) el cliente se construye y nunca se llama. Está para
 *  pasar el guarda de `resolveApiConfig()`, que la exige sin defecto. */
export const TEST_ANTHROPIC_KEY = "sk-ant-clave-de-pruebas";

/** Currículo de pruebas. Los tests que necesitan nodos los insertan bajo este
 *  slug; los que no, se benefician de que no exista — el par vacío es la rama
 *  "el estudiante no ha declarado lección" y no un error. NUNCA es `contextia`:
 *  un test que apuntara al currículo real dependería de que estuviera cargado. */
export const TEST_CURRICULUM_SLUG = "curriculo-de-pruebas";

/** Base inalcanzable, no apagada: puerto 1 rechaza la conexión al instante, que
 *  es justo lo que hace falta para demostrar que un 401 no llega a Postgres. */
export const DEAD_DATABASE_URL = "postgres://nadie:nadie@127.0.0.1:1/inalcanzable";

// ---------------------------------------------------------------------------
// Base de pruebas
// ---------------------------------------------------------------------------

/** ¿Son la misma base? Se compara host + puerto + nombre ya parseados, no la
 *  cadena. Mismo criterio que `scripts/check-curriculum-load.ts`; duplicado a
 *  propósito porque aquel fichero es un script que se ejecuta al importarlo. */
export function sameDatabase(a: string, b: string): boolean {
  try {
    const [x, y] = [new URL(a), new URL(b)];
    return (
      x.hostname === y.hostname && (x.port || "5432") === (y.port || "5432") && x.pathname === y.pathname
    );
  } catch {
    // Si alguna no parsea, se cae del lado seguro: se asume que sí.
    return true;
  }
}

/** URL de la base DESECHABLE de estos tests. Aborta si falta o si apunta a la
 *  misma base que `DATABASE_URL`: aquí se borran filas de `subscriptions`, y
 *  este repositorio lo usan principiantes que corren comandos con la
 *  `DATABASE_URL` que tengan en el entorno. */
export function requireTestDatabaseUrl(): string {
  const url = process.env.API_TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "Falta API_TEST_DATABASE_URL. Estos tests ESCRIBEN y BORRAN en `subscriptions`:\n" +
        "  apunta a una base desechable, nunca a la de producción ni a la de desarrollo.\n" +
        "  Ejemplo: API_TEST_DATABASE_URL=postgres://user:pass@localhost:5432/api_test pnpm --filter api test"
    );
  }
  if (process.env.DATABASE_URL && sameDatabase(url, process.env.DATABASE_URL)) {
    throw new Error("API_TEST_DATABASE_URL apunta a la MISMA base que DATABASE_URL. Aborto.");
  }
  return url;
}

let migrated = false;

/** Aplica las migraciones de la raíz a la base de pruebas. Se usa el propio
 *  `drizzle-kit migrate` en vez de un DDL a mano para que el esquema de los
 *  tests no derive del de producción. Idempotente. */
export function migrateTestDatabase(url: string): void {
  if (migrated) return;
  execFileSync("pnpm", ["exec", "drizzle-kit", "migrate"], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
  migrated = true;
}

// ---------------------------------------------------------------------------
// Entorno del servicio
// ---------------------------------------------------------------------------

/** Deja `process.env` con la configuración mínima para que `resolveApiConfig()`
 *  no lance. Se llama ANTES de compilar el módulo: `ConfigModule` resuelve la
 *  configuración al construir el contenedor. */
export function applyApiEnv(overrides: Record<string, string | undefined> = {}): void {
  const base: Record<string, string | undefined> = {
    DATABASE_URL: DEAD_DATABASE_URL,
    AUTH_SECRET: TEST_AUTH_SECRET,
    AUTH_COOKIE_NAME: TEST_COOKIE_NAME,
    PADDLE_WEBHOOK_SECRET: TEST_PADDLE_SECRET,
    // Las dos de PRD-005 §5.1: obligatorias y sin defecto, así que sin ellas
    // `resolveApiConfig()` tumba TODA suite que construya el contenedor. Se
    // ponen con valor explícito y no se heredan del shell a propósito — quien
    // tenga una `ANTHROPIC_API_KEY` real exportada no debe verla entrar en un
    // test, y `CURRICULUM_SLUG` heredada apuntaría al currículo de verdad.
    ANTHROPIC_API_KEY: TEST_ANTHROPIC_KEY,
    CURRICULUM_SLUG: TEST_CURRICULUM_SLUG,
    // Sin clave de PostHog el cliente es null y `track()` es un no-op: los
    // tests que cuentan eventos espían el provider, no la red.
    POSTHOG_API_KEY: undefined,
    // Se BORRA, y es obligatorio borrarla: desde PRD-004 §8.1 `resolveApiConfig()`
    // lanza si la variable está PRESENTE, así que a un desarrollador que la
    // tenga exportada en su shell se le caería la suite entera con un mensaje
    // que nombra el problema equivocado. Éste es el primero de los dos sitios
    // que la limpian; el otro es `bootEntrypoint` en `build-boot.e2e-spec.ts`,
    // que esparce `...process.env` y no pasa por aquí. Fila 42 de PRD-004 §9.
    PADDLE_API_KEY: undefined,
    ...overrides,
  };

  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

// ---------------------------------------------------------------------------
// Aplicación bajo test
// ---------------------------------------------------------------------------

export type RunningApp = {
  app: NestExpressApplication;
  baseUrl: string;
};

/** Levanta la aplicación con la MISMA configuración que `main.ts` (cota de
 *  cuerpo, filtro global, ValidationPipe) en un puerto libre. */
export async function startApp(moduleRef: TestingModule): Promise<RunningApp> {
  const app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true });
  configureApp(app);
  await app.listen(0, "127.0.0.1");
  const baseUrl = (await app.getUrl()).replace("[::1]", "127.0.0.1");
  return { app, baseUrl };
}

export async function stopApp(app: INestApplication | undefined): Promise<void> {
  if (app) await app.close();
}

// ---------------------------------------------------------------------------
// Sesión de Auth.js
// ---------------------------------------------------------------------------

export type SessionClaims = Record<string, unknown>;

/** Emite un JWE idéntico al que emite Auth.js desde Next. `salt` = nombre de
 *  cookie, que es exactamente lo que hace `@auth/core`. */
export function sessionToken(
  claims: SessionClaims,
  options: { secret?: string; salt?: string; maxAge?: number } = {}
): Promise<string> {
  return encode({
    token: claims,
    secret: options.secret ?? TEST_AUTH_SECRET,
    salt: options.salt ?? TEST_COOKIE_NAME,
    ...(options.maxAge === undefined ? {} : { maxAge: options.maxAge }),
  });
}

// ---------------------------------------------------------------------------
// Webhook de Paddle
// ---------------------------------------------------------------------------

/** Cuerpo de un evento de suscripción con la forma mínima que el SDK sabe
 *  deserializar (`billing_cycle` e `items` no son opcionales en su entidad). */
export function paddleBody(
  eventType: string,
  data: Record<string, unknown> = {},
  customData: Record<string, unknown> | null = { email: "Estudiante@Ejemplo.test" }
): string {
  const now = new Date().toISOString();
  return JSON.stringify({
    event_id: "evt_prueba",
    notification_id: "ntf_prueba",
    occurred_at: now,
    event_type: eventType,
    data: {
      id: "sub_prueba",
      status: "active",
      customer_id: "ctm_prueba",
      address_id: "add_prueba",
      currency_code: "USD",
      created_at: now,
      updated_at: now,
      collection_mode: "automatic",
      billing_cycle: { interval: "month", frequency: 1 },
      items: [],
      custom_data: customData,
      ...data,
    },
  });
}

/** Firma en el formato del SDK: `ts=<unix>;h1=<hmac-sha256(ts:body)>`. El
 *  `offsetSeconds` negativo es lo que ejercita la ventana de frescura de 5 s. */
export function paddleSignature(
  body: string,
  options: { secret?: string; offsetSeconds?: number } = {}
): string {
  const secret = options.secret ?? TEST_PADDLE_SECRET;
  const ts = Math.floor(Date.now() / 1000) + (options.offsetSeconds ?? 0);
  const h1 = createHmac("sha256", secret).update(`${ts}:${body}`).digest("hex");
  return `ts=${ts};h1=${h1}`;
}

export function postWebhook(baseUrl: string, body: string, signature: string): Promise<Response> {
  return fetch(`${baseUrl}/v1/webhooks/paddle`, {
    method: "POST",
    headers: { "content-type": "application/json", "paddle-signature": signature },
    body,
  });
}

// ---------------------------------------------------------------------------
// Captura de salida
// ---------------------------------------------------------------------------

/** Captura TODO lo que se escribe a stdout y stderr durante una ventana. Se
 *  captura la escritura real y no las llamadas al `Logger` de Nest a propósito:
 *  lo que §8 prohíbe es que el correo llegue a los logs, venga de donde venga. */
export function captureOutput(): { stop: () => string } {
  const chunks: string[] = [];
  const originalStdout = process.stdout.write.bind(process.stdout);
  const originalStderr = process.stderr.write.bind(process.stderr);

  const intercept = (chunk: unknown): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  };

  process.stdout.write = intercept as typeof process.stdout.write;
  process.stderr.write = intercept as typeof process.stderr.write;

  return {
    stop() {
      process.stdout.write = originalStdout;
      process.stderr.write = originalStderr;
      return chunks.join("");
    },
  };
}
