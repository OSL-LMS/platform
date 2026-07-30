// Los nombres de evento de PostHog, en un solo sitio (PRD-006 §5.2).
//
// Antes de este archivo el union vivía duplicado por copia en
// `src/lib/analytics.ts` y en `apps/api/src/analytics/analytics.service.ts`, y
// ya había derivado: la copia de `apps/api` tenía un séptimo miembro que la de
// la raíz no. Unificar no es colapsar — la distinción embudo/auditoría es la
// razón de que el séptimo existiera, así que aquí queda declarada en el tipo en
// vez de sostenida por la separación de archivos.
//
// Regla de código: identificadores en inglés, comentarios en español.

// Los seis escalones del embudo. Es lo que `apps/web` puede emitir.
// `server_pageview` es el denominador (visitas anónimas vía el píxel /api/t):
// no es un escalón del embudo de usuario, es su base.
export type FunnelEvent =
  | "server_pageview"
  | "registered"
  | "trial_started"
  | "tutor_message_sent"
  | "subscription_activated"
  | "subscription_canceled";

// AUDITORÍA, NO EMBUDO (PRD-004 §3, §8.2). Lo emite el reconciliador por cada
// escritura aplicada, con `{ from, to, paddle_subscription_id }`.
// `subscription_activated` significa "Paddle nos lo confirmó por webhook" y su
// marca de tiempo alimenta el embudo; mezclar aquí las reparaciones lo
// corrompería con eventos que no son conversiones.
export type AuditEvent = "subscription_reconciled";

// Todo lo emitible. Solo `apps/api` tipa con esto; `apps/web` tipa con
// `FunnelEvent`, y por eso el evento de auditoría no es emitible desde el
// proceso que sirve páginas.
export type TutorEvent = FunnelEvent | AuditEvent;
