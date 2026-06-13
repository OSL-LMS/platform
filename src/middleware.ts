// Middleware de Auth.js v5: protege TODAS las rutas de la app.
//
// Usa una instancia edge-safe de NextAuth construida SOLO con `authConfig` (sin
// adapter ni base de datos), para que pueda correr en el Edge runtime sin
// arrastrar `pg`. La sesión es JWT, así que se valida leyendo la cookie, sin
// consultar Postgres.
//
// Regla de código: identificadores en inglés, comentarios en español.

import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";

const { auth } = NextAuth(authConfig);

export default auth((req) => {
  const isLoggedIn = !!req.auth;
  const isOnSignin = req.nextUrl.pathname === "/signin";

  // No autenticado fuera de /signin → redirigir al login.
  if (!isLoggedIn && !isOnSignin) {
    return Response.redirect(new URL("/signin", req.nextUrl.origin));
  }

  // Ya autenticado pero en /signin → mandar a la app (raíz).
  if (isLoggedIn && isOnSignin) {
    return Response.redirect(new URL("/", req.nextUrl.origin));
  }

  // Resto de casos: dejar pasar.
});

export const config = {
  // Corre en todo MENOS: rutas de Auth.js (api/auth), assets internos de Next
  // (_next/static, _next/image), el favicon y archivos con extensión. /signin SÍ
  // pasa por el middleware (la lógica de arriba redirige a usuarios ya autenticados).
  matcher: [
    "/((?!api/auth|registro|precios|terminos|privacidad|reembolsos|_next/static|_next/image|favicon.ico|.*\\..*).*)",
  ],
};
