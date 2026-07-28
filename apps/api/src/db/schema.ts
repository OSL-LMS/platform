// Única costura de apps/api contra el esquema de la raíz. Todo lo demás importa
// desde aquí, para que la deuda tenga UN sitio y no siete.
//
// ponytail: import temporal a la raíz; lo cierra la fase de packages/shared, ver ADR-001 §7
//
// La alternativa —duplicar el esquema— introduce deriva entre dos definiciones
// de la misma tabla, que es justo el fallo que packages/shared existe para
// evitar (PRD-003 §Design Decisions).
//
// Regla de código: identificadores en inglés, comentarios en español.

export * from "../../../../src/lib/schema.ts";
