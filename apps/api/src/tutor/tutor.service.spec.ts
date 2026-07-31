// Lo que el tutor le manda al modelo.
//
// Cubre las filas 22, 23 y 24 de PRD-005 §9.
//
// Todo lo de aquí es el goal 3 —"conservar sin cambio observable"— visto desde
// el único sitio donde se puede afirmar: los argumentos exactos de
// `messages.stream()`. Es el valor de haber inyectado el SDK como provider
// (§7): con un `new Anthropic()` en el ámbito del módulo, como hace
// `route.ts:21`, ninguna de estas tres filas existiría.
//
// Regla de código: identificadores en inglés, comentarios en español.

import type Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AccessService } from "../access/access.service.ts";
import type { AnalyticsService } from "../analytics/analytics.service.ts";
import { buildLessonContext, type CurriculumNode } from "../curriculum/curriculum-context.ts";
import type { CurriculumRepository, LessonContextInputs } from "../curriculum/curriculum.repository.ts";
import type { ConversationMessage } from "../db/schema.ts";
import type { SessionUser } from "../session/session.guard.ts";
import type { TutorStream, TutorStreamer } from "./anthropic.client.ts";
import type { ConversationsRepository, LoadedConversation } from "./conversations.repository.ts";
import { TUTOR_SYSTEM_PROMPT } from "./tutor-prompt.ts";
import { TUTOR_MAX_TOKENS, TUTOR_MODEL, TutorService, type TurnWriter } from "./tutor.service.ts";
import { MAX_WINDOW_MESSAGES } from "./window.ts";

const STUDENT: SessionUser = { userId: "user-1", email: "Estudiante@Ejemplo.test" };

type StreamParams = Anthropic.MessageStreamParams;

/** Lo que el doble emite. Los `thinking_delta` van mezclados a propósito: la
 *  fila 24 afirma que NO se reenvían. */
let scriptedEvents: Anthropic.MessageStreamEvent[] = [];
let seenParams: StreamParams[] = [];

function textDelta(text: string): Anthropic.MessageStreamEvent {
  return {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text },
  } as Anthropic.MessageStreamEvent;
}

function thinkingDelta(thinking: string): Anthropic.MessageStreamEvent {
  return {
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking },
  } as Anthropic.MessageStreamEvent;
}

const anthropic: TutorStreamer = {
  messages: {
    stream(params: StreamParams): TutorStream {
      seenParams.push(params);
      return {
        abort: vi.fn(),
        async *[Symbol.asyncIterator]() {
          for (const event of scriptedEvents) yield event;
        },
      };
    },
  },
};

function conversationsDouble(messages: ConversationMessage[]) {
  const loaded: LoadedConversation = { id: "conv-1", messages };
  return {
    getOrCreate: vi.fn(async () => loaded),
    append: vi.fn(async () => undefined),
  } as unknown as ConversationsRepository & {
    getOrCreate: ReturnType<typeof vi.fn>;
    append: ReturnType<typeof vi.fn>;
  };
}

function curriculumDouble(inputs: LessonContextInputs) {
  return {
    lessonContext: vi.fn(async () => inputs),
  } as unknown as CurriculumRepository;
}

const access = {
  ensureTrial: vi.fn(async () => ({ allowed: true, status: "trial", trialDaysLeft: 7 })),
} as unknown as AccessService;

const analytics = { track: vi.fn() } as unknown as AnalyticsService;

function writerDouble(): TurnWriter & { chunks: string[]; ended: () => boolean } {
  const chunks: string[] = [];
  let closed = false;
  return {
    chunks,
    ended: () => closed,
    write: (text) => void chunks.push(text),
    end: () => void (closed = true),
  };
}

/** El bosque mínimo con módulo y lección, tal como lo devolvería
 *  `lessonContextInputs()` sobre filas reales. */
function lessonInputs(): LessonContextInputs {
  const lesson = (slug: string, title: string): CurriculumNode => ({
    id: `id-${slug}`,
    slug,
    kind: "lesson",
    title,
    payload: { outcome: `sabrás ${slug}`, stuck: `lo típico de ${slug}` },
    children: [],
  });
  const moduleNode: CurriculumNode = {
    id: "id-M1",
    slug: "M1",
    kind: "module",
    title: "Fundamentos",
    payload: { audience: "principiantes absolutos" },
    children: [],
  };
  return {
    moduleLessons: [lesson("L1", "Tu primera página"), lesson("L2", "Git")],
    ancestors: [moduleNode],
  };
}

