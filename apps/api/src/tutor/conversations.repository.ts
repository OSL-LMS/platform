// La memoria del tutor: una fila de `conversations` por usuario (la más
// reciente), con el hilo completo en `messages` (jsonb).
//
// Portado desde `src/lib/conversations.ts` en PRD-005 fase 2. Las sentencias son
// EXACTAMENTE las mismas —incluida la concatenación en SQL de `append()`— porque
// las dos rutas conviven durante los pasos C y D de §10 y tienen que escribir lo
// mismo.
//
// LO QUE SÍ ES NUEVO, Y ES EL GOAL 2: `getOrCreate()` **valida el hilo al
// leerlo**. Hasta esta fase daba igual que la columna guardara basura, porque lo
// que viajaba al modelo salía del array que mandaba el CLIENTE; desde ahora la
// base es la única fuente, así que la propiedad de seguridad del goal 2 solo es
// tan fuerte como esta lectura. Ver `sanitizeThread()`.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { Inject, Injectable, Logger } from "@nestjs/common";
import { desc, eq, sql } from "drizzle-orm";

import { DRIZZLE, type Database } from "../db/drizzle.module.ts";
import { conversations, type ConversationMessage } from "../db/schema.ts";

/** La conversación del turno: a qué fila anexar al cerrar, y el hilo YA
 *  saneado que alimenta la ventana. */
export type LoadedConversation = {
  id: string;
  messages: ConversationMessage[];
};

/** Resultado del saneado, con el contador que se registra (§8.3: un entero, sin
 *  contenido). */
export type SanitizedThread = {
  messages: ConversationMessage[];
  discarded: number;
};

function isUsableMessage(entry: unknown): entry is ConversationMessage {
  if (typeof entry !== "object" || entry === null) return false;
  const { role, content } = entry as { role?: unknown; content?: unknown };
  return (role === "user" || role === "assistant") && typeof content === "string";
}

/**
 * El hilo guardado, listo para viajar al modelo. Puro: la fila 4 de §9 lo
 * ejercita a través del endpoint, pero el criterio vive aquí y se lee de un
 * vistazo.
 *
 * DOS RECORTES, Y NINGUNO ES OPCIONAL (PRD-005 §5.2):
 *
 *  1. **Validación por entrada.** `conversations.messages` es `jsonb` sin
 *     restricción y `trimWindow` solo mira `m.role === "user"`
 *     (`window.ts:36`), así que nada impedía que una fila con `role: "system"`
 *     —o con un `content` que no fuera string— llegara al modelo. Hasta esta
 *     fase daba igual porque la fila no lo alimentaba; ahora sí.
 *  2. **Recorte del prefijo hasta el primer `user`.** La API de Anthropic exige
 *     que el primer mensaje sea `user`, y `trimWindow()` **no lo garantiza por
 *     debajo de 30**: `window.ts:33` devuelve el array tal cual y la búsqueda
 *     del primer `user` solo corre en la rama de recorte (`:36-39`). Si el
 *     descarte del punto 1 se lleva la primera entrada y la siguiente es
 *     `assistant`, lo que viaja empieza por `assistant`, Anthropic responde 400
 *     y el tutor da 500. Por eso se recorta AQUÍ, antes de `trimWindow`.
 *
 * Sin `user` en el hilo devuelve `[]`, que es correcto: el llamante añade el
 * turno del estudiante detrás y esa lista sí empieza por `user`.
 */
export function sanitizeThread(stored: readonly unknown[]): SanitizedThread {
  const usable = stored.filter(isUsableMessage);
  const firstUser = usable.findIndex((m) => m.role === "user");
  const messages = firstUser === -1 ? [] : usable.slice(firstUser);

  // El descarte cuenta las dos pérdidas —entradas inválidas y prefijo recortado—
  // porque las dos son "esto estaba guardado y no viaja". Es un entero: ni el
  // rol, ni el contenido, ni el índice (§8.3).
  return { messages, discarded: stored.length - messages.length };
}

@Injectable()
export class ConversationsRepository {
  private readonly logger = new Logger(ConversationsRepository.name);

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** La conversación más reciente del usuario, o una nueva vacía. Siempre
   *  devuelve una fila, y su hilo ya saneado. */
  async getOrCreate(userId: string): Promise<LoadedConversation> {
    const [existing] = await this.db
      .select({ id: conversations.id, messages: conversations.messages })
      .from(conversations)
      .where(eq(conversations.userId, userId))
      .orderBy(desc(conversations.updatedAt))
      .limit(1);

    if (existing) {
      const { messages, discarded } = sanitizeThread(existing.messages ?? []);
      if (discarded > 0) {
        // Solo el contador. Registrar QUÉ se descartó sería registrar el turno
        // de un estudiante, que §8.3 prohíbe en cualquier nivel.
        this.logger.warn(`hilo saneado al leer: descartadas=${discarded}`);
      }
      return { id: existing.id, messages };
    }

    // Sin conversación previa: una vacía. `messages` cae al default `[]`.
    const [created] = await this.db
      .insert(conversations)
      .values({ userId })
      .returning({ id: conversations.id });

    return { id: created.id, messages: [] };
  }

  /** Anexa al final del hilo y refresca `updated_at`.
   *
   *  Concatenación EN SQL (`messages || $payload::jsonb`) y no lectura-modifica-
   *  escritura: dos pestañas del mismo estudiante escriben sin pisarse. Es lo
   *  que ya hacía `src/lib/conversations.ts:57` y §5.2 lo acepta tal cual — el
   *  entrelazado de dos turnos simultáneos sigue siendo el de hoy. */
  async append(conversationId: string, newMessages: ConversationMessage[]): Promise<void> {
    if (newMessages.length === 0) return;

    await this.db
      .update(conversations)
      .set({
        messages: sql`${conversations.messages} || ${JSON.stringify(newMessages)}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, conversationId));
  }
}
