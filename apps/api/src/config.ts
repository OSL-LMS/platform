// Configuración del servicio, resuelta y VALIDADA una sola vez al arrancar.
//
// Goal 5 de PRD-003: si falta la configuración que el puente necesita, el
// servicio falla AL ARRANCAR, no en la primera petición de un estudiante.
//
// Regla de código: identificadores en inglés, comentarios en español.

/** Error de configuración. Se distingue por tipo porque es el ÚNICO error cuyo
 *  mensaje se puede registrar entero: lo escribimos nosotros y no lleva PII.
 *  Todo lo demás cae bajo las reglas de registro de §8 (solo `name` y
 *  `cause.code`). */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

export type ApiConfig = {
  port: number;
  databaseUrl: string;
  authSecret: string;
  authCookieName: string;
  paddleWebhookSecret: string;
  paddleApiKey: string;
  paddleEnvironment: "production" | "sandbox";
  posthogApiKey: string | undefined;
  posthogHost: string;
};

/** Token de inyección de la configuración. */
export const API_CONFIG = "API_CONFIG";

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) {
    throw new ConfigError(
      `apps/api no puede arrancar: falta la variable de entorno ${key}. ` +
        "Ver PRD-003 §5.1 y §10 paso 1."
    );
  }
  return value;
}

export function resolveApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return {
    port: Number(env.PORT ?? 3001),
    databaseUrl: required(env, "DATABASE_URL"),
    authSecret: required(env, "AUTH_SECRET"),

    // OBLIGATORIA y SIN DEFECTO. El `salt` de Auth.js es el nombre de la
    // cookie, y Auth.js elige el prefijo `__Secure-` según el PROTOCOLO de la
    // petición original. apps/api recibe un Bearer y estructuralmente no puede
    // ver ese protocolo, así que cualquier defecto sería una conjetura que
    // acierta en los dos entornos de hoy y falla en `pnpm build && pnpm start`
    // local o en un despliegue sin TLS. Mismo patrón que CURRICULUM_SLUG.
    authCookieName: required(env, "AUTH_COOKIE_NAME"),

    paddleWebhookSecret: required(env, "PADDLE_WEBHOOK_SECRET"),

    // apps/api NO recibe PADDLE_API_KEY (§8): `unmarshal` usa únicamente el
    // secreto del webhook, y la ruta de Next ya corría con la cadena vacía.
    // Replicar una credencial capaz de cancelar suscripciones y emitir
    // reembolsos ampliaría el radio de explosión sin comprar nada.
    paddleApiKey: env.PADDLE_API_KEY ?? "",
    paddleEnvironment: env.PADDLE_ENV === "production" ? "production" : "sandbox",

    // Sin clave, la telemetría es un no-op silencioso — igual que en la raíz.
    posthogApiKey: env.POSTHOG_API_KEY,
    posthogHost: env.POSTHOG_HOST ?? "https://us.i.posthog.com",
  };
}
