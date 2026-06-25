// Script de dev: muestra el estado de suscripción de un correo.
// Uso: DATABASE_URL=... node scripts/check-sub.mjs correo@ejemplo.com
import { Pool } from "pg";

const email = process.argv[2];
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const res = await pool.query(
  "SELECT email, status, trial_ends_at, paddle_subscription_id, updated_at FROM subscriptions WHERE email = $1",
  [email]
);
console.log(JSON.stringify(res.rows[0] ?? null, null, 2));
await pool.end();
