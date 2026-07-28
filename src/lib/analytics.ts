// Telemetría del embudo: registro → primer mensaje al tutor → pago.
// Decisión y justificación: bóveda `30 Producto/Stack de la app del tutor.md`
// (2026-07-22).
//
// Todo el embudo ocurre en el servidor, así que se instrumenta con
// `posthog-node` y NO con `posthog-js`: sin cookies, sin banner de
// consentimiento y sin que un bloqueador de anuncios se coma el evento. El
// `distinct_id` es siempre el correo — la misma llave que ya enlaza
// registrations, subscriptions y Paddle.
//
// El union de abajo declara el embudo ENTERO, pero desde PRD-003 este módulo
// solo emite tres de sus eventos: `server_pageview` (/api/t), `registered`
// (server action de registro) y `tutor_message_sent` (/api/chat). Los otros
// tres los emite `apps/api` con su propio cliente — `trial_started` al crear
// el trial, y los dos de suscripción desde el webhook de Paddle.
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
// `server_pageview` es el denominador (visitas a páginas públicas, anónimas,
// vía el píxel /api/t): no es un escalón del embudo de usuario, es su base.
export type TutorEvent =
  | "server_pageview"
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
