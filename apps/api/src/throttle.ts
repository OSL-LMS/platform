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
