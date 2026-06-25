// Script de prueba: vence el trial de un correo para forzar el paywall y poder
// probar el checkout de Paddle. NO es parte de la app; es una utilidad de dev.
//
// Uso: DATABASE_URL=... node scripts/expire-trial.mjs correo@ejemplo.com
//
// Regla de código: identificadores en inglés, comentarios en español.

import { Pool } from "pg";

const email = process.argv[2];
if (!email) {
  console.error("Falta el correo. Uso: node scripts/expire-trial.mjs correo@ejemplo.com");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const res = await pool.query(
  "UPDATE subscriptions SET trial_ends_at = now() - interval '1 day', updated_at = now() WHERE email = $1",
  [email]
);
console.log(`Filas actualizadas para ${email}: ${res.rowCount}`);
await pool.end();
