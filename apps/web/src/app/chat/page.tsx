// Server Component del tutor (ruta protegida /chat): aplica la frontera
// gratis/pago y carga el historial. El middleware solo protege /chat; el resto
// del sitio es público (landing, precios, legales) para que Paddle lo verifique.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { auth } from "@/auth";
import { loadConversation } from "@/lib/conversations";
import type { Access } from "@shared/access";
import { fetchAccess, readSessionToken, resolveClientConfig } from "@/lib/api-client";
import { curriculumSlug, getLessons, toEvidenceLessons } from "@shared/curriculum";
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

  // Frontera gratis/pago: solo LEE el acceso — entrar a mirar no gasta la
  // prueba; el trial arranca con el primer mensaje al tutor (/api/chat).
  const access = await resolveAccess();
  if (!access.allowed) {
    return (
      <Paywall
        status={access.status === "canceled" ? "canceled" : "trial"}
        email={email}
      />
    );
  }

  // Estas dos lecturas son de la Postgres de Next y no dependen de apps/api:
  // corren SIEMPRE que haya acceso, incluido el camino degradado de abajo. No
  // saltarlas es lo que evita dejar al estudiante sin historial ni selector
  // de lección cuando apps/api no responde (PRD-003 §5.3).
  const initialMessages = await loadConversation(userId);
  // `toEvidenceLessons` y no `toLessonOptions` (PRD-007 §6.6): cada opción
  // arrastra además `evidenceKind` y `evidencePrompt`, que es lo que decide si
  // hay panel de entrega y qué se le pide al estudiante. EL CAMBIO ES SÓLO DE
  // ESTA PÁGINA: `/registro` es pública y sin login, sigue con `toLessonOptions`
  // y su golden (`check-curriculum-golden.ts`) sigue afirmando que al cliente
  // anónimo solo viajan `{slug, title}`.
  const lessons = toEvidenceLessons(await getLessons(curriculumSlug()));
  return (
    <ChatClient
      initialMessages={initialMessages}
      trialDaysLeft={access.trialDaysLeft}
      lessons={lessons}
    />
  );
}

// PRD-003 §5.3: un `{error:true}` del puente (timeout, 5xx, desajuste de
// salt…) se trata como acceso permitido sin trial confirmado: el estudiante
// sigue viendo ChatClient —nunca Paywall, nunca redirect a /signin, un 401 de
// apps/api no es "sin sesión"— pero sin inventar días de prueba que apps/api
// no pudo confirmar.
//
// La identidad sale del token de sesión, no de un argumento: por eso esta
// función no recibe el email.
async function resolveAccess(): Promise<Access> {
  const config = resolveClientConfig();
  const token = await readSessionToken();
  const result = await fetchAccess(token, config.apiBaseUrl, config.accessTimeoutMs);
  return "error" in result
    ? { allowed: true, status: "none", trialDaysLeft: null }
    : result;
}
