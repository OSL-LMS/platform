// Solo la declaración del tipo. La lógica de la frontera gratis/pago vive en
// `apps/api` desde PRD-003 fase 1; el camino en proceso se retiró en el paso 5
// de esa migración.
//
// ponytail: este archivo sobrevive únicamente porque el tipo tiene que estar en
// algún sitio hasta que exista `packages/shared`, que es su destino real
// (ADR-001 §2 y §7). No añadir lógica aquí.
//
// Regla de código: identificadores en inglés, comentarios en español.

export type Access = {
  allowed: boolean;
  // "none": aún sin trial (no ha escrito al tutor). Puede ver el chat;
  // su primer mensaje arranca la prueba (POST /v1/access/trial en apps/api).
  status: "none" | "trial" | "active" | "canceled";
  trialDaysLeft: number | null; // días restantes de trial; null si no aplica
};
