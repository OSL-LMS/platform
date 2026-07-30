// El turno del tutor: decide si se concede, compone lo que ve el modelo, y
// bombea el stream hacia quien escribe la respuesta (PRD-005 §5.2 y §5.4).
//
// Portado desde `src/app/api/chat/route.ts`. Se conserva SIN CAMBIO OBSERVABLE
// (goal 3) el prompt certificado, el bloque de contexto de la lección, la
// ventana de 30 mensajes, `max_tokens: 1024`, `thinking: adaptive` y el
// `cache_control: ephemeral` del primer bloque de system.
//
// LO QUE SÍ CAMBIA, Y ES EL GOAL 2: **el hilo que viaja al modelo sale de
// `conversations`, nunca del cuerpo de la petición.** El cliente manda un solo
// mensaje, el suyo. Hasta hoy `chat-client.tsx:105` mandaba el hilo entero
// —turnos `assistant` incluidos— y `route.ts:143` lo reenviaba tras recortarlo,
// así que un cliente podía FABRICAR lo que el tutor supuestamente dijo antes y
// meterlo en el contexto del modelo como memoria propia. La regla pedagógica
// inviolable del prompt resiste instrucciones DENTRO de la conversación; un
// `assistant` falso no es una instrucción del estudiante, es memoria inventada.
//
// LO QUE ESO COMPRA Y LO QUE CUESTA (§5.2). La base pasa a ser la única fuente
// de lo que el modelo ve, así que un `append()` fallido deja de ser inocuo y
// pasa a ser AMNESIA: la UI sigue mostrando el intercambio y el modelo del turno
// siguiente ya no lo ve. Se conserva el best-effort —tumbar una respuesta ya
// entregada es peor— pero el fallo sube de `console.error` a una línea con
// `name=`/`code=` bajo §8.3. Fila 7 de §9.
//
// Regla de código: identificadores en inglés, comentarios en español.

import type Anthropic from "@anthropic-ai/sdk";
import { ForbiddenException, Inject, Injectable, Logger } from "@nestjs/common";

import { AccessService } from "../access/access.service.ts";
import { AnalyticsService } from "../analytics/analytics.service.ts";
import { causeCode, errorName } from "../common/error-fields.ts";
import type { ConversationMessage } from "../db/schema.ts";
import type { SessionUser } from "../session/session.guard.ts";
import { ANTHROPIC_CLIENT, type TutorStreamer } from "./anthropic.client.ts";
import { ConversationsRepository } from "./conversations.repository.ts";
import { buildLessonContext } from "./curriculum-context.ts";
import { CurriculumRepository } from "./curriculum.repository.ts";
import { TUTOR_SYSTEM_PROMPT } from "./tutor-prompt.ts";
import type { TurnDto } from "./turn.dto.ts";
import { trimWindow } from "./window.ts";

/** Los tres parámetros del modelo que el goal 3 congela. */
export const TUTOR_MODEL = "claude-sonnet-4-6";
export const TUTOR_MAX_TOKENS = 1024;

/** Lo que el controlador presta al servicio: la mecánica de Express se queda en
 *  el controlador (§5.4) y aquí solo se escribe texto y se cierra. */
export type TurnWriter = {
  write(text: string): void;
  end(): void;
};

export type TurnOptions = {
  /** `t=0` del goal 9: la entrada al handler, en las dos mitades de la
   *  migración. Lo fija el controlador porque es él quien recibe la petición. */
  startedAt: number;
  /** Se dispara cuando el llamante se va. El controlador lo ata al `close` de la
   *  respuesta con la bandera de "ya cerré" (§5.4). */
  signal: AbortSignal;
};

@Injectable()
export class TutorService {
  private readonly logger = new Logger(TutorService.name);

  constructor(
    @Inject(ANTHROPIC_CLIENT) private readonly anthropic: TutorStreamer,
    private readonly conversations: ConversationsRepository,
    private readonly curriculum: CurriculumRepository,
    private readonly access: AccessService,
    private readonly analytics: AnalyticsService
  ) {}

