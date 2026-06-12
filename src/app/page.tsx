// Server Component: carga el historial del usuario en el servidor y lo pasa
// como mensajes iniciales al chat (client component). Así el historial se
// pinta de entrada sin un fetch extra desde el navegador.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { auth } from "@/auth";
import { loadConversation } from "@/lib/conversations";
import ChatClient from "./chat-client";

export default async function ChatPage() {
  const session = await auth();
  const userId = session?.user?.id;

  // Con sesión, traemos el historial guardado; sin sesión arrancamos vacío
  // (el middleware/auth se encarga del redirect a /signin).
  const initialMessages = userId ? await loadConversation(userId) : [];

  return <ChatClient initialMessages={initialMessages} />;
}
