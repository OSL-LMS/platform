// Server Component del tutor (ruta protegida /chat): aplica la frontera
// gratis/pago y carga el historial. El middleware solo protege /chat; el resto
// del sitio es público (landing, precios, legales) para que Paddle lo verifique.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { auth } from "@/auth";
import { loadConversation } from "@/lib/conversations";
import { getAccess } from "@/lib/access";
import ChatClient from "../chat-client";
import Paywall from "../paywall";

export default async function ChatPage() {
  const session = await auth();
  const userId = session?.user?.id;
  const email = session?.user?.email;

  // Defensa: el middleware ya redirige a /signin si no hay sesión.
  if (!userId || !email) {
    return <ChatClient initialMessages={[]} />;
  }

  // Frontera gratis/pago: arranca el trial en el primer acceso y evalúa acceso.
  const access = await getAccess(email);
  if (!access.allowed) {
    return (
      <Paywall
        status={access.status === "canceled" ? "canceled" : "trial"}
        email={email}
      />
    );
  }

  const initialMessages = await loadConversation(userId);
  return (
    <ChatClient
      initialMessages={initialMessages}
      trialDaysLeft={access.trialDaysLeft}
    />
  );
}
