// Configuración del servicio, resuelta y VALIDADA una sola vez al arrancar.
//
// Goal 5 de PRD-003: si falta la configuración que el puente necesita, el
// servicio falla AL ARRANCAR, no en la primera petición de un estudiante.
//
// Y desde PRD-004 §8.1 hay un guarda que se dispara por lo contrario —porque una
// variable SÍ está—, el único de este fichero. Ver `resolveApiConfig()`.
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
  paddleEnvironment: "production" | "sandbox";
  posthogApiKey: string | undefined;
  posthogHost: string;
  poolMax: number;
};

/** Token de inyección de la configuración. */
export const API_CONFIG = "API_CONFIG";

/** Conexiones del pool reservadas al servicio HTTP. Reparto de PRD-004 §7.2:
 *  8 Next, 8 aquí, 1 el worker de reconciliación y 3 de margen para
 *  `drizzle-kit migrate` y los scripts de `scripts/`.
 *
 *  Vivía como constante de módulo en `drizzle.module.ts`, horneada en la fábrica
 *  del pool. Sale a la configuración porque el worker necesita el suyo (1) y la
 *  fábrica tiene que seguir siendo UNA: una segunda fábrica podría olvidar el
 *  listener `error` del pool, que no tiene test y cuya ausencia mata el proceso
 *  en silencio (§7.2). No se lee del entorno a propósito — el presupuesto de
 *  conexiones es una propiedad del reparto entre servicios, no una perilla. */
const HTTP_POOL_MAX = 8;

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
  // FALLA CERRADO ANTE LA PRESENCIA (PRD-004 §8.1). `PADDLE_API_KEY` es capaz de
  // cancelar suscripciones y emitir reembolsos, y este servicio no llama a un
  // solo método de la API de Paddle —`unmarshal` solo verifica firmas—, así que
  // tenerla aquí es radio de explosión sin contrapartida.
  //
  // POR QUÉ ES CÓDIGO Y NO UNA INSTRUCCIÓN DE DESPLIEGUE: los dos caminos que
  // llegan a la configuración prohibida fallan APARENTANDO ÉXITO. (1) El
  // `CMD` de la imagen es este `main.js`; si Railway ignora la sobrescritura de
  // arranque del servicio de reconciliación —ya lo hizo una vez, lo documenta la
  // cabecera del Dockerfile—, lo que levanta no es un error: es una API sana en
  // `0.0.0.0`, con dominio público, sosteniendo la credencial. (2) En
  // auto-hospedaje —repositorio público, AGPL-3.0— un solo `.env` en una sola
  // máquina lo heredan los dos entrypoints. PRD-003 §1.1 prohíbe que una
  // propiedad de seguridad dependa de dónde se ponga una variable.
  //
  // Una cadena VACÍA también cuenta como presente. Lo que el operador comprueba
  // es "está o no está"; un segundo criterio invisible ("está pero vacía, y
  // entonces vale") es justo la clase de matiz que este guarda existe para no
  // tener. El mensaje NOMBRA la variable y nunca imprime su valor.
  if (env.PADDLE_API_KEY !== undefined) {
    throw new ConfigError(
      "apps/api no puede arrancar: PADDLE_API_KEY está presente en su entorno. " +
        "Esa credencial pertenece SOLO al servicio de reconciliación; el servicio " +
        "HTTP no la usa. Retírala de este servicio. Ver PRD-004 §8.1."
    );
  }

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

    // FALLA ABIERTO —`sandbox` salvo que valga exactamente `production`— y aquí
    // es tolerable: este servicio solo verifica firmas, y una firma se valida
    // igual apuntando al entorno equivocado. El worker de reconciliación exige
    // la variable EXACTA (PRD-004 §7.1) porque él lee de una cuenta y escribe en
    // una tabla: leer sandbox y escribir producción no daría error ni señal.
    paddleEnvironment: env.PADDLE_ENV === "production" ? "production" : "sandbox",

    // Sin clave, la telemetría es un no-op silencioso — igual que en la raíz.
    posthogApiKey: env.POSTHOG_API_KEY,
    posthogHost: env.POSTHOG_HOST ?? "https://us.i.posthog.com",

    poolMax: HTTP_POOL_MAX,
  };
}
