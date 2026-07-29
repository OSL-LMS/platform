// Configuración del worker de reconciliación, resuelta y VALIDADA una sola vez
// al arrancar (PRD-004 §7.1).
//
// NO ES `resolveApiConfig()` CON OTRO NOMBRE, y las diferencias son el PRD
// entero:
//
//  - `PADDLE_API_KEY` aquí es OBLIGATORIA. Allí es un motivo de rechazo del
//    arranque (§8.1): la credencial que puede cancelar suscripciones y emitir
//    reembolsos pertenece a este proceso y solo a este.
//  - `PADDLE_ENV` aquí es obligatoria y EXACTA. `config.ts` falla abierto
//    (`=== "production" ? … : "sandbox"`) y allí es tolerable porque el servicio
//    HTTP solo verifica firmas. Aquí significaría leer la cuenta de sandbox y
//    escribir la tabla de producción: sin error, sin señal, y tomando por
//    evidencia unas suscripciones de prueba que llevan correos reales en su
//    `customData` (§6.3).
//  - Ni `AUTH_SECRET`, ni `AUTH_COOKIE_NAME`, ni `PADDLE_WEBHOOK_SECRET`. El
//    worker no atiende peticiones y no verifica firmas; exigirlos metería el
//    secreto de sesión —falsificable, sin revocación individual— en un tercer
//    servicio (goal 13, §7.1).
//
// EL MÓDULO DE ABAJO ES LA OTRA MITAD, y la que trabaja: en Nest un módulo
// global no registra sus providers globalmente, registra LO QUE EXPORTA. La
// fábrica de `PG_POOL` (`db/drizzle.module.ts`) y `AnalyticsService` inyectan
// `API_CONFIG` sin importar nada, así que sin ese `exports` el contenedor del
// worker no construye.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { Global, Module } from "@nestjs/common";

import { API_CONFIG, ConfigError, type ApiConfig } from "./config.ts";

/** Lo que el worker comparte con el servicio HTTP a través del token
 *  `API_CONFIG`. Se deriva de `ApiConfig` con `Pick` a propósito: son los cuatro
 *  campos que leen los providers COMPARTIDOS (`PG_POOL` lee `databaseUrl` y
 *  `poolMax`; `AnalyticsService` lee los dos de PostHog), y atarlos por tipo es
 *  lo que hace que renombrar uno en `config.ts` rompa aquí en vez de fallar en
 *  la DI del worker, que nadie ejercita en cada build. */
type SharedInjectedConfig = Pick<
  ApiConfig,
  "databaseUrl" | "poolMax" | "posthogApiKey" | "posthogHost"
>;

export type WorkerConfig = SharedInjectedConfig & {
  paddleApiKey: string;
  paddleEnvironment: "production" | "sandbox";
  /** Solo el valor EXACTO `"true"` de `RECONCILE_APPLY` la pone a `true`. El
   *  modo que escribe se pide explícitamente; el que no escribe es lo que pasa
   *  por defecto y ante cualquier error de configuración (goal 7). */
  reconcileApply: boolean;
  reconcileDeadlineMs: number;
};

/** Una conexión. Reparto de §7.2: 8 Next, 8 el servicio HTTP, 1 aquí y 3 de
 *  margen para `drizzle-kit migrate` y los scripts. Una pasada es un recorrido
 *  secuencial: no hay nada que paralelizar. */
const WORKER_POOL_MAX = 1;

/** Invariante de §5.1: MENOR que el periodo del cron (1 h en §10 paso 3). Si se
 *  sube por encima, dos pasadas pueden solaparse. */
export const DEFAULT_RECONCILE_DEADLINE_MS = 300_000;

function required(env: NodeJS.ProcessEnv, key: string, why: string): string {
  const value = env[key];
  if (!value) {
    throw new ConfigError(
      `El worker de reconciliación no puede arrancar: falta la variable de entorno ${key}. ${why} ` +
        "Ver PRD-004 §7.1 y §10 paso 3."
    );
  }
  return value;
}

