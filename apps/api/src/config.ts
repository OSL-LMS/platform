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
  anthropicApiKey: string;
  curriculumSlug: string;
  evidenceTimeoutMs: number;
  evidenceMaxRedirects: number;
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

function required(env: NodeJS.ProcessEnv, key: string, where = "PRD-003 §5.1 y §10 paso 1"): string {
  const value = env[key];
  if (!value) {
    throw new ConfigError(
      `apps/api no puede arrancar: falta la variable de entorno ${key}. Ver ${where}.`
    );
  }
  return value;
}

/** Como `required()`, más el control de que lo que hay es un número finito y
 *  positivo (PRD-007 §5.4).
 *
 *  POR QUÉ NO BASTA `Number(env.X)`. Hoy el único campo numérico es
 *  `port: Number(env.PORT ?? 3001)`, sin validar, y ahí un `NaN` se nota: el
 *  servidor no escucha. El presupuesto del verificador falla al revés y en
 *  silencio: `EVIDENCE_TIMEOUT_MS=3s` da `NaN`, `AbortSignal.timeout` lo
 *  coacciona a `0`, TODA comprobación aborta al instante, y el goal 4 —un fallo
 *  de comprobación es un 200 con `status: "failed"`— convierte la función rota
 *  entera en una respuesta correcta. Nada se pone rojo. Fila 54 de §9.
 *
 *  NOMBRA LA VARIABLE Y NUNCA IMPRIME SU VALOR, como `required()`. */
function requiredNumber(env: NodeJS.ProcessEnv, key: string, where: string): number {
  const value = Number(required(env, key, where));
  if (!Number.isFinite(value) || value <= 0) {
    throw new ConfigError(
      `apps/api no puede arrancar: la variable de entorno ${key} tiene que ser un ` +
        `número finito y positivo. Ver ${where}.`
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

    // OBLIGATORIAS Y SIN DEFECTO desde PRD-005 §5.1 (goal 6, mismo criterio que
    // el goal 5 de PRD-003). Las dos son del turno del tutor y las dos fallan
    // MAL si se les da un defecto:
    //
    //  - Sin `ANTHROPIC_API_KEY` el SDK cae a leerla de `process.env` por su
    //    cuenta y el fallo aparece en la primera petición de un estudiante, a
    //    mitad de un stream ya abierto, o sea en el sitio donde §5.4 ya no puede
    //    devolver un cuerpo de error.
    //  - `CURRICULUM_SLUG` sin defecto es la misma regla que la raíz ya aplica
    //    (`src/lib/curriculum.ts:43`): un `"contextia"` horneado dejaría un
    //    literal del cliente en el código y haría que un entorno mal configurado
    //    seleccionase un currículo ajeno en silencio en vez de fallar. NUNCA se
    //    deriva del request: es configuración de servidor.
    anthropicApiKey: required(env, "ANTHROPIC_API_KEY", "PRD-005 §5.1 y §10 paso C"),
    curriculumSlug: required(env, "CURRICULUM_SLUG", "PRD-005 §5.1 y §10 paso C"),

    // OBLIGATORIAS, SIN DEFECTO Y VALIDADAS COMO NÚMERO (PRD-007 §5.4). El paso
    // D de §10 las pone en Railway ANTES de mergear el código, por lo mismo que
    // las dos de arriba: este proceso sirve además acceso, cobro y el turno del
    // tutor, así que una variable ausente no degrada la evidencia — tumba los
    // tres.
    //
    //  - `EVIDENCE_TIMEOUT_MS` es el PRESUPUESTO TOTAL de una comprobación: DNS
    //    y saltos incluidos, medido contra un instante fijado una vez antes del
    //    bucle (§8.2 control 4). No es un tope por operación.
    //  - `EVIDENCE_MAX_REDIRECTS` son los saltos que el verificador sigue a
    //    mano. `http→https`, `apex→www` y un dominio propio encadenan hasta tres
    //    en GitHub Pages, que es el artefacto de L1.
    evidenceTimeoutMs: requiredNumber(env, "EVIDENCE_TIMEOUT_MS", "PRD-007 §5.4 y §10 paso D"),
    evidenceMaxRedirects: requiredNumber(
      env,
      "EVIDENCE_MAX_REDIRECTS",
      "PRD-007 §5.4 y §10 paso D"
    ),
  };
}
