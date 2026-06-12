// Configuración de drizzle-kit: genera y aplica migraciones contra Postgres.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/lib/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    // La URL la inyecta Railway (o .env.local en desarrollo).
    url: process.env.DATABASE_URL!,
  },
  // Pone un prefijo de timestamp a los archivos de migración (orden estable).
  migrations: {
    prefix: "timestamp",
  },
  verbose: true,
  strict: true,
});
