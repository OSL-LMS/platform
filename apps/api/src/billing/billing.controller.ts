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
// LO QUE CAMBIÓ CON PRD-004: el mapa de estados y el extractor de correo ya no
// viven aquí — salieron a `paddle-status.ts` y `paddle-email.ts` porque el
// reconciliador escribe la MISMA columna y dos criterios divergentes se pisan
// (PRD-004 §6.2). Este controlador es ahora un consumidor más de las dos
// piezas, y su comportamiento observable no se movió: filas 5 y 6 de PRD-004 §9.
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

import { Throttle } from "@nestjs/throttler";

import { AccessService } from "../access/access.service.ts";
import { AnalyticsService } from "../analytics/analytics.service.ts";
import { causeCode, errorName } from "../common/error-fields.ts";
import { API_CONFIG, type ApiConfig } from "../config.ts";
import { WEBHOOK_THROTTLE } from "../throttle.ts";
import { emailFromCustomData } from "./paddle-email.ts";
import { mapPaddleStatus } from "./paddle-status.ts";

// Cota propia, más alta que la global: Paddle entrega en ráfaga. Ver
// `throttle.ts` para los números y su razón.
@Throttle({ default: WEBHOOK_THROTTLE })
@Controller("v1/webhooks/paddle")
export class BillingController {
  private readonly logger = new Logger(BillingController.name);
  private readonly paddle: Paddle;

  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly access: AccessService,
    private readonly analytics: AnalyticsService
  ) {
    // Cadena vacía EXPLÍCITA, no `config.paddleApiKey`: desde PRD-004 §8.1 ese
    // campo ya no existe en `ApiConfig` y el servicio se NIEGA A ARRANCAR si
    // `PADDLE_API_KEY` aparece en su entorno. No rompe nada porque este
    // controlador no llama a un solo método de la API de Paddle: `unmarshal`
    // delega en el validador de firma sin tocar el cliente ni la clave.
    this.paddle = new Paddle("", {
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

        // El `?? "active"` conserva el comportamiento exacto de antes de
        // PRD-004: lo que había aquí era `data.status === "canceled"`, que
        // mandaba a `active` TODO lo que no fuera `canceled` —estados
        // desconocidos incluidos—. Quien decide qué hacer con un estado sin
        // mapear es el call site y no el mapa (§6.2), y el reconciliador toma la
        // decisión CONTRARIA —no escribe, cuenta `desconocido`— porque él
        // reintenta cada hora y esto se ejecuta una vez por evento confirmado.
        const status = mapPaddleStatus(data.status) ?? "active";

        if (email) {
          await this.access.setSubscriptionStatus(email, status, data.id);

          // Cierre del embudo. El evento sale del webhook y no del navegador
          // porque el pago solo es real cuando Paddle lo confirma aquí.
          this.analytics.track(
            email,
            status === "canceled" ? "subscription_canceled" : "subscription_activated",
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
