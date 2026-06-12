// Helpers de persistencia de conversaciones (Drizzle ORM).
//
// La memoria del tutor vive en la tabla `conversations`: una fila por
// conversación, con el array `messages` (jsonb) de {role, content}. En v0
// mantenemos UNA conversación por usuario (la más reciente).
//
// Regla de código: identificadores en inglés, comentarios en español.

import { eq, desc, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  conversations,
  type Conversation,
  type ConversationMessage,
} from "@/lib/schema";

// Devuelve la conversación más reciente del usuario; si no tiene ninguna,
// crea una vacía y la devuelve. Siempre regresa una fila válida.
export async function getOrCreateConversation(
  userId: string
): Promise<Conversation> {
  // Buscamos la conversación más reciente del usuario.
  const [existing] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.userId, userId))
    .orderBy(desc(conversations.updatedAt))
    .limit(1);

  if (existing) {
    return existing;
  }

  // No hay conversación previa: creamos una vacía. `messages` cae al default [].
  const [created] = await db
    .insert(conversations)
    .values({ userId })
    .returning();

  return created;
}

// Agrega mensajes al final del array `messages` (jsonb) y refresca
// `updated_at`. Usa concatenación en SQL para no pisar lo ya guardado en
// caso de escrituras concurrentes desde el mismo usuario.
export async function appendMessages(
  conversationId: string,
  newMessages: ConversationMessage[]
): Promise<void> {
  // Sin mensajes nuevos no hay nada que persistir.
  if (newMessages.length === 0) return;

  await db
    .update(conversations)
    .set({
      // `messages || $payload`: concatena el jsonb existente con los nuevos.
      messages: sql`${conversations.messages} || ${JSON.stringify(
        newMessages
      )}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(conversations.id, conversationId));
}

// Devuelve los mensajes existentes del usuario (para pintar el historial al
// cargar). Si el usuario no tiene conversación, devuelve un array vacío.
export async function loadConversation(
  userId: string
): Promise<ConversationMessage[]> {
  const [existing] = await db
    .select({ messages: conversations.messages })
    .from(conversations)
    .where(eq(conversations.userId, userId))
    .orderBy(desc(conversations.updatedAt))
    .limit(1);

  return existing?.messages ?? [];
}