  async runTurn(
    user: SessionUser,
    turn: TurnDto,
    writer: TurnWriter,
    options: TurnOptions
  ): Promise<void> {
    // Frontera gratis/pago. `ensureTrial` y no `getAccess`: el trial de 7 días
    // arranca con el PRIMER MENSAJE al tutor, no al hacer login.
    //
    // AHORA ES UNA LLAMADA EN PROCESO, no un salto por el puente (§5.1). La
    // consecuencia está escrita y le toca al paso E de §10: `POST
    // /v1/access/trial` se queda sin un solo llamante legítimo mientras sigue
    // abierto y escribiendo en `subscriptions`.
    const access = await this.access.ensureTrial(user.email);

    if (!access.allowed) {
      // OBJETO, NO CADENA, y no es cosmética: `new ForbiddenException("…")` hace
      // que el filtro global devuelva `{ statusCode, message, error }`, que no es
      // la forma que `chat-client.tsx:110-114` lee. Con objeto, `getResponse()`
      // lo devuelve tal cual. Fila 16 de §9.
      throw new ForbiddenException({ error: "Subscription required" });
    }

    // Paso intermedio del embudo. Se emite al ACEPTAR el turno —antes de abrir el
    // stream— porque lo que mide es que el estudiante habló con el tutor, y eso
    // ya pasó aunque Anthropic falle a mitad. Un turno denegado con 403 sale por
    // el `throw` de arriba y NO lo emite (fila 18).
    //
    // Sin `access_ms`: en este camino no hay puente que cronometrar. La señal de
    // latencia de esta fase es `first_token_ms`, más abajo.
    this.analytics.track(user.email, "tutor_message_sent", {
      access_status: access.status,
      lesson: turn.lesson ?? null,
    });

    const conversation = await this.conversations.getOrCreate(user.userId);
    const { moduleLessons, ancestors } = await this.curriculum.lessonContext(turn.lesson);

    // Prompt estable (cacheado) + temario como bloque aparte, igual que en el
    // runner de evals. El prompt no sabe nada del curso: módulo, lecciones y
    // atascos son dato y viajan aquí, así que una clase nueva es un nodo en
    // `curriculum/<slug>.json` y no una versión del tutor.
    //
    // El `cache_control` va SOLO en el primero. El segundo crece con el temario y
    // cachearlo tampoco ayudaría —cambia con la lección declarada—; de ahí la
    // cota de 4 000 caracteres por valor de `curriculum-file.ts`.
    const system: Anthropic.TextBlockParam[] = [
      { type: "text", text: TUTOR_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      { type: "text", text: buildLessonContext(moduleLessons, ancestors, turn.lesson) },
    ];

    // El hilo saneado (con el prefijo ya recortado hasta el primer `user`, ver
    // `sanitizeThread`) más el turno del estudiante, y encima la ventana de 30.
    const studentTurn: ConversationMessage = { role: "user", content: turn.message };
    const outgoing = trimWindow([...conversation.messages, studentTurn]);

    const stream = this.anthropic.messages.stream({
      model: TUTOR_MODEL,
      max_tokens: TUTOR_MAX_TOKENS,
      thinking: { type: "adaptive" },
      system,
      messages: outgoing.map((m) => ({ role: m.role, content: m.content })),
    });

    // Goal 8, eslabón `apps/api` → Anthropic. Sin esto el turno abandonado se
    // sigue facturando hasta terminar y el único síntoma es la factura.
    //
    // La comprobación previa no es ceremonia: un listener registrado sobre una
    // señal YA abortada no dispara, y ese es justo el caso del cliente que se va
    // mientras se resolvían el acceso, la conversación y el currículo.
    if (options.signal.aborted) stream.abort();
    else options.signal.addEventListener("abort", () => stream.abort(), { once: true });

    let assistantText = "";
    let firstTokenSeen = false;

    try {
      for await (const event of stream) {
        // SOLO los `text_delta`, como hoy (`route.ts:150-156`): los deltas de
        // `thinking` no viajan al navegador. Fila 24 de §9.
        if (event.type !== "content_block_delta" || event.delta.type !== "text_delta") continue;

        if (!firstTokenSeen) {
          firstTokenSeen = true;
          // La señal de ADR-001 §6 y del goal 9. Es un entero de milisegundos y
          // no lleva PII. Va como línea de log y no como propiedad de
          // `tutor_message_sent` a propósito: ese evento se emite al ACEPTAR el
          // turno, y moverlo aquí perdería del embudo los turnos que fallan
          // antes del primer token (§Design Decisions).
          this.logger.log(
            `first_token_ms=${Math.round(performance.now() - options.startedAt)}`
          );
        }

        assistantText += event.delta.text;
        writer.write(event.delta.text);
      }
    } catch (err: unknown) {
      // El llamante se fue: el `abort()` de arriba hace que la iteración
      // rechace. No se persiste (§5.4) y no se reporta como fallo, porque no lo
      // es. Fila 9 de §9.
      if (options.signal.aborted) return;

      // Fallo real. Sube al filtro global, que decide por `headersSent` entre un
      // 500 con cuerpo (nada escrito todavía) y cortar la conexión (§5.4). No se
      // persiste nada: fila 6 y fila 8 de §9.
      throw err;
    }

    // Cerrar ANTES de persistir, como hoy (`route.ts:163-172`): el guardado no le
    // añade latencia al estudiante, que ya tiene su respuesta entera.
    writer.end();

    try {
      await this.conversations.append(conversation.id, [
        studentTurn,
        { role: "assistant", content: assistantText },
      ]);
    } catch (err: unknown) {
      // BEST-EFFORT A SABIENDAS. Tumbar una respuesta ya entregada sería peor,
      // pero desde el goal 2 este fallo es amnesia y no un log de cortesía: el
      // turno siguiente no verá este intercambio. Reglas de §8.3 — `name` y
      // `code`, nunca el texto del turno ni el de la respuesta.
      this.logger.error(
        `No se pudo persistir el turno: name=${errorName(err)} code=${causeCode(err)}`
      );
    }
  }
}
