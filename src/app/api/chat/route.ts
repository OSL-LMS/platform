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
  streamTutorTurn,
  type ApiResult,
} from "@/lib/api-client";
import { track } from "@/lib/analytics";
import { trimWindow } from "@/lib/window";
import {
  getOrCreateConversation,
  appendMessages,
} from "@/lib/conversations";
import { readIncomingTurn, sanitizeStoredThread } from "@/lib/tutor-turn";

// Servidor Node de larga duración (Railway). La clave vive solo aquí.
const client = new Anthropic();

const TUTOR_MODEL = "claude-sonnet-4-6";

// PRD-005 §10 paso D: el flip es UN CAMBIO DE ENTORNO, sin despliegue, y el
// rollback es quitar la variable. Se exige el valor exacto "1" —el que §10
// nombra— para que no haya un segundo criterio invisible; ver .env.example.
//
// Se lee en el ámbito del módulo a propósito: el flip reinicia el servicio de
// todos modos, y así una petición no puede cambiar de camino a mitad de vuelo.
const TUTOR_VIA_API = process.env.TUTOR_VIA_API === "1";

export async function POST(req: Request) {
  // t=0 DEL TURNO (§5.4). Va aquí, en la entrada del handler, porque es el
  // mismo punto que apps/api usa en el camino nuevo: sin fijarlo, la línea base
  // del paso A y la medida post-corte no son la misma magnitud y el corte
  // parecería una mejora que no existe.
  const handlerStartedAt = performance.now();

  // Exigimos sesión: la persistencia es por usuario. Sin id no hay a quién
  // guardarle la conversación.
  const session = await auth();
  const userId = session?.user?.id;
  const email = session?.user?.email;
  if (!userId || !email) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (TUTOR_VIA_API) return proxyTurn(req);

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
  const accessElapsed = performance.now() - accessStartedAt;
  const accessMs = Math.round(accessElapsed);

  const decision = decideTutorTurn(result);
  if (!decision.ok) {
    const message =
      decision.status === 503 ? "Access service unavailable" : "Subscription required";
    return Response.json({ error: message }, { status: decision.status });
  }
  const access = decision.access;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // PRD-005 §10 paso B: se aceptan LAS DOS FORMAS del cuerpo mientras dura la
  // transición. Un estudiante con /chat ya abierto conserva el bundle viejo,
  // que manda el hilo entero. La rama de compatibilidad se retira en el paso E.
  const turn = readIncomingTurn(body);
  if (!turn.ok) {
    return Response.json({ error: turn.error }, { status: 400 });
  }
  const { message, lesson } = turn;

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
  // necesitamos para saber a qué fila anexar al cerrar el stream — y, desde
  // PRD-005 §5.2, para saber QUÉ SE LE ENSEÑA AL MODELO.
  const conversation = await getOrCreateConversation(userId);

  // EL HILO SALE DE LA BASE, NO DEL CLIENTE (§5.2, goal 2). Hasta aquí el
  // servidor reenviaba a Anthropic el array que mandaba el navegador, así que
  // un cliente podía FABRICAR lo que el tutor supuestamente dijo antes y
  // metérselo al modelo como memoria propia. La regla pedagógica inviolable del
  // prompt resiste instrucciones DENTRO de la conversación; un `assistant`
  // falso no es una instrucción, es memoria inventada.
  //
  // `conversations.messages` es jsonb sin restricción, así que se valida al
  // leer y se recorta el prefijo hasta el primer `user` (ver sanitizeStoredThread:
  // trimWindow no da esa garantía por debajo de 30 mensajes). El descarte se
  // registra como CONTADOR, sin contenido (§8.3).
  const stored = sanitizeStoredThread(conversation.messages);
  if (stored.discarded > 0) {
    console.warn(`[tutor] thread_entries_discarded=${stored.discarded}`);
  }
  const windowed = trimWindow([...stored.messages, { role: "user", content: message }]);

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
      let firstTokenLogged = false;
      try {
        const tutorStream = client.messages.stream({
          model: TUTOR_MODEL,
          max_tokens: 1024,
          thinking: { type: "adaptive" },
          system,
          // Solo la ventana reciente viaja al modelo; el hilo completo se sigue
          // guardando en `conversations`.
          messages: windowed.map((m) => ({
            role: m.role,
            content: m.content,
          })),
        });

        for await (const event of tutorStream) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            // LÍNEA BASE DE §10 PASO A. Es la misma señal que llevará apps/api
            // (§5.4) y la que dispara la fila 1 de ADR-001 §6, con el mismo t=0
            // en las dos mitades: la entrada del handler, EXCLUYENDO el tramo
            // del puente de acceso, que en el camino nuevo no existe. Sin
            // restarlo, la línea base saldría inflada y el corte parecería una
            // mejora. Es un entero y no lleva PII.
            if (!firstTokenLogged) {
              firstTokenLogged = true;
              const firstTokenMs = Math.round(
                performance.now() - handlerStartedAt - accessElapsed
              );
              console.log(`[tutor] first_token_ms=${firstTokenMs}`);
            }
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
            { role: "user", content: message },
            { role: "assistant", content: assistantText },
          ]);
        } catch (persistErr) {
          // Si falla el guardado no rompemos la experiencia: el usuario ya
          // recibió su respuesta. Pero desde §5.2 el fallo YA NO ES INOCUO: el
          // hilo que viaja al modelo sale de esta fila, así que un append
          // perdido es AMNESIA —la UI sigue mostrando el intercambio y el turno
          // siguiente ya no lo ve— y el estudiante no recibe ninguna señal. Se
          // conserva el best-effort (tumbar una respuesta ya entregada es peor)
          // y se sube el registro a allowlist por campo: `name` y `code`,
          // nunca `message` ni el objeto (§8.3).
          const e = persistErr as { name?: string; code?: string };
          console.error(
            `[tutor] persist_failed name=${e?.name ?? "unknown"} code=${e?.code ?? "none"}`
          );
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

// PRD-005 §5.3 — el camino nuevo. Lo enciende el paso D con TUTOR_VIA_API=1.
//
// Aquí NO se llama al puente de acceso: `ensureTrial` pasa a ser una llamada en
// proceso dentro de apps/api, y `tutor_message_sent` se emite allí (§9 fila 18).
// Este handler no toca Postgres ni Anthropic: sólo cookie, Bearer y bytes.
//
// La cookie de sesión NO SALE DE ESTE PROCESO: se lee del tarro y lo que viaja
// es el Bearer. La cabecera Cookie no se reenvía (§5.3) — tendría precedencia
// sobre el Bearer dentro de getToken() y abriría un segundo canal de credencial
// no declarado. Es la invariante que el camino directo habría retirado.
async function proxyTurn(req: Request): Promise<Response> {
  const config = resolveClientConfig();
  const token = await readSessionToken();
  if (typeof token !== "string") {
    // Cookie ausente, troceada o con nombre distinto al configurado: 401 ANTES
    // de salir del proceso. Desde PRD-005 §5.3 la rama troceada degrada aquí en
    // vez de lanzar, que dentro de un handler era un 500 provocable por un
    // tercero (§9 fila 38b).
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // El cuerpo se lee como texto y se reenvía tal cual: la validación de forma
  // es de `turn.dto.ts` (§5.1) y su 400 es exactamente lo que el cliente tiene
  // que ver. Bufferizar el cuerpo ENTRANTE (≤ 64 kb) no es lo que §5.3 prohíbe:
  // lo que no puede bufferizarse es la RESPUESTA.
  const body = await req.text();

  const upstream = await streamTutorTurn(token, body, {
    baseUrl: config.apiBaseUrl,
    timeoutMs: config.tutorTimeoutMs,
    clientSignal: req.signal,
  });

  if ("error" in upstream) {
    // apps/api no respondió antes de la primera cabecera, agotó
    // TUTOR_TIMEOUT_MS o devolvió un 3xx. NADA SE PERSISTIÓ: el stream no llegó
    // a abrirse. Un fallo POSTERIOR a las cabeceras no llega aquí y no tiene
    // status — el cuerpo ya empezó a viajar y la conexión se corta.
    return Response.json({ error: "Tutor service unavailable" }, { status: 503 });
  }

  return upstream;
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
