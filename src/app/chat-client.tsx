"use client";

import { useEffect, useRef, useState } from "react";
import { logout } from "./actions";

type Message = { role: "user" | "assistant"; content: string };

const LESSONS = ["L1", "L2", "L3", "L4", "L5", "L6", "L7"];

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

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, busy]);

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
      if (!res.ok || !res.body) throw new Error("respuesta no válida");

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
            ¿En qué lección vas?
            <select value={lesson} onChange={(e) => setLesson(e.target.value)}>
              {LESSONS.map((l) => (
                <option key={l} value={l}>
                  {l}
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
            {m.content || (busy && i === messages.length - 1 ? "…" : "")}
          </div>
        ))}
      </div>

      {error && <p className="chat__error">{error}</p>}

      <form
        className="chat__form"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Escribe aquí…"
          disabled={busy}
          autoFocus
        />
        <button type="submit" disabled={busy || !input.trim()}>
          Enviar
        </button>
      </form>
    </main>
  );
}
