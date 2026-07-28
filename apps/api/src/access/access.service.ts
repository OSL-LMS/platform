// Frontera gratis/pago: el trial de 7 días arranca con el PRIMER MENSAJE al
// tutor, no al hacer login — entrar a curiosear no gasta la prueba.
// Diseño: bóveda `30 Producto/Frontera gratis-pago.md` y
// `60 Negocio/Home post-lanzamiento.md` (decisión del 16 jul 2026).
//
// Portado desde `src/lib/access.ts` en PRD-003 fase 1. Mismos estados, mismos
// días de trial, mismo momento de arranque de la prueba (goal 6).
//
// AVISO (§6, §9 fila 18): el `email` NO se transforma. Hoy la llave llega sin
// normalizar por el camino del tutor mientras el webhook sí normaliza; esa
// asimetría existe en producción y es deliberada. Añadir un `.toLowerCase()`
// aquí al ver la asimetría es exactamente lo que haría un implementador
// razonable, y sería un cambio de comportamiento observable con su propio PRD.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { Injectable } from "@nestjs/common";

import { AnalyticsService } from "../analytics/analytics.service.ts";
import type { Subscription } from "../db/schema.ts";
import type { Access } from "./access.types.ts";
import { SubscriptionsRepository } from "./subscriptions.repository.ts";

const TRIAL_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export function evaluate(sub: Subscription): Access {
  if (sub.status === "active") {
    return { allowed: true, status: "active", trialDaysLeft: null };
  }

  if (sub.status === "trial" && sub.trialEndsAt && sub.trialEndsAt.getTime() > Date.now()) {
    const trialDaysLeft = Math.ceil((sub.trialEndsAt.getTime() - Date.now()) / DAY_MS);
    return { allowed: true, status: "trial", trialDaysLeft };
  }

  // Trial vencido o suscripción cancelada → sin acceso al tutor.
  return { allowed: false, status: sub.status as Access["status"], trialDaysLeft: 0 };
}

@Injectable()
export class AccessService {
  constructor(
    private readonly subscriptions: SubscriptionsRepository,
    private readonly analytics: AnalyticsService
  ) {}

  /** Solo LEE el acceso del estudiante; nunca crea el trial. Sin fila en
   *  `subscriptions` el estudiante puede ver el chat ("none"): lo que se cobra
   *  es hablar con el tutor, y eso pasa por `ensureTrial`. */
  async getAccess(email: string): Promise<Access> {
    const sub = await this.subscriptions.findByEmail(email);
    if (!sub) {
      return { allowed: true, status: "none", trialDaysLeft: null };
    }
    return evaluate(sub);
  }

  /** Escribe el estado que manda Paddle. */
  async setSubscriptionStatus(
    email: string,
    status: "active" | "canceled",
    paddleSubscriptionId?: string | null
  ): Promise<void> {
    await this.subscriptions.upsertStatus(email, {
      status,
      updatedAt: new Date(),
      // Un evento de cancelación no siempre trae el id: si no viene, no pisamos
      // el que ya estuviera guardado.
      ...(paddleSubscriptionId ? { paddleSubscriptionId } : {}),
    });
  }

  /** Crea el trial si no existe (7 días, sin tarjeta) y devuelve el acceso. */
  async ensureTrial(email: string): Promise<Access> {
    let sub = await this.subscriptions.findByEmail(email);

    if (!sub) {
      const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * DAY_MS);
      sub = await this.subscriptions.insertTrial(email, trialEndsAt);

      // Solo cuando ESTE request creó la fila. Si el insert chocó con la carrera
      // de abajo, el evento ya lo emitió el request que ganó: un trial, un evento.
      if (sub) {
        this.analytics.track(email, "trial_started", { trial_days: TRIAL_DAYS });
      }

      // Carrera improbable (dos primeros mensajes a la vez): si el insert chocó
      // por el unique de email, releemos la fila ya creada.
      if (!sub) {
        sub = await this.subscriptions.findByEmail(email);
      }
    }

    // El bloque de arriba deja SIEMPRE una fila: o la insertó este request, o la
    // insertó el que ganó la carrera y la releímos. Es la misma suposición que
    // hacía `src/lib/access.ts:122`, aquí escrita en vez de implícita.
    return evaluate(sub as Subscription);
  }
}
