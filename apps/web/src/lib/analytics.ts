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
// `FunnelEvent` declara el embudo ENTERO, pero desde PRD-003 este módulo solo
// emite tres de sus eventos: `server_pageview` (/api/t), `registered` (server
// action de registro) y `tutor_message_sent` (/api/chat). Los otros tres los
// emite `apps/api` con su propio cliente — `trial_started` al crear el trial, y
// los dos de suscripción desde el webhook de Paddle.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { PostHog } from "posthog-node";

// TIPA CON `FunnelEvent`, NO CON `TutorEvent` (PRD-006 §5.2). El séptimo miembro
// del union, `subscription_reconciled`, es AUDITORÍA y lo emite solo el
// reconciliador de `apps/api`; mezclarlo en el embudo lo corrompería con eventos
// que no son conversiones. Con este tipo ese evento NO ES EMITIBLE desde el
// proceso que sirve páginas — antes eso solo lo sostenía la separación de
// archivos.
//
// `import type` a propósito, y no es estilo: los checks importan este módulo
// bajo Node pelado, que no conoce el alias `@shared/*` del tsconfig. Un import
// de tipos se borra al despojar tipos y nunca llega a resolverse.
import type { FunnelEvent } from "@shared/analytics-events";

const apiKey = process.env.POSTHOG_API_KEY;

// Sin clave (local, CI, `next build`) la telemetría es un no-op silencioso.
// Nadie debe quedarse sin registrarse porque falte una variable de entorno.
const client = apiKey
  ? new PostHog(apiKey, {
      host: process.env.POSTHOG_HOST ?? "https://us.i.posthog.com",
    })
  : null;

// Fire-and-forget: PostHog encola en memoria y envía por lotes en segundo plano
// (el servidor de Railway es de larga vida, así que el lote sí llega a salir).
// Nunca `await` en el call site: la telemetría no puede añadir latencia ni
// tumbar el flujo del usuario.
export function track(
  email: string,
  event: FunnelEvent,
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
