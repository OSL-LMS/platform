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

import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  integer,
  primaryKey,
  pgEnum,
  uuid,
  jsonb,
  unique,
  index,
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type { AdapterAccountType } from "next-auth/adapters";
import { EVIDENCE_STATUSES } from "./evidence.ts";

// ---------------------------------------------------------------------------
// 1. Tablas requeridas por el adapter de Auth.js v5
// ---------------------------------------------------------------------------

// Tabla de usuarios: la forma base que pide el adapter, sin columnas propias.
// La lección del estudiante viaja por petición al tutor y se guarda en
// `registrations`; aquí nunca se escribía.
export const users = pgTable("user", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name"),
  email: text("email").unique(),
  emailVerified: timestamp("emailVerified", { mode: "date" }),
  image: text("image"),
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

// Lista de registro (parte ancha del embudo): correos capturados desde el
// directo de Twitch / VODs para avisos de clase. Es el activo propio que
// sobrevive a las plataformas. Separada de `user` (eso es el login al tutor).
export const registrations = pgTable("registrations", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name"),
  currentLesson: text("current_lesson"), // lección declarada, p. ej. "L1"
  source: text("source"), // de dónde llegó (p. ej. "twitch", "youtube")
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
});

// El currículo como árbol de profundidad libre (PRD-002). La tabla es una
// PROYECCIÓN de `curriculum/<slug>.json`, que es la fuente de verdad autoral:
// el único escritor en el entorno desplegado es `scripts/load-curriculum.ts`.
//
// `id` lo aporta el archivo y ES la identidad del nodo: sobrevive a recargas,
// reordenamientos, cambios de padre y renombrados de `slug`. `slug` es una
// etiqueta pública y MUTABLE.
export const curriculumNodes = pgTable(
  "curriculum_nodes",
  {
    id: uuid("id").primaryKey(),
    // AVISO: no hay aislamiento entre currículos. Este valor sale de
    // CURRICULUM_SLUG (configuración de servidor) y NUNCA del request.
    curriculum: text("curriculum").notNull(),
    parentId: uuid("parent_id").references((): AnyPgColumn => curriculumNodes.id, {
      onDelete: "cascade",
    }),
    kind: text("kind").notNull(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    position: integer("position").notNull(),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (node) => [
    // Nombre estable a propósito: el cargador hace `SET CONSTRAINTS
    // curriculum_nodes_curriculum_slug_key DEFERRED` y necesita a qué apuntar.
    // La cláusula DEFERRABLE se aplica a mano en el SQL de la migración —
    // drizzle-kit no la emite (PRD-002 §6.1).
    unique("curriculum_nodes_curriculum_slug_key").on(node.curriculum, node.slug),
    index("curriculum_nodes_parent_position_idx").on(
      node.curriculum,
      node.parentId,
      node.position
    ),
  ]
);

// La evidencia que un estudiante entrega por lección (PRD-007). Una fila por
// `(usuario, lección)`: reenviar ACTUALIZA la fila, nunca la duplica.
//
// El estado distingue declarado de verificado en el ESQUEMA, no en la
// interpretación: es lo que permite que un tercero pregunte por SQL qué está
// verificado sin conocer la aplicación.
export const evidenceStatus = pgEnum("evidence_status", EVIDENCE_STATUSES);

export const lessonEvidence = pgTable(
  "lesson_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // SIN clave foránea a `curriculum_nodes`, a propósito (PRD-007 §6.3 / D6).
    // La elección real no era contra la cascada —el cargador hace upsert y solo
    // borra bajo `--allow-deletes`— sino contra `ON DELETE NO ACTION`, que haría
    // que retirar una lección del temario abortase la carga por el trabajo que
    // veinte estudiantes ya hicieron. Sin la clave, el nodo se borra, las filas
    // SOBREVIVEN, la lectura las omite mientras el nodo no resuelva, y vuelven
    // solas si el nodo regresa: el `id` es identidad estable.
    lessonNodeId: uuid("lesson_node_id").notNull(),
    url: text("url").notNull(),
    status: evidenceStatus("status").notNull().default("declared"),
    // Código de la lista cerrada de §4.2, nunca prosa del destino: lo que traen
    // los errores de red es el host o la IP resuelta (§8.5).
    failureReason: text("failure_reason"),
    // `{ mode: "date" }` en las tres NO es decorativo: el defecto de Drizzle es
    // modo cadena y devuelve `2026-07-31 18:22:41`, que no es ni un `Date` ni el
    // literal ISO que promete §5.1.
    checkedAt: timestamp("checked_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (row) => [
    // Nombre estable: es la llave del upsert y, como su índice btree lleva
    // `user_id` de primera columna, TAMBIÉN sirve la lectura por estudiante —
    // por eso no hay un índice adicional por `user_id`.
    unique("lesson_evidence_user_lesson_key").on(row.userId, row.lessonNodeId),
    // El dato de abandono por lección: `WHERE lesson_node_id = $1 GROUP BY status`.
    index("lesson_evidence_lesson_status_idx").on(row.lessonNodeId, row.status),
    // "Todo lo guardado es https" pasa a ser estructural y no solo del DTO.
    // Importa el día que la página pública del portafolio renderice estas filas
    // entre usuarios: React escapa nodos de texto, no `href` (§8.3).
    check("lesson_evidence_url_https_check", sql`${row.url} LIKE 'https://%'`),
  ]
);

// Las emisiones en directo (PRD-008). La tabla es una PROYECCIÓN de
// `curriculum/<slug>.seasons.json`, igual que `curriculum_nodes` lo es del
// archivo de currículo: el único escritor en el entorno desplegado es
// `scripts/load-seasons.ts`.
//
// `id` lo aporta el archivo y ES la identidad de la emisión: sobrevive a
// recargas y a correcciones de fecha. La temporada es una ETIQUETA, no una
// tabla (D2): nadie pide su nombre, y "cuál es la vigente" se deriva de las
// fechas.
export const broadcasts = pgTable(
  "broadcasts",
  {
    id: uuid("id").primaryKey(),
    // AVISO: no hay aislamiento entre currículos, igual que en
    // `curriculum_nodes`. Sale de CURRICULUM_SLUG y NUNCA del request.
    curriculum: text("curriculum").notNull(),
    // Etiqueta de temporada ("2026-t1"). Va contra `SLUG_PATTERN` en el archivo:
    // participa en la clave única y en el agrupado de la tabla de la home, así
    // que no puede ser texto libre.
    season: text("season").notNull(),
    // SIN clave foránea a `curriculum_nodes`, a propósito (§6.3 / D3). NO lo
    // "arregles": una clase emitida es un hecho histórico. Con clave, retirar
    // una lección del temario o bien se llevaría en cascada la fecha y la
    // grabación de una clase que SÍ ocurrió, o bien abortaría la transacción
    // del cargador. Sin ella el nodo puede morir y la emisión sobrevive; la
    // fila de la agenda degrada a título vacío. La integridad se comprueba EN
    // LA ESCRITURA, donde además cubre el `kind`: el cargador resuelve
    // `lessonSlug → nodo` y rechaza el archivo entero si alguno no existe o no
    // es `kind: "lesson"`.
    lessonNodeId: uuid("lesson_node_id").notNull(),
    // `withTimezone` Y `mode: "date"`, las DOS (§6.2). `pg-types` registra el
    // mismo parser para los dos OID y, para una cadena sin desfase, construye
    // el `Date` con los componentes LOCALES del proceso: la misma fila daría
    // tres instantes distintos bajo TZ=UTC, America/Bogota y Asia/Tokyo. La
    // hora de Colombia no se guarda — es una propiedad del render.
    startsAt: timestamp("starts_at", { withTimezone: true, mode: "date" }).notNull(),
    vodUrl: text("vod_url"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (row) => [
    // Nombre estable a propósito, como en `curriculum_nodes`: es la llave que
    // nombran el cargador y sus mensajes.
    //
    // `starts_at` ENTRA EN LA CLAVE (§6.1). Sin él una lección solo podría
    // emitirse una vez por temporada, lo que prohíbe una clase de recuperación
    // o una cohorte partida que recibe L1 dos veces — casos ordinarios en una
    // escuela con directos. Lo que la clave sigue cazando es el error real: la
    // misma emisión duplicada por copia y pega.
    unique("broadcasts_season_lesson_starts_key").on(
      row.curriculum,
      row.season,
      row.lessonNodeId,
      row.startsAt
    ),
    // El orden que la home consulta.
    index("broadcasts_curriculum_starts_idx").on(row.curriculum, row.startsAt),
    // Acota el ESQUEMA, no el host: `LIKE` distingue mayúsculas, así que cierra
    // `javascript:` y `data:` en la base y es fail-closed. El HOST lo acota
    // `checkUrlSafety` y SOLO él (§8) — `https://youtube.com@evil.example.com/`
    // pasa este CHECK y muere en la allowlist.
    check(
      "broadcasts_vod_url_https_check",
      sql`${row.vodUrl} IS NULL OR ${row.vodUrl} LIKE 'https://%'`
    ),
  ]
);

// ---------------------------------------------------------------------------
// Tipos inferidos (cómodos para los agentes de auth y persistencia)
// ---------------------------------------------------------------------------

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Subscription = typeof subscriptions.$inferSelect;
export type NewSubscription = typeof subscriptions.$inferInsert;
export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
export type Registration = typeof registrations.$inferSelect;
export type NewRegistration = typeof registrations.$inferInsert;
export type CurriculumNodeRow = typeof curriculumNodes.$inferSelect;
export type NewCurriculumNodeRow = typeof curriculumNodes.$inferInsert;
export type LessonEvidenceRow = typeof lessonEvidence.$inferSelect;
export type NewLessonEvidenceRow = typeof lessonEvidence.$inferInsert;
export type BroadcastRow = typeof broadcasts.$inferSelect;
export type NewBroadcastRow = typeof broadcasts.$inferInsert;
