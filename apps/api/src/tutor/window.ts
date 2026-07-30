// Costura hacia la ventana de contexto de `packages/shared` (PRD-005 §7,
// repuntada por PRD-006 §5.1).
//
// Trae `trimWindow` y `MAX_WINDOW_MESSAGES`. El módulo es puro y su invariante
// —"lo que viaja al modelo empieza por un turno `user`"— ya está probada desde
// la raíz (`scripts/check-window.ts`), así que copiarla sería duplicar una
// invariante fina con dos sitios donde puede derivar.
//
// AVISO PARA QUIEN LLAME (PRD-005 §5.2): esa invariante NO la da `trimWindow()`
// por debajo de 30 mensajes. `window.ts:33` devuelve el array tal cual y la
// búsqueda del primer `user` solo corre en la rama de recorte. Recortar el
// prefijo hasta el primer `user` es responsabilidad del llamante — lo hace
// `sanitizeThread()` en `conversations.repository.ts`.
//
// Regla de código: identificadores en inglés, comentarios en español.

export * from "../../../../packages/shared/src/window.ts";
