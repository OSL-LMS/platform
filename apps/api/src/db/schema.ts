// Única costura de apps/api contra el esquema compartido. Todo lo demás importa
// desde aquí, para que el acoplamiento tenga UN sitio y no siete.
//
// La alternativa —duplicar el esquema— introduce deriva entre dos definiciones
// de la misma tabla, que es justo el fallo que packages/shared existe para
// evitar (PRD-003 §Design Decisions).
//
// Regla de código: identificadores en inglés, comentarios en español.

export * from "../../../../packages/shared/src/schema.ts";
