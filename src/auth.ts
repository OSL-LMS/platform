// Configuración central de Auth.js v5 (next-auth beta) — versión completa (Node).
//
// Login sin contraseña: magic link por correo (provider Resend). Los usuarios y
// los tokens de verificación viven en NUESTRA Postgres vía el Drizzle adapter.
// La sesión es JWT (cookie), para que el middleware pueda validarla en el Edge
// runtime sin tocar la base de datos. El adapter sigue presente para crear el
// usuario y los tokens del magic link.
//
// Contrato importante para el resto del equipo: la sesión expone
// `session.user.id` (string). El agente de persistencia del chat depende de eso.
//
// Regla de código: identificadores en inglés, comentarios en español.

import NextAuth, { type DefaultSession } from "next-auth";
import Resend from "next-auth/providers/resend";
import { DrizzleAdapter } from "@auth/drizzle-adapter";

import { authConfig } from "@/auth.config";
import { db } from "@/lib/db";
import {
  users,
  accounts,
  sessions,
  verificationTokens,
  registrations,
} from "@/lib/schema";

// Aumentamos el tipo de la sesión para que `session.user.id` (string) sea parte
// del contrato tipado. Sin esto, asignarlo en el callback rompería bajo `strict`.
declare module "next-auth" {
  interface Session {
    user: {
      id: string;
    } & DefaultSession["user"];
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  // Base edge-safe (pages, trustHost) compartida con el middleware.
  ...authConfig,

  // El adapter usa nombres de tabla canónicos (singular: user/account/session/
  // verificationToken), así que le pasamos el mapeo explícito desde @/lib/schema.
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),

  // Sesión JWT (no en DB): validable en el middleware Edge sin consultar Postgres.
  // El adapter sigue creando el usuario y los verification tokens del magic link.
  session: { strategy: "jwt" },

  providers: [
    Resend({
      // La clave se lee de AUTH_RESEND_KEY automáticamente; la pasamos explícita
      // para tolerar también RESEND_API_KEY si así está configurada en Railway.
      apiKey: process.env.AUTH_RESEND_KEY ?? process.env.RESEND_API_KEY,
      // Remitente verificado en Resend (dominio angelkurten.com).
      from: "tutor@angelkurten.com",
    }),
  ],

  events: {
    // Entrar también te registra: el correo es UNA identidad, y `registrations`
    // el único activo de correos. Idempotente (onConflictDoNothing) y
    // best-effort: un fallo aquí nunca debe romper el login.
    async signIn({ user }) {
      const email = user.email?.trim().toLowerCase();
      if (!email) return;
      try {
        await db
          .insert(registrations)
          .values({ email, source: "signin" })
          .onConflictDoNothing({ target: registrations.email });
      } catch {
        // Best-effort: el login sigue aunque el upsert falle.
      }
    },
  },

  callbacks: {
    // En el sign-in inicial llega `user` (la fila creada por el adapter). Guardamos
    // su id en el token para poder exponerlo en la sesión.
    jwt({ token, user }) {
      if (user) {
        token.id = user.id;
      }
      return token;
    },
    // Exponemos el id en la sesión: contrato del equipo `session.user.id`.
    session({ session, token }) {
      if (token.id) {
        session.user.id = token.id as string;
      }
      return session;
    },
  },
});
