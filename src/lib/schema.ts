// Esquema de la base de datos (Drizzle ORM, dialecto PostgreSQL).
//
// Dos grupos de tablas:
//   1. Tablas que exige el Drizzle adapter de Auth.js v5 (users, accounts,
//      sessions, verificationTokens). Los nombres de tabla y de columna siguen
//      EXACTAMENTE la forma canónica del adapter para que `DrizzleAdapter(db)`
//      funcione sin mapeo personalizado.
//   2. Tablas propias de la app (subscriptions, conversations).
//
// Regla de código: identificadores en inglés, comentarios en español.

import {
  pgTable,
  text,
  timestamp,
  integer,
  primaryKey,
  pgEnum,
  uuid,
  jsonb,
} from "drizzle-orm/pg-core";
import type { AdapterAccountType } from "next-auth/adapters";

// ---------------------------------------------------------------------------
// 1. Tablas requeridas por el adapter de Auth.js v5
// ---------------------------------------------------------------------------

// Tabla de usuarios. Se añade `currentLesson` (la lección que declara el
// estudiante, p. ej. "L3") sobre la forma base que pide el adapter.
export const users = pgTable("user", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name"),
  email: text("email").unique(),
  emailVerified: timestamp("emailVerified", { mode: "date" }),
  image: text("image"),
  // Columna propia de la app: el estudiante declara su lección a mano (v0).
  currentLesson: text("current_lesson"),
});

// Cuentas vinculadas (OAuth / proveedores). Clave primaria compuesta
// (provider, providerAccountId), igual que exige el adapter.
export const accounts = pgTable(
  "account",
  {
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AdapterAccountType>().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("providerAccountId").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (account) => [
    primaryKey({
      columns: [account.provider, account.providerAccountId],
    }),
  ]
);

// Sesiones de base de datos. La sesión por magic link de Auth.js las usa.
export const sessions = pgTable("session", {
  sessionToken: text("sessionToken").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date" }).notNull(),
});

// Tokens de verificación. El flujo de magic link (Email provider) los emite y
// consume. Clave primaria compuesta (identifier, token).
export const verificationTokens = pgTable(
  "verificationToken",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { mode: "date" }).notNull(),
  },
  (verificationToken) => [
    primaryKey({
      columns: [verificationToken.identifier, verificationToken.token],
    }),
  ]
);

// ---------------------------------------------------------------------------
// 2. Tablas propias de la app
// ---------------------------------------------------------------------------

// Estado de suscripción. Lo actualiza el webhook de Paddle.
export const subscriptionStatus = pgEnum("subscription_status", [
  "trial",
  "active",
  "canceled",
]);

// Una fila por correo. El correo es la llave que conecta con Paddle.
export const subscriptions = pgTable("subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  status: subscriptionStatus("status").notNull().default("trial"),
  trialEndsAt: timestamp("trial_ends_at", { mode: "date" }),
  paddleSubscriptionId: text("paddle_subscription_id"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
});

// Memoria de sesión del tutor. `messages` es un array de {role, content}.
export type ConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  messages: jsonb("messages")
    .$type<ConversationMessage[]>()
    .notNull()
    .default([]),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Tipos inferidos (cómodos para los agentes de auth y persistencia)
// ---------------------------------------------------------------------------

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Subscription = typeof subscriptions.$inferSelect;
export type NewSubscription = typeof subscriptions.$inferInsert;
export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
