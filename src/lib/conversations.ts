// Lectura de la conversación para pintar el historial en `/chat`.
//
// La memoria del tutor vive en la tabla `conversations`: una fila por
// conversación, con el array `messages` (jsonb) de {role, content}. En v0
// mantenemos UNA conversación por usuario (la más reciente).
//
// DESDE EL PASO E DE PRD-005 §10 AQUÍ SÓLO SE LEE. La escritura —crear la
// conversación y anexar el turno— vive en
// `apps/api/src/tutor/conversations.repository.ts`, porque el turno entero se
// sirve desde allí. Next conserva esta lectura, y sólo ésta, para que el render
// de `/chat` no dependa de que apps/api responda: es lo que evita dejar al
// estudiante sin historial cuando el puente degrada (PRD-003 §5.3).
//
// Si alguien necesita volver a escribir desde aquí, la pregunta previa es por
// qué el turno no está pasando por apps/api.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { eq, desc } from "drizzle-orm";
import { db } from "@/lib/db";
import { conversations, type ConversationMessage } from "@/lib/schema";

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