/** `production` o `sandbox`, sin conjeturas. Mismo patrón que `AUTH_COOKIE_NAME`
 *  en `config.ts`: una variable cuyo valor equivocado no produce error, solo
 *  daño, no puede tener defecto. */
function requirePaddleEnvironment(env: NodeJS.ProcessEnv): "production" | "sandbox" {
  const value = env.PADDLE_ENV;
  if (value === "production" || value === "sandbox") return value;

  throw new ConfigError(
    "El worker de reconciliación no puede arrancar: PADDLE_ENV tiene que valer " +
      'EXACTAMENTE "production" o "sandbox". A diferencia del servicio HTTP ' +
      "(`config.ts`), aquí no hay defecto: leer la cuenta equivocada significa " +
      "escribir la tabla de producción con suscripciones de prueba, sin error y " +
      "sin señal. Ver PRD-004 §6.3 y §7.1."
  );
}

function resolveDeadlineMs(env: NodeJS.ProcessEnv): number {
  const raw = env.RECONCILE_DEADLINE_MS;
  if (raw === undefined || raw === "") return DEFAULT_RECONCILE_DEADLINE_MS;

  const parsed = Number(raw);
  // Un valor ilegible NO cae al defecto en silencio: el deadline es lo único
  // que corta una pasada que no termina (§8.4, "sin límite de páginas"), así que
  // un `NaN` heredado de un typo dejaría al cron sin su único freno.
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(
      "El worker de reconciliación no puede arrancar: RECONCILE_DEADLINE_MS tiene " +
        `que ser un entero de milisegundos mayor que 0. Ver PRD-004 §5.1.`
    );
  }
  return parsed;
}

export function resolveWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  // El orden es el de la tabla de §7.1 y es deliberado: lo que el operador tiene
  // que poner primero se le nombra primero.
  const databaseUrl = required(env, "DATABASE_URL", "Es la misma base que el servicio HTTP.");
  const paddleApiKey = required(
    env,
    "PADDLE_API_KEY",
    "Debe ser una clave de SOLO LECTURA sobre suscripciones (§8.1 control 1)."
  );
  const paddleEnvironment = requirePaddleEnvironment(env);
  const reconcileApply = env.RECONCILE_APPLY === "true";

  // OBLIGATORIA SOLO CON LA ESCRITURA ACTIVADA, y la asimetría es el goal 14:
  // sin clave, `AnalyticsService` deja el cliente a `null` y `track()` retorna en
  // la primera línea, así que el rastro de cada escritura aplicada sería un
  // no-op silencioso en producción sin que nada se pusiera rojo. Se puede
  // observar sin telemetría; no se puede cambiar el acceso de alguien sin dejar
  // rastro.
  const posthogApiKey = reconcileApply
    ? required(
        env,
        "POSTHOG_API_KEY",
        "Con RECONCILE_APPLY=true cada escritura tiene que dejar rastro (goal 14)."
      )
    : env.POSTHOG_API_KEY;

  return {
    databaseUrl,
    paddleApiKey,
    paddleEnvironment,
    posthogApiKey,
    posthogHost: env.POSTHOG_HOST ?? "https://us.i.posthog.com",
    reconcileApply,
    reconcileDeadlineMs: resolveDeadlineMs(env),
    poolMax: WORKER_POOL_MAX,
  };
}

/** `@Global()` **y** `exports: [API_CONFIG]`. Las dos mitades hacen falta y la
 *  segunda es la que trabaja (§7.1): `DrizzleModule` y `AnalyticsModule` no
 *  importan nada, así que solo resuelven `API_CONFIG` si un módulo global lo
 *  EXPORTA. Declararlo como provider local de `WorkerModule` haría fallar el
 *  contenedor en la construcción.
 *
 *  Mismo token que el servicio HTTP a propósito: los providers compartidos no
 *  saben —ni tienen por qué— en cuál de los dos procesos están. */
@Global()
@Module({
  providers: [{ provide: API_CONFIG, useFactory: () => resolveWorkerConfig() }],
  exports: [API_CONFIG],
})
export class WorkerConfigModule {}
