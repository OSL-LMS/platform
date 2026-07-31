// Fixture de tipos: afirma que `apps/web` NO puede emitir el evento de
// auditoría (PRD-006 §5.2 y §9 fila 14).
//
// POR QUÉ ESTO NO ES UN TEST NORMAL. La invariante que sostiene la separación
// embudo/auditoría es de TIPOS, y los tipos no existen en tiempo de ejecución:
// `apps/web/scripts/check-analytics.ts` corre bajo Node pelado, que borra los
// tipos en vez de comprobarlos, así que allí se puede afirmar el conjunto de
// miembros leyendo el texto fuente pero NO que una llamada sea ilegal. Esta
// afirmación la hace el typechecker de `next build`, que es el único que ve la
// diferencia.
//
// CÓMO FALLA, que es lo que le da valor: `@ts-expect-error` exige que la línea
// siguiente TENGA un error. Si alguien vuelve a ensanchar el parámetro de
// `track()` de `FunnelEvent` a `TutorEvent`, la llamada pasa a ser legal, el
// error desaparece, y entonces es el propio `@ts-expect-error` el que se
// convierte en error ("unused '@ts-expect-error' directive"). El build se pone
// rojo por quitar la restricción, que es exactamente la deriva que PRD-006 §1
// documenta habiendo ocurrido ya una vez entre las dos copias del union.
//
// Este módulo no lo importa nadie a propósito: existe para ser typecheckeado,
// no para ejecutarse. La función nunca se llama.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { track } from "@/lib/analytics";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function auditEventIsNotEmittableFromWeb(): void {
  // Los seis del embudo sí son legales desde aquí.
  track("estudiante@ejemplo.com", "registered");
  track("estudiante@ejemplo.com", "tutor_message_sent");

  // @ts-expect-error `subscription_reconciled` es AuditEvent, no FunnelEvent:
  // lo emite solo el reconciliador de apps/api (PRD-004 §3, §8.2). Que esta
  // línea deje de dar error significa que la frontera se abrió.
  track("estudiante@ejemplo.com", "subscription_reconciled");
}
