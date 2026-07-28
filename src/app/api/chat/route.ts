import Anthropic from "@anthropic-ai/sdk";
import { TUTOR_SYSTEM_PROMPT } from "@/lib/tutor-prompt";
import { buildLessonContext } from "@/lib/curriculum-context";
import { curriculumSlug, getLessonContextInputs } from "@/lib/curriculum";
import { auth } from "@/auth";
import { ensureTrial } from "@/lib/access";
import { track } from "@/lib/analytics";
import { trimWindow } from "@/lib/window";
import {
  getOrCreateConversation,
  appendMessages,
} from "@/lib/conversations";

// Servidor Node de larga duración (Railway). La clave vive solo aquí.
const client = new Anthropic();

const TUTOR_MODEL = "claude-sonnet-4-6";

// `body.lesson` sigue siendo entrada no confiable y sigue sin interpolarse
// nunca en el prompt. Lo que cambia con PRD-002 es el COSTE de usarlo como
// clave: antes era un `Array.find` sobre 7 elementos en memoria; ahora puede
// ser un viaje a Postgres. Lo que no encaje se descarta ANTES de tocar la base.
const LESSON_SLUG_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

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

  // Frontera gratis/pago: el primer mensaje al tutor arranca el trial (7 días,
  // sin tarjeta). Sin trial vigente ni suscripción activa, no hay tutor.
  const access = await ensureTrial(email);
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

  const lesson =
    typeof body.lesson === "string" && LESSON_SLUG_PATTERN.test(body.lesson)
      ? body.lesson
      : undefined;

  // Paso intermedio del embudo. Se emite al ACEPTAR el mensaje, no al cerrar el
  // stream: lo que medimos aquí es que el estudiante habló con el tutor, y eso
  // ya pasó aunque Anthropic falle a mitad de la respuesta.
  track(email, "tutor_message_sent", {
    access_status: access.status,
    lesson: lesson ?? null,
  });

  // Conversación del usuario (la más reciente o una nueva vacía). La
  // necesitamos para saber a qué fila anexar al cerrar el stream.
  const conversation = await getOrCreateConversation(userId);

  // El último mensaje del cliente es el turno del usuario que dispara esta
  // respuesta; es el que persistiremos junto con la contestación del tutor.
  const lastUserMessage = messages[messages.length - 1];

  // Prompt estable (cacheado) + temario como bloque aparte, igual que en el
  // runner de evals. El prompt no sabe nada del curso: el módulo, las lecciones
  // y los atascos típicos son dato y viajan aquí, así que una clase nueva es un
  // nodo en `curriculum/<slug>.json` y no una versión del tutor.
  //
  // El índice de lecciones se acota AL MÓDULO de la lección declarada. Con el
  // currículo entero, la línea "Lecciones del módulo:" pasaría a listar todo el
  // temario mal etiquetado en cuanto un segundo módulo reciba su primera clase.
  const { moduleLessons, ancestors } = await getLessonContextInputs(
    curriculumSlug(),
    lesson
  );
  const system: Anthropic.TextBlockParam[] = [
    {
      type: "text",
      text: TUTOR_SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" },
    },
    {
      type: "text",
      text: buildLessonContext(moduleLessons, ancestors, lesson),
    },
  ];

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
          // Solo la ventana reciente viaja al modelo; el hilo completo se sigue
          // guardando en `conversations`.
          messages: trimWindow(messages).map((m) => ({
            role: m.role,
            content: m.content,
          })),
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
