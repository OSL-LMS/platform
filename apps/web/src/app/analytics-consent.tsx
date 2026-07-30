"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

// Consentimiento de medición en el navegador (decidido el 24 jul 2026; revierte
// con razón el "sin posthog-js" del 22 jul — ahora la landing es la pieza a
// medir). Opt-in real: hasta que el visitante acepta, aquí no se carga ni un
// byte de PostHog; si rechaza, no volvemos a preguntar. El embudo server-side
// (analytics.ts) no depende de esta elección.
//
// Regla de código: identificadores en inglés; texto de UI en español.

// v2 (24 jul): el alcance creció (session replay en páginas públicas), así que
// la elección v1 no vale — el banner se vuelve a preguntar con el texto nuevo.
const CONSENT_KEY = "analytics-consent-v2";

async function startAnalytics() {
  const apiKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!apiKey) return; // sin clave (local, CI): no-op silencioso, como en el servidor
  const { default: posthog } = await import("posthog-js");
  posthog.init(apiKey, {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com",
    // Los defaults fechados activan pageviews en cada navegación (App Router)
    // y pageleave — con eso salen visitas, profundidad y abandono por sección.
    defaults: "2025-05-24",
    // Session replay solo donde la política lo promete: páginas públicas, con
    // lo escrito enmascarado. El chat del tutor no se graba nunca — una
    // conversación de aprendizaje en pantalla es otra categoría de dato.
    // ponytail: chequeo por pathname al iniciar; si algún día hay navegación
    // cliente pública→/chat, pasar a stopSessionRecording() en el router.
    disable_session_recording: window.location.pathname.startsWith("/chat"),
    session_recording: { maskAllInputs: true },
  });
}

export default function AnalyticsConsent() {
  // El servidor siempre renderiza el banner oculto; la elección guardada se lee
  // tras montar (localStorage no existe en SSR y evitamos un mismatch).
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(CONSENT_KEY);
    if (stored === "granted") void startAnalytics();
    else if (stored === null) setVisible(true);
  }, []);

  if (!visible) return null;

  const decide = (granted: boolean) => {
    localStorage.setItem(CONSENT_KEY, granted ? "granted" : "denied");
    setVisible(false);
    if (granted) void startAnalytics();
  };

  return (
    <div className="consent" role="region" aria-label="Consentimiento de cookies">
      <p className="consent__text">
        ¿Podemos medir tu visita? Usamos cookies de análisis (PostHog) para saber
        qué partes de la página funcionan: qué visitas, hasta dónde llegas y una
        grabación de cómo se usa la página (lo que escribes queda oculto y el
        chat con el tutor no se graba). Si dices que no, no medimos nada en tu
        navegador — y todo funciona igual.{" "}
        <Link href="/privacidad">Más en la política de privacidad</Link>.
      </p>
      <div className="consent__actions">
        {/* Ambos botones con el mismo peso: rechazar no se esconde. */}
        <button type="button" className="consent__btn" onClick={() => decide(false)}>
          No, gracias
        </button>
        <button type="button" className="consent__btn consent__btn--accept" onClick={() => decide(true)}>
          Sí, medid
        </button>
      </div>
    </div>
  );
}
