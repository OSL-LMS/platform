// Route handler de Auth.js v5: expone GET/POST en /api/auth/* (callback del
// magic link, signin, signout, sesión, etc.). Toda la lógica vive en @/auth.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { handlers } from "@/auth";

export const { GET, POST } = handlers;
