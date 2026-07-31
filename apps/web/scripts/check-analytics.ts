// Comprobación de la telemetría. Se ejecuta con:
//   node scripts/check-analytics.ts
// Node 22+ ejecuta TypeScript directamente. Sin framework: si algo se rompe,
// el assert lo dice.
//
// Lo que se protege aquí es la única regla propia de `analytics.ts`: sin
// POSTHOG_API_KEY la telemetría es un no-op que NUNCA lanza. Si esto se rompe,
// una variable de entorno ausente tumbaría el registro de un estudiante — el
// peor fallo posible para un módulo que solo mide. (Que los nombres de evento
// sean los del embudo lo garantiza el tipo `FunnelEvent` vía `tsc --noEmit`.)
//
// Desde PRD-006 §9 fila 5 cubre además la SEPARACIÓN embudo/auditoría, y la
// afirma sobre el TEXTO FUENTE de `packages/shared/src/analytics-events.ts`: la
// mitad de tipos no cabe en este script porque corre bajo Node pelado, que
// borra los tipos en vez de comprobarlos. Que `apps/web` no PUEDA emitir el
// evento de auditoría lo afirma la fila 14, con `next build`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

delete process.env.POSTHOG_API_KEY;

const { track, flush } = await import("../src/lib/analytics.ts");

// ---------------------------------------------------------------------------
// PRD-006 §9 fila 5 — el union, separado en dos mitades con miembros exactos
// ---------------------------------------------------------------------------
{
  const events = readFileSync(
    join(import.meta.dirname, "..", "..", "..", "packages", "shared", "src", "analytics-events.ts"),
    "utf8"
  );

  /** Los miembros literales declarados por un union, en orden de aparición. */
  const members = (name: string): string[] => {
    const body = events.match(new RegExp(`export type ${name}\\s*=([^;]*);`))?.[1];
    assert.ok(body, `analytics-events.ts no declara \`export type ${name}\``);
    return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  };

  assert.deepEqual(
    members("FunnelEvent").sort(),
    [
      "registered",
      "server_pageview",
      "subscription_activated",
      "subscription_canceled",
      "trial_started",
      "tutor_message_sent",
    ],
    "FunnelEvent tiene que declarar EXACTAMENTE los seis escalones del embudo"
  );

  // El miembro de auditoría va aparte, y solo. Meterlo en `FunnelEvent`
  // corrompería el embudo con eventos que no son conversiones (PRD-004 §8.2), y
  // lo haría emitible desde el proceso que sirve páginas.
  assert.deepEqual(
    members("AuditEvent"),
    ["subscription_reconciled"],
    "AuditEvent tiene que declarar EXACTAMENTE el evento del reconciliador"
  );
}

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
