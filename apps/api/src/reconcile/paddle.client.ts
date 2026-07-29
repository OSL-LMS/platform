// El cliente de Paddle del reconciliador, como PROVIDER (PRD-004 §9).
//
// DOS COSAS QUE ESTE FICHERO COMPRA, Y NINGUNA ES "abstraer el SDK":
//
//  1. Es la costura por la que las filas en proceso sustituyen el cliente por un
//     doble sin red, igual que `SubscriptionsRepository` se sustituye hoy en las
//     filas 13-18 de PRD-003 §9. NINGÚN test alcanza la API real de Paddle.
//  2. El tipo `PaddleReader` de abajo es DELIBERADAMENTE más estrecho que
//     `Paddle`. §5.2 dice "ningún método de escritura del SDK se invoca"; con
//     este tipo eso deja de ser una promesa y pasa a ser algo que no compila:
//     por `PaddleReader` no existe `cancel()`, ni `update()`, ni `pause()`.
//     Quien necesite escribir contra Paddle tiene que ampliar este tipo, y esa
//     línea del diff es visible en una revisión.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { Environment, Paddle } from "@paddle/paddle-node-sdk";
import type { Provider } from "@nestjs/common";

import { API_CONFIG } from "../config.ts";
import type { WorkerConfig } from "../worker-config.ts";

export const PADDLE_CLIENT = "PADDLE_CLIENT";

/** Lo único que el barrido lee de cada suscripción (§5.2). `status` es `string`
 *  y `customData` es `unknown` a propósito: los dos nacen en un payload que el
 *  SDK deserializa sin validar, y `customData` lo elige quien inicia el checkout
 *  público. Los guardas están en `paddle-status.ts` y `paddle-email.ts`. */
export type ReportedSubscription = {
  readonly id: string;
  readonly status: string;
  readonly customData: unknown;
};

/** La superficie de SOLO LECTURA que el reconciliador consume. `Paddle` encaja
 *  estructuralmente; lo que no encaja es cualquier intento de escribir. */
export type PaddleReader = {
  subscriptions: {
    list(queryParams?: { perPage?: number }): AsyncIterable<ReportedSubscription>;
  };
};

export const paddleClientProvider: Provider = {
  provide: PADDLE_CLIENT,
  inject: [API_CONFIG],
  useFactory: (config: WorkerConfig): PaddleReader =>
    new Paddle(config.paddleApiKey, {
      // `paddleEnvironment` viene de `PADDLE_ENV` EXACTA (§7.1): aquí no se
      // reproduce el `?? sandbox` del servicio HTTP, porque apuntar a la cuenta
      // equivocada significa escribir la tabla de producción tomando por
      // evidencia unas suscripciones de prueba (§6.3).
      environment:
        config.paddleEnvironment === "production" ? Environment.production : Environment.sandbox,
    }),
};
