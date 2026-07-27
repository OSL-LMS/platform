// La ventana de conversación que viaja a Anthropic en cada petición.
//
// El cliente manda el hilo entero y hasta ahora se reenviaba tal cual: una
// conversación larga sube el coste de cada turno y acaba chocando con el límite
// de contexto — un fallo duro, justo para el estudiante más constante.
//
// Recortar aquí NO borra nada: `conversations.messages` sigue guardando el hilo
// completo. Lo que se acota es lo que se le enseña al modelo por turno.
//
// Regla de código: identificadores en inglés, comentarios en español.

import type { ConversationMessage } from "./schema";

// ponytail: ventana por número de mensajes, no por tokens — contar tokens
// pediría otra llamada a la API o meter un tokenizador. Con `max_tokens: 1024`
// por respuesta, 30 mensajes son unos pocos miles de tokens. Si el coste por
// conversación se dispara, el cambio es pasar a presupuesto de caracteres aquí
// mismo, sin tocar el resto.
export const MAX_WINDOW_MESSAGES = 30;

/**
 * Los últimos mensajes del hilo, empezando siempre por un turno del usuario:
 * la API de Anthropic exige que el primer mensaje sea `user`, y un corte a
 * ciegas puede caer en mitad de un intercambio y dejarlo en `assistant`.
 *
 * Si en la ventana no queda ningún turno del usuario (no debería pasar: el
 * cliente siempre cierra con uno), devuelve el último mensaje para no mandar
 * una lista vacía.
 */
export function trimWindow(
  messages: ConversationMessage[]
): ConversationMessage[] {
  if (messages.length <= MAX_WINDOW_MESSAGES) return messages;

  const window = messages.slice(-MAX_WINDOW_MESSAGES);
  const firstUser = window.findIndex((m) => m.role === "user");

  if (firstUser === -1) return messages.slice(-1);
  return window.slice(firstUser);
}
