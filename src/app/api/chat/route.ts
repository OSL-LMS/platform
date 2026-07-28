import Anthropic from "@anthropic-ai/sdk";
import { TUTOR_SYSTEM_PROMPT } from "@/lib/tutor-prompt";
import { buildLessonContext } from "@/lib/curriculum-context";
import { curriculumSlug, getLessonContextInputs } from "@/lib/curriculum";
import { auth } from "@/auth";
import {
  decideTutorTurn,
  fetchAccessTrial,
  readSessionToken,
  resolveClientConfig,
  type ApiResult,
} from "@/lib/api-client";
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
  // sin tarjeta). Sin trial vigente ni suscripción activa, no hay tutor. Con el
  // puente caído (timeout o 5xx), el tutor se deniega con 503 en vez de
  // conceder acceso sin poder verificarlo (§5.3, excepción declarada al goal 6).
  // Cronometrado para PRD-003 §10 paso 3, que nombra "la duración de la llamada
  // a /v1/access/trial" como la señal contra la que se compara el umbral de
  // +200 ms p95 de ADR-001 §6 — la que decide si el puente se queda donde está.
  // Se mide el helper entero y no solo el fetch: incluye leer la cookie de
  // sesión y resolver la configuración, que es lo que de verdad espera el
  // estudiante. Las dos son de microsegundos, así que no mueven la aguja.
  const accessStartedAt = performance.now();
  const result = await resolveTrialAccess();
  const accessMs = Math.round(performance.now() - accessStartedAt);

  const decision = decideTutorTurn(result);
  if (!decision.ok) {
    const message =
      decision.status === 503 ? "Access service unavailable" : "Subscription required";
    return Response.json({ error: message }, { status: decision.status });
  }
  const access = decision.access;

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
  // OJO AL LEER `access_ms` EN POSTHOG: solo llega aquí el turno CONCEDIDO. Un
  // puente caído devuelve 503 arriba y no emite el evento —deliberado, §5.3: un
  // turno denegado corromperia el embudo—, así que esta serie describe la salud
  // del camino bueno y NO detecta un puente que agota el timeout. Para eso está
  // la tasa de 503, que es otra señal. Un p95 limpio aquí con el tutor caído es
  // un resultado coherente, no una contradicción.
  track(email, "tutor_message_sent", {
    access_status: access.status,
    access_ms: accessMs,
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

// PRD-003 §5.3: delega en el puente (POST /v1/access/trial) y devuelve el
// ApiResult crudo — decideTutorTurn() es quien traduce eso a 503/403/OK.
//
// La identidad sale del token de sesión, no de un argumento: por eso esta
// función no recibe el email.
async function resolveTrialAccess(): Promise<ApiResult> {
  const config = resolveClientConfig();
  const token = await readSessionToken();
  return fetchAccessTrial(token, config.apiBaseUrl, config.accessTimeoutMs);
}
