// Telemetría del embudo: registro → primer mensaje al tutor → pago.
// Decisión y justificación: bóveda `30 Producto/Stack de la app del tutor.md`
// (2026-07-22).
//
// Todo el embudo ocurre en el servidor (server action de registro, ensureTrial,
// /api/chat, webhook de Paddle), así que se instrumenta con `posthog-node` y NO
// con `posthog-js`: sin cookies, sin banner de consentimiento y sin que un
// bloqueador de anuncios se coma el evento. El `distinct_id` es siempre el
// correo — la misma llave que ya enlaza registrations, subscriptions y Paddle.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { PostHog } from "posthog-node";

const apiKey = process.env.POSTHOG_API_KEY;

// Sin clave (local, CI, `next build`) la telemetría es un no-op silencioso.
// Nadie debe quedarse sin registrarse porque falte una variable de entorno.
const client = apiKey
  ? new PostHog(apiKey, {
      host: process.env.POSTHOG_HOST ?? "https://us.i.posthog.com",
    })
  : null;

// El embudo entero, explícito. Un union en vez de `string` para que un typo no
// invente un evento nuevo y parta el embudo en dos en el panel de PostHog.
export type TutorEvent =
  | "registered"
  | "trial_started"
  | "tutor_message_sent"
  | "subscription_activated"
  | "subscription_canceled";

// Fire-and-forget: PostHog encola en memoria y envía por lotes en segundo plano
// (el servidor de Railway es de larga vida, así que el lote sí llega a salir).
// Nunca `await` en el call site: la telemetría no puede añadir latencia ni
// tumbar el flujo del usuario.
export function track(
  email: string,
  event: TutorEvent,
  properties?: Record<string, unknown>
): void {
  if (!client) return;
  try {
    client.capture({ distinctId: email, event, properties });
  } catch (err) {
    console.error("Error enviando evento a PostHog:", err);
  }
}

// Vacía el lote pendiente. El servidor de Railway es de larga vida y no lo
// necesita en operación normal; existe para los procesos cortos —scripts de
// verificación, tareas de `scripts/`— que morirían antes de que salga el lote.
export async function flush(): Promise<void> {
  if (!client) return;
  try {
    await client.shutdown();
  } catch (err) {
    console.error("Error vaciando la cola de PostHog:", err);
  }
}
