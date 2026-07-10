"use client";

import { useEffect, useRef, useState } from "react";
import { logout } from "./actions";
import { LESSONS } from "@/lib/lessons";
import { formatMessage } from "@/lib/format-message";

type Message = { role: "user" | "assistant"; content: string };

// El backend responde { error } en JSON en cualquier fallo (status >= 400). Los
// códigos van en inglés; aquí los traducimos a un mensaje localizado y honesto
// según el status: un 401/403 no es transitorio, así que no decimos "reintenta".
function errorMessageFor(status: number): string {
  switch (status) {
    case 401:
      return "Tu sesión expiró. Vuelve a iniciar sesión para seguir.";
    case 403:
      return "Necesitas una suscripción activa para hablar con el tutor.";
    case 400:
      return "No pudimos procesar tu mensaje. Recarga la página e intenta otra vez.";
    default:
      return "Algo falló al hablar con el tutor. Reintenta en un momento.";
  }
}

// El código va en monoespaciada aunque el resto del mensaje sea prosa: un
// `git status` dentro de un párrafo se lee mal en una tipografía de texto.
function MessageBody({ content }: { content: string }) {
  return (
    <>
      {formatMessage(content).map((chunk, i) =>
        chunk.kind === "text" ? (
          <span key={i}>{chunk.value}</span>
        ) : chunk.block ? (
          <pre key={i} className="bubble__code">
            <code>{chunk.value}</code>
          </pre>
        ) : (
          <code key={i} className="bubble__inline-code">
            {chunk.value}
          </code>
        )
      )}
    </>
  );
}

// Recibe el historial ya cargado en el servidor (Server Component) como
// mensajes iniciales. El streaming token a token se conserva intacto.
export default function ChatClient({
  initialMessages = [],
  trialDaysLeft = null,
}: {
  initialMessages?: Message[];
  trialDaysLeft?: number | null;
}) {
  const [lesson, setLesson] = useState("L1");
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

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setError(null);

    const nextMessages: Message[] = [...messages, { role: "user", content: text }];
    setMessages(nextMessages);
    setInput("");
    setBusy(true);
    // Hueco del asistente que se va rellenando con el stream.
    setMessages((m) => [...m, { role: "assistant", content: "" }]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: nextMessages, lesson }),
      });
      if (!res.ok) {
        // Fallo determinista del servidor: leemos { error } para diagnóstico y
        // mostramos un mensaje localizado por status (no es transitorio).
        let code: string | undefined;
        try {
          code = (await res.json())?.error;
        } catch {
          // Cuerpo vacío o no-JSON: seguimos solo con el status.
        }
        if (code) console.error(`/api/chat ${res.status}:`, code);
        setError(errorMessageFor(res.status));
        setMessages((m) => m.slice(0, -1)); // quita el hueco del asistente
        return;
      }
      if (!res.body) throw new Error("respuesta sin cuerpo de stream");

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
    } catch {
      setError("Algo falló al hablar con el tutor. Reintenta en un momento.");
      setMessages((m) => m.slice(0, -1)); // quita el hueco del asistente
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
            <select value={lesson} onChange={(e) => setLesson(e.target.value)}>
              {LESSONS.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.id} — {l.title}
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
          autoFocus
        />
        <button type="submit" disabled={busy || !input.trim()}>
          {busy ? "Enviando…" : "Enviar"}
        </button>
      </form>
    </main>
  );
}
