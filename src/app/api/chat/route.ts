import Anthropic from "@anthropic-ai/sdk";
import { TUTOR_SYSTEM_PROMPT } from "@/lib/tutor-prompt";

// Servidor Node de larga duración (Railway). La clave vive solo aquí.
const client = new Anthropic();

const TUTOR_MODEL = "claude-sonnet-4-6";

type ClientMessage = { role: "user" | "assistant"; content: string };

export async function POST(req: Request) {
  let body: { messages?: ClientMessage[]; lesson?: string };
  try {
    body = await req.json();
  } catch {
    return new Response("Cuerpo JSON inválido", { status: 400 });
  }

  const messages = body.messages ?? [];
  if (!Array.isArray(messages) || messages.length === 0) {
    return new Response("Faltan mensajes", { status: 400 });
  }

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
            controller.enqueue(encoder.encode(event.delta.text));
          }
        }
        controller.close();
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
