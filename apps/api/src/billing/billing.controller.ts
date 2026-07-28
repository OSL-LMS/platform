// Webhook de Paddle: recibe eventos de suscripción y actualiza `subscriptions`.
// Verifica la firma con el SDK oficial sobre el body CRUDO.
//
// Portado en PRD-003 fase 1 desde el handler de Next que vivía en
// `src/app/api/paddle/webhook/route.ts` (borrado en el paso 5 de § 10: este es
// el único destino de Paddle desde entonces). No lleva sesión: se autentica por
// firma, así que no depende del puente de auth.
//
// DOS TRAMPAS QUE EL CAMBIO DE FRAMEWORK INTRODUCE:
//
//  1. `req.rawBody` es un **Buffer** (`NestFactory.create(..., { rawBody: true })`),
//     mientras que `unmarshal` recibe un **string** — en Next llegaba vía
//     `req.text()`. Sin el `.toString("utf8")` explícito la firma NO verifica
//     nunca. Fila 26 de §9.
//  2. El `catch` de abajo SE CONSERVA. El 200 que evita el bucle de reintentos
//     de Paddle depende de él, así que ese error nunca llega al filtro global y
//     la regla de registro de §8 la tiene que implementar este propio `catch`.
//     Quitarlo para "dejar que lo maneje el filtro" haría que Paddle recibiera
//     500 y reintentara en bucle. Filas 29 y 31 de §9.
//
// Regla de código: identificadores en inglés, comentarios en español.

import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Post,
  type RawBodyRequest,
  Req,
} from "@nestjs/common";
import { Environment, EventName, Paddle } from "@paddle/paddle-node-sdk";
import type { Request } from "express";

import { AccessService } from "../access/access.service.ts";
import { AnalyticsService } from "../analytics/analytics.service.ts";
import { causeCode, errorName } from "../common/error-fields.ts";
import { API_CONFIG, type ApiConfig } from "../config.ts";

// Extrae el correo de la app que enviamos como customData en el checkout. Es la
// llave para enlazar la suscripción de Paddle con nuestra fila de subscriptions.
//
// El `.toLowerCase()` SE CONSERVA: la asimetría con el camino del tutor —que
// usa el correo del token sin transformar— es deliberada y preexistente
// (§6, §9 filas 18 y 33).
export function emailFromCustomData(data: unknown): string | null {
  const cd = (data as { customData?: Record<string, unknown> } | null)?.customData;
  const email = cd?.email;
  return typeof email === "string" ? email.toLowerCase() : null;
}

@Controller("v1/webhooks/paddle")
export class BillingController {
  private readonly logger = new Logger(BillingController.name);
  private readonly paddle: Paddle;

  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly access: AccessService,
    private readonly analytics: AnalyticsService
  ) {
    this.paddle = new Paddle(config.paddleApiKey, {
      environment:
        config.paddleEnvironment === "production" ? Environment.production : Environment.sandbox,
    });
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  async handle(
    @Req() request: RawBodyRequest<Request>,
    @Headers("paddle-signature") signature = ""
  ): Promise<string> {
    const body = request.rawBody?.toString("utf8") ?? "";

    let event;
    try {
      event = await this.paddle.webhooks.unmarshal(body, this.config.paddleWebhookSecret, signature);
    } catch {
      return this.reject("firma inválida");
    }

    // Guarda DEFENSIVA, no comportamiento observable: con
    // @paddle/paddle-node-sdk@3.8.0 pineado esta rama es inalcanzable —
    // `unmarshal` está tipada `Promise<EventEntity>` sin `| null`, o lanza o
    // devuelve `Webhooks.fromJson(...)`, cuyo `default` devuelve un
    // `GenericEvent`. Se porta igual: cuesta dos líneas, mantiene la paridad
    // con docs/SYSTEM_ARTIFACT.md —que lo declara invariante— y sigue siendo
    // correcto si el contrato del SDK se afloja. La fila 25 de §9 lo prueba
    // mockeando `unmarshal`, porque con un cuerpo real firmado no se alcanza.
    if (!event) {
      return this.reject("sin evento");
    }

    try {
      await this.apply(event);
    } catch (err: unknown) {
      // Error no transitorio nuestro: devolvemos 200 igual para que Paddle no
      // reintente en bucle; lo registramos bajo las reglas de §8 (solo `name` y
      // `cause.code` — el mensaje de DrizzleQueryError lleva el correo).
      this.logger.error(
        `Error procesando webhook de Paddle: name=${errorName(err)} code=${causeCode(err)}`
      );
    }

    return "ok";
  }

  private reject(reason: "firma inválida" | "sin evento"): never {
    throw new BadRequestException(reason);
  }

  private async apply(event: { eventType: string; data: unknown }): Promise<void> {
    switch (event.eventType) {
      case EventName.SubscriptionCreated:
      case EventName.SubscriptionActivated:
      case EventName.SubscriptionUpdated: {
        const data = event.data as { id?: string; status?: string };
        const email = emailFromCustomData(event.data);
        const canceled = data.status === "canceled";
        if (email) {
          await this.access.setSubscriptionStatus(email, canceled ? "canceled" : "active", data.id);

          // Cierre del embudo. El evento sale del webhook y no del navegador
          // porque el pago solo es real cuando Paddle lo confirma aquí.
          this.analytics.track(
            email,
            canceled ? "subscription_canceled" : "subscription_activated",
            { paddle_event: event.eventType }
          );
        }
        break;
      }

      case EventName.SubscriptionCanceled: {
        const email = emailFromCustomData(event.data);
        if (email) {
          await this.access.setSubscriptionStatus(email, "canceled");

          this.analytics.track(email, "subscription_canceled", {
            paddle_event: event.eventType,
          });
        }
        break;
      }
    }
  }
}
