// El tipo que hoy vive en `src/lib/access.ts:16`, SIN cambios de forma
// (PRD-003 §5.2).
//
// ponytail: duplicado del tipo de la raíz durante esta fase; lo cierra la fase de packages/shared, ver ADR-001 §7
//
// Regla de código: identificadores en inglés, comentarios en español.

export type Access = {
  allowed: boolean;
  // "none": aún sin trial (no ha escrito al tutor). Puede ver el chat;
  // su primer mensaje arranca la prueba (POST /v1/access/trial).
  status: "none" | "trial" | "active" | "canceled";
  trialDaysLeft: number | null; // días restantes de trial; null si no aplica
};
