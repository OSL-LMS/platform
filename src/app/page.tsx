// Server Component: aplica la frontera gratis/pago y carga el historial.
//
// 1) Si no hay acceso (trial vencido / cancelado) → muestra el Paywall.
// 2) Con acceso → carga el historial del usuario y lo pasa al chat, junto con
//    los días de trial restantes para el banner.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { auth } from "@/auth";
import { loadConversation } from "@/lib/conversations";
import { getAccess } from "@/lib/access";
import ChatClient from "./chat-client";
import Paywall from "./paywall";

export default async function ChatPage() {
  const session = await auth();
  const userId = session?.user?.id;
  const email = session?.user?.email;

  // Sin sesión, el middleware ya redirige a /signin; esto es solo defensa.
  if (!userId || !email) {
    return <ChatClient initialMessages={[]} />;
  }

  // Frontera gratis/pago: arranca el trial en el primer acceso y evalúa acceso.
  const access = await getAccess(email);
  if (!access.allowed) {
    return <Paywall status={access.status === "canceled" ? "canceled" : "trial"} />;
  }

  const initialMessages = await loadConversation(userId);
  return (
    <ChatClient
      initialMessages={initialMessages}
      trialDaysLeft={access.trialDaysLeft}
    />
  );
}
