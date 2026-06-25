import Anthropic from "@anthropic-ai/sdk";
import { TUTOR_SYSTEM_PROMPT } from "@/lib/tutor-prompt";
import { auth } from "@/auth";
import { getAccess } from "@/lib/access";
import {
  getOrCreateConversation,
  appendMessages,
} from "@/lib/conversations";

// Servidor Node de larga duración (Railway). La clave vive solo aquí.
const client = new Anthropic();

const TUTOR_MODEL = "claude-sonnet-4-6";

type ClientMessage = { role: "user" | "assistant"; content: string };

export async function POST(req: Request) {
  // Exigimos sesión: la persistencia es por usuario. Sin id no hay a quién
  // guardarle la conversación.
  const session = await auth();
  const userId = session?.user?.id;
  const email = session?.user?.email;
  if (!userId || !email) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Frontera gratis/pago: sin trial vigente ni suscripción activa, no hay tutor.
  const access = await getAccess(email);
  if (!access.allowed) {
    return Response.json({ error: "Subscription required" }, { status: 403 });
  }

  let body: { messages?: ClientMessage[]; lesson?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const messages = body.messages ?? [];
  if (!Array.isArray(messages) || messages.length === 0) {
    return Response.json({ error: "Missing messages" }, { status: 400 });
  }

  // Conversación del usuario (la más reciente o una nueva vacía). La
  // necesitamos para saber a qué fila anexar al cerrar el stream.
  const conversation = await getOrCreateConversation(userId);

  // El último mensaje del cliente es el turno del usuario que dispara esta
  // respuesta; es el que persistiremos junto con la contestación del tutor.
  const lastUserMessage = messages[messages.length - 1];

  // Prompt estable (cacheado) + contexto de sesión como bloque aparte,
  // igual que en el runner de evals: la lección que declara el estudiante.
  const system: Anthropic.TextBlockParam[] = [
    {
      type: "text",
      text: TUTOR_SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" },
    },
  ];
  if (body.lesson) {
    system.push({
      type: "text",
      text: `Contexto de la sesión (inyectado por la plataforma): el estudiante va en la Lección ${body.lesson}.`,
    });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // Acumulamos el texto del tutor en paralelo al streaming para poder
      // persistirlo entero cuando el stream cierre.
      let assistantText = "";
      try {
        const tutorStream = client.messages.stream({
          model: TUTOR_MODEL,
          max_tokens: 1024,
          thinking: { type: "adaptive" },
          system,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
        });

        for await (const event of tutorStream) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            assistantText += event.delta.text;
            controller.enqueue(encoder.encode(event.delta.text));
          }
        }
        controller.close();

        // Stream completado con éxito: persistimos el turno del usuario + la
        // respuesta completa del asistente. Lo hacemos tras cerrar el stream
        // para no añadir latencia al cliente.
        try {
          await appendMessages(conversation.id, [
            { role: "user", content: lastUserMessage.content },
            { role: "assistant", content: assistantText },
          ]);
        } catch (persistErr) {
          // Si falla el guardado no rompemos la experiencia: el usuario ya
          // recibió su respuesta. Solo lo registramos.
          console.error("Error persistiendo la conversación:", persistErr);
        }
      } catch (err) {
        // En v0 cerramos el stream; el cliente muestra un aviso amable.
        console.error("Error llamando al tutor:", err);
        controller.error(err);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
