"use client";

import { useEffect, useRef, useState } from "react";
import { logout } from "./actions";
import type { LessonOption } from "@/lib/curriculum";
import { formatMessage } from "@/lib/format-message";
import {
  TUTOR_MESSAGE_MAX_LENGTH,
  buildTurnBody,
  decideTurnFailure,
  type TurnFailure,
} from "@/lib/tutor-turn";

type Message = { role: "user" | "assistant"; content: string };

// El backend responde { error } en JSON en cualquier fallo (status >= 400). La
// traducción del status a un mensaje localizado y honesto vive en
// src/lib/tutor-turn.ts junto a las otras dos decisiones del cliente, porque
// este repositorio no tiene runner de componentes React y allí sí se prueban
// (PRD-005 §9 filas 36-38).

// El código va en monoespaciada aunque el resto del mensaje sea prosa: un
// `git status` dentro de un párrafo se lee mal en una tipografía de texto.
function MessageBody({ content }: { content: string }) {
  return (
    <>
      {formatMessage(content).map((chunk, i) => {
        if (chunk.kind === "text") return <span key={i}>{chunk.value}</span>;
        if (chunk.kind === "emphasis")
          return chunk.strong ? (
            <strong key={i}>{chunk.value}</strong>
          ) : (
            <em key={i}>{chunk.value}</em>
          );
        return chunk.block ? (
          <pre key={i} className="bubble__code">
            <code>{chunk.value}</code>
          </pre>
        ) : (
          <code key={i} className="bubble__inline-code">
            {chunk.value}
          </code>
        );
      })}
    </>
  );
}

