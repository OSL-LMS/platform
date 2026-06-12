// Cliente de Drizzle ORM sobre un Pool de `pg`, contra la Postgres de Railway.
//
// `DATABASE_URL` la inyecta el plugin de PostgreSQL de Railway como variable de
// entorno del servicio. En local, ponla en .env.local.
//
// Nota de build: usamos una cadena de respaldo cuando DATABASE_URL no está
// presente (p. ej. durante `next build`). El Pool de `pg` NO conecta hasta la
// primera consulta, así que esto no abre conexiones en build; solo evita que el
// módulo lance al cargarse (y permite que el Drizzle adapter de Auth.js inspeccione
// una instancia real de drizzle para detectar el dialecto). En Railway y en local
// la variable real siempre está definida en tiempo de request.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

const connectionString =
  process.env.DATABASE_URL ??
  "postgres://placeholder:placeholder@localhost:5432/placeholder";

// Un único Pool reutilizado por el servidor Node de larga vida (next start).
const pool = new Pool({ connectionString });

// Cliente Drizzle con el esquema cargado (habilita la API relacional `db.query`).
export const db = drizzle(pool, { schema });
