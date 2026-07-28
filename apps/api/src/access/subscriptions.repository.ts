// Acceso a la tabla `subscriptions`. Es la costura que permite que las filas
// 13-18 de §9 mockeen el repositorio con un override de provider y no toquen
// Postgres.
//
// Las sentencias son EXACTAMENTE las de `src/lib/access.ts`: el
// `onConflictDoUpdate` y el `onConflictDoNothing` son lo que hace segura la
// convivencia de los dos servicios durante la migración (§6, §10 paso 4).
//
// Regla de código: identificadores en inglés, comentarios en español.

import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";

import { DRIZZLE, type Database } from "../db/drizzle.module.ts";
import { subscriptions, type Subscription } from "../db/schema.ts";

/** Lo que escribe el webhook. `paddleSubscriptionId` es opcional a propósito:
 *  un evento de cancelación no siempre trae el id. */
export type SubscriptionChanges = {
  status: "active" | "canceled";
  updatedAt: Date;
  paddleSubscriptionId?: string;
};

@Injectable()
export class SubscriptionsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async findByEmail(email: string): Promise<Subscription | undefined> {
    const existing = await this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.email, email))
      .limit(1);

    return existing[0];
  }

  /** Inserta el trial si no existe. Devuelve la fila SOLO cuando la creó esta
   *  llamada: el `returning()` vacío del `onConflictDoNothing` es el árbitro de
   *  la idempotencia de §5.2, y no el proceso que atiende. */
  async insertTrial(email: string, trialEndsAt: Date): Promise<Subscription | undefined> {
    const inserted = await this.db
      .insert(subscriptions)
      .values({ email, status: "trial", trialEndsAt })
      .onConflictDoNothing({ target: subscriptions.email })
      .returning();

    return inserted[0];
  }

  /** UPSERT a propósito: el pago puede llegar sin fila previa —/checkout es
   *  público y los flujos hospedados de Paddle no pasan por el tutor—, y un
   *  UPDATE a secas afectaría 0 filas en silencio, dejando a alguien pagando
   *  sin acceso. */
  async upsertStatus(email: string, changes: SubscriptionChanges): Promise<void> {
    await this.db
      .insert(subscriptions)
      .values({ email, ...changes })
      .onConflictDoUpdate({ target: subscriptions.email, set: changes });
  }
}