// Recibe el historial ya cargado en el servidor (Server Component) como
// mensajes iniciales. El streaming token a token se conserva intacto.
export default function ChatClient({
  initialMessages = [],
  trialDaysLeft = null,
  lessons = [],
}: {
  initialMessages?: Message[];
  trialDaysLeft?: number | null;
  /** Solo `{slug, title}`: `payload.stuck` no tiene por qué viajar al cliente.
   *  Vacío en la rama sin sesión, que no consulta la base de datos. */
  lessons?: LessonOption[];
}) {
  // La selección inicial sale del currículo, no del literal "L1" que estaba
  // escrito a mano: el `slug` es mutable, y un adoptante sin ningún "L1" tenía
  // el selector roto desde el primer día.
  const [lesson, setLesson] = useState(lessons[0]?.slug ?? "");
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, busy]);

  // El campo crece con el texto hasta un tope, y vuelve a encogerse al enviar.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  // Aplica la decisión de decideTurnFailure() sobre el hueco del asistente.
  // La decisión es de tutor-turn.ts; aquí solo se cablea — más el descarte de
  // una burbuja que quedó literalmente vacía, que no es una decisión de fase.
  function applyFailure(failure: TurnFailure) {
    const recovery = decideTurnFailure(failure);
    setError(recovery.notice);
    setMessages((m) =>
      recovery.keepPartial && m[m.length - 1]?.content ? m : m.slice(0, -1)
    );
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setError(null);

    // Turno del usuario + hueco del asistente que se va rellenando con el stream.
    setMessages((m) => [
      ...m,
      { role: "user", content: text },
      { role: "assistant", content: "" },
    ]);
    setInput("");
    setBusy(true);

    try {
      // TRES FASES, TRES RAMAS. Hasta PRD-005 §4 caso 4 las tres vivían en un
      // solo `catch` que hacía `m.slice(0, -1)` y borraba la burbuja ENTERA
      // aunque ya tuviera texto pintado: el comentario decía "quita el hueco del
      // asistente" y describía solo uno de los casos que atrapaba. Un fallo a
      // media respuesta tiene que DEJAR lo que el estudiante ya leyó.
      let res: Response;
      try {
        res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // EL HILO YA NO VIAJA (§5.2, goal 2): un solo mensaje, el suyo. El
          // servidor lo lee de `conversations`, así que el cliente ya no puede
          // fabricar turnos `assistant`.
          body: JSON.stringify(buildTurnBody(text, lesson)),
        });
      } catch (err) {
        // Fase 1: ni siquiera hubo respuesta (offline, DNS, conexión cortada al
        // abrir). Antes esta rama no registraba nada, a diferencia de `!res.ok`.
        console.error("/api/chat: fallo de red antes de abrir el stream:", err);
        applyFailure({ phase: "request" });
        return;
      }

      if (!res.ok) {
        // Fase 2: hubo respuesta y es un fallo determinista. Leemos { error }
        // para diagnóstico y mostramos un mensaje localizado por status.
        let code: string | undefined;
        try {
          code = (await res.json())?.error;
        } catch {
          // Cuerpo vacío o no-JSON: seguimos solo con el status.
        }
        if (code) console.error(`/api/chat ${res.status}:`, code);
        applyFailure({ phase: "status", status: res.status });
        return;
      }

      if (!res.body) {
        console.error("/api/chat: respuesta 200 sin cuerpo de stream");
        applyFailure({ phase: "request" });
        return;
      }

      try {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let acc = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          acc += decoder.decode(value, { stream: true });
          setMessages((m) => {
            const copy = [...m];
            copy[copy.length - 1] = { role: "assistant", content: acc };
            return copy;
          });
        }
      } catch (err) {
        // Fase 3: se cortó a media respuesta. El texto ya pintado SE QUEDA.
        console.error("/api/chat: se cortó el stream a media respuesta:", err);
        applyFailure({ phase: "stream" });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="chat">
      <header className="chat__header">
        <h1>Tu tutor</h1>
        <div className="chat__header-right">
          <label className="chat__lesson">
            <span className="chat__lesson-full">¿En qué lección vas?</span>
            <span className="chat__lesson-short">Lección:</span>
            <select
              value={lesson}
              onChange={(e) => setLesson(e.target.value)}
              disabled={lessons.length === 0}
            >
              {lessons.map((l) => (
                <option key={l.slug} value={l.slug}>
                  {l.slug} — {l.title}
                </option>
              ))}
            </select>
          </label>
          <form action={logout}>
            <button type="submit" className="chat__logout">
              Salir
            </button>
          </form>
        </div>
      </header>

      {trialDaysLeft !== null && trialDaysLeft <= 2 && (
        <p className="chat__trial">
          Tu prueba termina en {trialDaysLeft} {trialDaysLeft === 1 ? "día" : "días"} —
          asegura el precio fundador antes de que suba.
        </p>
      )}

      <div className="chat__messages" ref={scrollRef}>
        {messages.length === 0 && (
          <p className="chat__empty">
            Cuéntame en qué andas trabajando o dónde te atascaste. No te voy a dar
            la respuesta — te voy a ayudar a encontrarla tú.
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`bubble bubble--${m.role}`}>
            {m.content ? (
              <MessageBody content={m.content} />
            ) : busy && i === messages.length - 1 ? (
              "…"
            ) : (
              ""
            )}
          </div>
        ))}
      </div>

      {/* No ponemos aria-live sobre el stream: anunciaría token a token. Basta con
          avisar de que el tutor está respondiendo; el texto queda luego en el DOM. */}
      <p className="sr-only" role="status">
        {busy ? "El tutor está escribiendo una respuesta." : ""}
      </p>

      {/* role="alert" para que un lector de pantalla anuncie el fallo: sin esto
          el error solo existe para quien puede verlo. */}
      {error && (
        <p className="chat__error" role="alert">
          {error}
        </p>
      )}

      <form
        className="chat__form"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <label className="sr-only" htmlFor="chat-input">
          Escribe tu mensaje para el tutor
        </label>
        <textarea
          id="chat-input"
          ref={inputRef}
          rows={1}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          // Enter envía; Shift+Enter salta de línea. Un estudiante pega errores de
          // consola y fragmentos de código: el campo tiene que aguantar varias líneas.
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Escribe aquí… (Enter envía, Shift+Enter salta de línea)"
          disabled={busy}
          // La misma cota que `@Length(1, 4000)` en turn.dto.ts (§5.1). Sin
          // ella el límite del DTO llega como un 400 con el consejo inútil de
          // "recarga la página" DESPUÉS de que el estudiante escribiera el
          // mensaje largo.
          maxLength={TUTOR_MESSAGE_MAX_LENGTH}
          autoFocus
        />
        <button type="submit" disabled={busy || !input.trim()}>
          {busy ? "Enviando…" : "Enviar"}
        </button>
      </form>
    </main>
  );
}
