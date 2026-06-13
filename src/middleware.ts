// Middleware de Auth.js v5: protege SOLO la app del tutor (/chat). Todo lo demás
// del sitio es público (landing, precios, registro, páginas legales, login) para
// que un visitante —y Paddle— pueda verlo sin iniciar sesión.
//
// Usa una instancia edge-safe (authConfig, sin adapter ni pg). La sesión es JWT,
// validable en el Edge runtime leyendo la cookie.
//
// Regla de código: identificadores en inglés, comentarios en español.

import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";

const { auth } = NextAuth(authConfig);

export default auth((req) => {
  // En /chat: sin sesión → al login.
  if (!req.auth) {
    return Response.redirect(new URL("/signin", req.nextUrl.origin));
  }
});

export const config = {
  // Solo /chat (y subrutas) pasan por el middleware; el resto es público.
  matcher: ["/chat", "/chat/:path*"],
};