function run(
  conversations: ConversationsRepository,
  curriculum: CurriculumRepository,
  turn: { message: string; lesson?: string },
  writer: TurnWriter
) {
  const service = new TutorService(anthropic, conversations, curriculum, access, analytics);
  return service.runTurn(STUDENT, turn, writer, {
    startedAt: performance.now(),
    signal: new AbortController().signal,
  });
}

beforeEach(() => {
  seenParams = [];
  scriptedEvents = [textDelta("Hola")];
  vi.clearAllMocks();
});

describe("lo que viaja al modelo", () => {
  // -------------------------------------------------------------------------
  // Fila 22 — la ventana de 30
  // -------------------------------------------------------------------------
  /** 40 mensajes alternando roles. `firstRole` fija la paridad, que es lo que
   *  decide dónde cae el corte de los últimos 30. */
  function alternating(firstRole: "user" | "assistant"): ConversationMessage[] {
    return Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? firstRole : firstRole === "user" ? "assistant" : "user",
      content: `guardado ${i}`,
    }));
  }

  it("fila 22: con 40 mensajes guardados viajan 30 y el primero es `user`", async () => {
    // Con el turno nuevo son 41 candidatos y `trimWindow` se queda con los
    // últimos 30. Esta paridad hace que el corte caiga JUSTO en un `user`, así
    // que la ventana mide 30 exactos.
    const writer = writerDouble();
    await run(
      conversationsDouble(alternating("assistant")),
      curriculumDouble(lessonInputs()),
      { message: "nuevo" },
      writer
    );

    const sent = seenParams[0].messages;
    expect(sent).toHaveLength(MAX_WINDOW_MESSAGES);
    expect(sent[0].role).toBe("user");
    // Y el último es siempre el turno del estudiante de ESTA petición.
    expect(sent.at(-1)).toEqual({ role: "user", content: "nuevo" });
  });

  it("fila 22: si el corte cae en `assistant`, se recorta hasta el primer `user`", async () => {
    // La otra paridad, y la que de verdad ejercita el recorte: los últimos 30
    // empiezan por `assistant`, así que `trimWindow` descarta esa entrada y
    // manda 29. Menos contexto es correcto; una ventana que empiece por
    // `assistant` es un 400 de la API de Anthropic, o sea un 500 del tutor.
    await run(
      conversationsDouble(alternating("user")),
      curriculumDouble(lessonInputs()),
      { message: "nuevo" },
      writerDouble()
    );

    const sent = seenParams[0].messages;
    expect(sent.length).toBeLessThanOrEqual(MAX_WINDOW_MESSAGES);
    expect(sent).toHaveLength(MAX_WINDOW_MESSAGES - 1);
    expect(sent[0].role).toBe("user");
    expect(sent.at(-1)).toEqual({ role: "user", content: "nuevo" });
  });

  it("fila 22: un hilo corto viaja entero y el turno nuevo va al final", async () => {
    // El contraste importa: `trimWindow` por debajo de 30 devuelve el array TAL
    // CUAL (`window.ts:33`), así que esta rama es la que demuestra que el hilo
    // sale de la base y no del cuerpo.
    const stored: ConversationMessage[] = [
      { role: "user", content: "¿qué es un repositorio?" },
      { role: "assistant", content: "buena pregunta" },
    ];

    await run(
      conversationsDouble(stored),
      curriculumDouble(lessonInputs()),
      { message: "sigo sin verlo" },
      writerDouble()
    );

    expect(seenParams[0].messages).toEqual([
      { role: "user", content: "¿qué es un repositorio?" },
      { role: "assistant", content: "buena pregunta" },
      { role: "user", content: "sigo sin verlo" },
    ]);
  });

  // -------------------------------------------------------------------------
  // Fila 23 — los dos bloques de system
  // -------------------------------------------------------------------------
  it("fila 23: dos bloques, `cache_control` solo en el prompt, y el contexto es el de buildLessonContext", async () => {
    const inputs = lessonInputs();

    await run(conversationsDouble([]), curriculumDouble(inputs), { message: "hola", lesson: "L1" }, writerDouble());

    const system = seenParams[0].system as Anthropic.TextBlockParam[];
    expect(system).toHaveLength(2);

    expect(system[0].text).toBe(TUTOR_SYSTEM_PROMPT);
    expect(system[0].cache_control).toEqual({ type: "ephemeral" });

    // El segundo NO lo lleva, y no es un olvido: crece con el temario y cambia
    // con la lección declarada, así que se factura como entrada no cacheada en
    // cada petición. De ahí la cota de 4 000 caracteres por valor.
    expect(system[1].cache_control).toBeUndefined();

    // IDÉNTICO al de la función real con los mismos argumentos. Es lo que
    // sostiene que la costura sirva de algo: si apps/api compusiera su propio
    // texto, el bloque que revisa `pnpm curriculum:check` y el que recibe el
    // tutor podrían derivar sin que nada fallara.
    expect(system[1].text).toBe(buildLessonContext(inputs.moduleLessons, inputs.ancestors, "L1"));
    expect(system[1].text).toContain('Módulo en curso: "Fundamentos"');
  });

  it("fila 23: sin lección declarada el segundo bloque sigue existiendo", async () => {
    // El par vacío no es un error: es la rama "el estudiante no ha declarado
    // lección", y el bloque se lo dice al modelo en vez de omitirse.
    await run(
      conversationsDouble([]),
      curriculumDouble({ moduleLessons: [], ancestors: [] }),
      { message: "hola" },
      writerDouble()
    );

    const system = seenParams[0].system as Anthropic.TextBlockParam[];
    expect(system).toHaveLength(2);
    expect(system[1].text).toContain("no ha declarado en qué lección va");
  });

  // -------------------------------------------------------------------------
  // Fila 24 — parámetros del modelo, y qué deltas se reenvían
  // -------------------------------------------------------------------------
  it("fila 24: modelo, max_tokens y thinking son los de hoy", async () => {
    await run(conversationsDouble([]), curriculumDouble(lessonInputs()), { message: "hola" }, writerDouble());

    expect(seenParams[0].model).toBe(TUTOR_MODEL);
    expect(TUTOR_MODEL).toBe("claude-sonnet-4-6");
    expect(seenParams[0].max_tokens).toBe(TUTOR_MAX_TOKENS);
    expect(TUTOR_MAX_TOKENS).toBe(1024);
    expect(seenParams[0].thinking).toEqual({ type: "adaptive" });
  });

  it("fila 24: los deltas de `thinking` no se reenvían", async () => {
    // Con `thinking: adaptive` el modelo emite razonamiento, y reenviarlo
    // significaría pintarlo en la burbuja del tutor: el estudiante vería el
    // camino hacia la solución que la regla inviolable del prompt existe para no
    // darle. `route.ts:150-156` ya filtra por `text_delta`; esto lo fija.
    scriptedEvents = [
      thinkingDelta("el estudiante busca <ul>, no se lo digo"),
      textDelta("¿Qué "),
      thinkingDelta("sigo pensando"),
      textDelta("observas?"),
    ];

    const writer = writerDouble();
    await run(conversationsDouble([]), curriculumDouble(lessonInputs()), { message: "hola" }, writer);

    expect(writer.chunks).toEqual(["¿Qué ", "observas?"]);
    expect(writer.chunks.join("")).not.toContain("<ul>");
    expect(writer.ended()).toBe(true);
  });

  it("fila 24: y lo que se persiste es el texto entero, sin el thinking", async () => {
    scriptedEvents = [thinkingDelta("interno"), textDelta("¿Qué "), textDelta("observas?")];

    const conversations = conversationsDouble([]);
    await run(conversations, curriculumDouble(lessonInputs()), { message: "hola" }, writerDouble());

    expect(conversations.append).toHaveBeenCalledWith("conv-1", [
      { role: "user", content: "hola" },
      { role: "assistant", content: "¿Qué observas?" },
    ]);
  });
});
