// Acceso a la tabla `subscriptions`. Es la costura que permite que las filas
// 13-18 de PRD-003 §9 mockeen el repositorio con un override de provider y no
// toquen Postgres.
//
// Las sentencias son EXACTAMENTE las de `src/lib/access.ts`: el
// `onConflictDoUpdate` y el `onConflictDoNothing` son lo que hace segura la
// convivencia de los dos servicios durante la migración (PRD-003 §6, §10 paso 4).
//
// LO QUE AÑADE PRD-004: `listAll` y `updateStatusIfUnchanged`, que usa SOLO el
// reconciliador, más un parámetro opcional en `upsertStatus`. Las tres firmas
// existentes siguen valiendo lo mismo llamadas como hasta ahora — el servicio
// HTTP no cambia una línea— y eso es una condición del PRD, no una cortesía: las
// filas 5 y 6 de PRD-004 §9 sostienen que el webhook escriba exactamente lo que
// escribía.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { Inject, Injectable } from "@nestjs/common";
import { and, eq, ne } from "drizzle-orm";

import { DRIZZLE, type Database } from "../db/drizzle.module.ts";
import { subscriptions, type Subscription } from "../db/schema.ts";

/** Lo que escribe el webhook. `paddleSubscriptionId` es opcional a propósito:
 *  un evento de cancelación no siempre trae el id. */
export type SubscriptionChanges = {
  status: "active" | "canceled";
  updatedAt: Date;
  paddleSubscriptionId?: string;
};

/** Lo que escribe el RECONCILIADOR: lo mismo, menos la mitad que no le está
 *  permitida.
 *
 *  PRD-004 §1.3 es la propiedad central del diseño —el barrido concede acceso y
 *  no lo quita— y hasta aquí la sostenían dos literales `"active"` en los dos
 *  call sites de `reconcile.service.ts`. Eso es una convención: un `revert`
 *  descuidado, un refactor que unifique las dos ramas, o alguien implementando
 *  §11 sin haber leído §1.3, la rompen sin que el compilador diga nada — y el
 *  fallo que producen, una fila `canceled` escrita por el barrido, es una
 *  denegación de acceso irreversible (`access.service.ts:76-93`).
 *
 *  Tiparlo cuesta una línea y lo convierte en algo que no compila. Es el mismo
 *  patrón que `reconcile/paddle.client.ts` aplica al cliente de Paddle, donde
 *  `cancel()` ni siquiera existe en el tipo inyectado. */
export type ReconcilerChanges = SubscriptionChanges & { status: "active" };

/** Las cuatro columnas que el barrido necesita de cada fila (PRD-004 §6.4). No
 *  se traen `trial_ends_at` ni las marcas de tiempo porque el barrido no las
 *  lee y NUNCA las escribe: pedir menos columnas es también la forma de que un
 *  cambio futuro no las arrastre por descuido a un `set`. */
export type SubscriptionSnapshot = Pick<
  Subscription,
  "id" | "email" | "status" | "paddleSubscriptionId"
>;

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
   *  sin acceso.
   *
   *  `preserveCanceled` es del reconciliador y SOLO de él (PRD-004 §6.5). Con él,
   *  el `onConflictDoUpdate` lleva predicado y no pisa una fila que ya esté
   *  `canceled`: el alta del barrido solo ocurre cuando el `Map` de la carga no
   *  tenía el correo, y una fila que aparece entre la carga y la escritura la
   *  creó el webhook con un dato MÁS FRESCO. Sin el predicado, un upsert
   *  incondicional la dejaría en `active` — y como el barrido nunca revoca,
   *  para siempre.
   *
   *  EL DEFECTO ES SIN PREDICADO, y tiene que serlo: el webhook llega a
   *  `active` desde `canceled` cada vez que alguien se vuelve a suscribir, así
   *  que aplicárselo a él sería negarle esa escritura.
   *
   *  @returns `true` si la sentencia dejó una fila (insertada o actualizada).
   *  `false` solo es posible con `preserveCanceled`, y significa que el
   *  conflicto se descartó: el llamante lo cuenta como `desincronizado`. */
  // Las dos firmas atan `preserveCanceled` a `ReconcilerChanges`, que es lo que
  // hace comprobable el "SOLO de él" de arriba: por esta rama pasa el ALTA del
  // barrido, o sea la que puede crear una fila donde no había ninguna, que es
  // la escritura irreversible de §1.3. Sin ellas el invariante estaría tipado a
  // medias — `updateStatusIfUnchanged` sí, el alta no.
  async upsertStatus(
    email: string,
    changes: ReconcilerChanges,
    options: { preserveCanceled: true }
  ): Promise<boolean>;
  async upsertStatus(
    email: string,
    changes: SubscriptionChanges,
    options?: { preserveCanceled?: false }
  ): Promise<boolean>;
  async upsertStatus(
    email: string,
    changes: SubscriptionChanges,
    options: { preserveCanceled?: boolean } = {}
  ): Promise<boolean> {
    const written = await this.db
      .insert(subscriptions)
      .values({ email, ...changes })
      .onConflictDoUpdate({
        target: subscriptions.email,
        set: changes,
        ...(options.preserveCanceled ? { setWhere: ne(subscriptions.status, "canceled") } : {}),
      })
      .returning({ id: subscriptions.id });

    return written.length > 0;
  }

  /** La tabla entera, indexable en memoria por el barrido (PRD-004 §6.4).
   *
   *  UNA CARGA Y NO UN `SELECT … LIMIT 1` POR ITERACIÓN, y no es una
   *  optimización: `subscriptions.email` es `text` plano con unique, así que
   *  `Estudiante@Ejemplo.test` y `estudiante@ejemplo.test` conviven como dos
   *  filas. Un `LIMIT 1` devolvería una arbitraria —si es la que ya está
   *  `active`, no hay divergencia que reparar y el estudiante sigue bloqueado—,
   *  que es exactamente el escenario que el PRD existe para arreglar. */
  async listAll(): Promise<SubscriptionSnapshot[]> {
    return this.db
      .select({
        id: subscriptions.id,
        email: subscriptions.email,
        status: subscriptions.status,
        paddleSubscriptionId: subscriptions.paddleSubscriptionId,
      })
      .from(subscriptions);
  }

  /** Compare-and-set: `UPDATE … WHERE id = $1 AND status = $observado`, donde
   *  `$observado` es el estado que la fila tenía CUANDO SE CARGÓ LA TABLA
   *  (PRD-004 §6.6).
   *
   *  La carga única abre una ventana de hasta `RECONCILE_DEADLINE_MS` entre
   *  lectura y escritura. El caso que lo hace necesario aun escribiendo solo
   *  hacia `active`: se lee Paddle todavía `active` y la fila local en `trial`
   *  vencido —divergencia que SÍ se va a escribir—, el estudiante cancela, el
   *  webhook escribe `canceled`, y el barrido pisaría un dato más fresco. Como
   *  el barrido nunca revoca, esa fila se quedaría `active` para siempre.
   *
   *  @returns `false` cuando afectó cero filas, o sea cuando alguien escribió
   *  entretanto: el llamante se salta la fila y cuenta `desincronizado`. */
  async updateStatusIfUnchanged(
    id: string,
    observedStatus: Subscription["status"],
    changes: ReconcilerChanges
  ): Promise<boolean> {
    const written = await this.db
      .update(subscriptions)
      .set(changes)
      .where(and(eq(subscriptions.id, id), eq(subscriptions.status, observedStatus)))
      .returning({ id: subscriptions.id });

    return written.length > 0;
  }
}
