// Límite de tasa de apps/api. Los números viven aquí y no dispersos en
// decoradores para que ajustarlos sea un solo sitio.
//
// POR QUÉ EXISTE ESTO. PRD-003 §8 aceptó explícitamente "sin límite de tasa", y
// la razón real por la que ese riesgo no había mordido era que el servicio no
// tenía dominio público — endurecimiento por topología, no por código. El paso 4
// de la migración le dio dominio para que Paddle alcance el webhook, así que la
// premisa dejó de ser cierta. PRD-003 §1.1 prohíbe que una propiedad de
// seguridad dependa del despliegue: el repositorio es público y quien lo levante
// en un VPS se llevaría el servicio expuesto sin haber hecho nada mal. Por eso
// el límite va en la aplicación y no en una regla de Cloudflare.
//
// Regla de código: identificadores en inglés, comentarios en español.

import type { ThrottlerOptions } from "@nestjs/throttler";

const MINUTE_MS = 60_000;

/** Límite por defecto: se aplica a todo lo que no declare otra cosa, y hoy eso
 *  es `/v1/access` y `/v1/access/trial`.
 *
 *  120/min es holgado para un estudiante real: una lectura al renderizar /chat
 *  más una escritura por mensaje al tutor. Está calibrado para no molestar, no
 *  para ser estricto — lo que corta es el bucle automatizado, no la persona.
 *
 *  El contador es POR CREDENCIAL en estas rutas, no por IP: el único llamante
 *  legítimo es el servidor de Next, así que por IP el límite sería un cubo único
 *  para el producto entero. La razón entera está en
 *  `common/bridge-throttler.guard.ts`, y no es un refinamiento — es lo que hace
 *  que el número de aquí signifique "por estudiante" y no "entre todos". */
export const DEFAULT_THROTTLE: ThrottlerOptions = { ttl: MINUTE_MS, limit: 120 };

/** El turno del tutor tiene la cota MÁS BAJA del servicio, y por una razón que
 *  no comparte con nadie más (PRD-005 §5.5): a diferencia de `/v1/access*`, cada
 *  petición aquí cuesta una llamada FACTURADA a Anthropic. El resto de endpoints
 *  gastan una consulta a Postgres; éste gasta dinero.
 *
 *  Diez turnos por minuto es holgado para una persona escribiendo —un mensaje
 *  cada seis segundos, sostenido durante un minuto— y acota un bucle. Sigue
 *  siendo por CREDENCIAL, no por IP, por lo mismo que el resto: el único llamante
 *  es el servidor de Next y todos los estudiantes comparten IP de origen. Ver
 *  `common/bridge-throttler.guard.ts`. */
export const TUTOR_TURNS_PER_MINUTE = 10;

export const TUTOR_THROTTLE: ThrottlerOptions = {
  ttl: MINUTE_MS,
  limit: TUTOR_TURNS_PER_MINUTE,
};

/** El webhook necesita su propia cota, más alta.
 *
 *  Paddle entrega en ráfaga —una pasada de dunning o de renovaciones manda
 *  muchos eventos seguidos— y un 429 ahí no pierde el pago (Paddle reintenta
 *  durante días) pero retrasa el acceso de quien acaba de pagar y ensucia el
 *  panel de entregas, que es justo donde se diagnostica un fallo real.
 *
 *  Aun así se acota: es el único endpoint que cualquiera alcanza sin token, y
 *  cada petición cuesta un HMAC sobre el cuerpo crudo antes de poder
 *  rechazarla. */
export const WEBHOOK_THROTTLE: ThrottlerOptions = { ttl: MINUTE_MS, limit: 600 };

/** Entrega de evidencia, por credencial (PRD-007 §5.4). Cinco al minuto es
 *  holgado para una persona entregando —pegar una URL, verla fallar, corregirla
 *  y reenviar— y corta el bucle.
 *
 *  Va en el HANDLER del `POST`, no en la clase: aplicarlo a la clase, que es lo
 *  que hace el único precedente (`tutor.controller.ts:34-37`), le daría al `GET`
 *  los 5/min de las escrituras. Fila 47 de §9. */
