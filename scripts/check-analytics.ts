// Comprobación de la telemetría. Se ejecuta con:
//   node scripts/check-analytics.ts
// Node 22+ ejecuta TypeScript directamente. Sin framework: si algo se rompe,
// el assert lo dice.
//
// Lo que se protege aquí es la única regla propia de `analytics.ts`: sin
// POSTHOG_API_KEY la telemetría es un no-op que NUNCA lanza. Si esto se rompe,
// una variable de entorno ausente tumbaría el registro de un estudiante — el
// peor fallo posible para un módulo que solo mide. (Que los nombres de evento
// sean los del embudo lo garantiza el tipo `TutorEvent` vía `tsc --noEmit`.)
import assert from "node:assert/strict";

delete process.env.POSTHOG_API_KEY;

const { track, flush } = await import("../src/lib/analytics.ts");

// No-op silencioso, con y sin propiedades, en todos los pasos del embudo.
assert.doesNotThrow(() => track("test@contextia.io", "registered", { source: "web" }));
assert.doesNotThrow(() => track("test@contextia.io", "trial_started"));
assert.doesNotThrow(() => track("test@contextia.io", "tutor_message_sent"));
assert.doesNotThrow(() => track("test@contextia.io", "subscription_activated"));
assert.doesNotThrow(() => track("test@contextia.io", "subscription_canceled"));

// Un correo vacío tampoco debe reventar: viene de datos externos (customData de
// Paddle), no de nosotros.
assert.doesNotThrow(() => track("", "subscription_activated"));

// Sin cliente no hay cola que vaciar: flush resuelve en vez de reventar.
await assert.doesNotReject(() => flush());

console.log("check-analytics: OK");
