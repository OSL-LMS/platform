// Configuración edge-safe de Auth.js, para el middleware.
//
// El middleware corre en el Edge runtime de Next, donde NO puede correr `pg` ni
// el Drizzle adapter (son código Node). Por eso aquí NO va el adapter, ni la
// base de datos, ni los providers reales — solo lo mínimo para validar la sesión
// (JWT) y redirigir. La config completa (adapter + providers) vive en `auth.ts`,
// que solo usan las rutas API (Node).
//
// Regla de código: identificadores en inglés, comentarios en español.

import type { NextAuthConfig } from "next-auth";

export const authConfig = {
  // Railway corre detrás de un proxy: confiar en el Host de la petición.
  trustHost: true,

  // Pantalla de login propia en español.
  pages: {
    signIn: "/signin",
  },

  // Sin providers aquí: el middleware solo valida el JWT de sesión, no inicia
  // logins. Los providers reales (Resend) viven en auth.ts.
  providers: [],
} satisfies NextAuthConfig;