export const EVIDENCE_PER_CREDENTIAL_PER_MINUTE = 5;

export const EVIDENCE_THROTTLE: ThrottlerOptions = {
  ttl: MINUTE_MS,
  limit: EVIDENCE_PER_CREDENTIAL_PER_MINUTE,
};

/** El eje GLOBAL de salida, y el único que es un techo de verdad (§5.4).
 *
 *  EL DE ARRIBA NO ACOTA NADA A ESCALA. `BridgeThrottlerGuard:41-44` clava el
 *  cubo en `sha256(authorization)`, y el login es magic-link con sesión JWT: un
 *  buzón firmado N veces son N tokens válidos y N cubos, sin coste, porque el
 *  trial es gratis. El eje global es el único que sobrevive a la rotación de
 *  credenciales, y a diferencia de un cubo por IP no hereda el problema de
 *  origen compartido que `bridge-throttler.guard.ts` existe para resolver.
 *
 *  LOS TRES CAMPOS SON LOAD-BEARING Y CADA OMISIÓN FALLA EN SILENCIO:
 *
 *   - **Sin `getTracker` propio** la precedencia del guard es
 *     `routeOrClass || namedThrottler.getTracker || commonOptions.getTracker`, y
 *     el `override` de `BridgeThrottlerGuard` entra por `commonOptions`, o sea
 *     el último: el cubo "global" acabaría clavado en el hash de credencial otra
 *     vez, detrás del de 5/min, y no podría dispararse nunca.
 *   - **Sin `skipIf`** el guard evalúa TODOS los throttlers registrados en CADA
 *     petición, así que 60/min alcanzarían al turno del tutor, a `/v1/access` y
 *     al webhook de Paddle — al que `WEBHOOK_THROTTLE` provisiona a 600/min a
 *     propósito. Un control de seguridad que tumba el producto. Fila 46 de §9.
 *   - **Sin el registro en `forRoot`** (`app.module.ts`) una clave nueva en un
 *     decorador NO SOBRESCRIBE NADA y el endpoint se queda con la cota por
 *     defecto — la trampa que `tutor.controller.ts:29-33` ya dejó anotada.
 *
 *  EL `skipIf` COMPARA POR NOMBRE Y NO POR CLASE, y no es estilo:
 *  `ctx.getClass() !== EvidenceController` obligaría a este fichero a importar
 *  el controlador, mientras el controlador importa `EVIDENCE_THROTTLE` de aquí
 *  — un ciclo. `throttle.ts` hoy no tiene un solo import en tiempo de ejecución,
 *  y si se evalúa primero, el decorador `@Throttle` del controlador leería una
 *  vinculación todavía en TDZ: `ReferenceError` al arrancar. */
export const EVIDENCE_OUTBOUND_PER_MINUTE = 60;

export const EVIDENCE_OUTBOUND_THROTTLE: ThrottlerOptions = {
  name: "evidence-outbound",
  ttl: MINUTE_MS,
  limit: EVIDENCE_OUTBOUND_PER_MINUTE,
  getTracker: () => "global",
  // ACOTA AL HANDLER, NO A LA CLASE. `EvidenceController` tiene los dos, y el
  // `generateKey` por defecto incluye el nombre del handler, así que con la
  // clase sola el `GET` recibía su PROPIO cubo `evidence-outbound` — 60/min
  // global, cuando §5.2 le promete 120/min por credencial. `chat-client.tsx` lo
  // llama al montar, así que pasadas 60 cargas de chat en un minuto el panel
  // daba 429 a todo el mundo, y §4.3 hace que eso degrade EN SILENCIO a "sin
  // entrega": el estudiante vería vacío algo que sí entregó.
  //
  // El eje global existe para acotar CONEXIONES SALIENTES, y el `GET` no abre
  // ninguna. Sigue comparando por nombre y no por referencia, por el ciclo de
  // imports de arriba.
  skipIf: (context) =>
    context.getClass().name !== "EvidenceController" ||
    context.getHandler().name !== "submit",
};
