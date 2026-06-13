// Frontera gratis/pago: arranca el trial de 7 días en el primer acceso y evalúa
// si el estudiante puede usar el tutor (trial vigente o suscripción activa).
// Diseño: bóveda `30 Producto/Frontera gratis-pago.md`.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { subscriptions } from "@/lib/schema";

const TRIAL_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export type Access = {
  allowed: boolean;
  status: "trial" | "active" | "canceled";
  trialDaysLeft: number | null; // días restantes de trial; null si no aplica
};

// Devuelve el acceso del estudiante al tutor, creando el trial si es su primer
// acceso (7 días, sin tarjeta). La tabla `subscriptions` está keyed por email.
export async function getAccess(email: string): Promise<Access> {
  const existing = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.email, email))
    .limit(1);

  let sub = existing[0];

  if (!sub) {
    // Primer acceso: trial automático de 7 días.
    const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * DAY_MS);
    const inserted = await db
      .insert(subscriptions)
      .values({ email, status: "trial", trialEndsAt })
      .onConflictDoNothing({ target: subscriptions.email })
      .returning();
    sub = inserted[0];

    // Carrera improbable (dos requests del primer login a la vez): si el insert
    // chocó por el unique de email, releemos la fila ya creada.
    if (!sub) {
      const reread = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.email, email))
        .limit(1);
      sub = reread[0];
    }
  }

  if (sub.status === "active") {
    return { allowed: true, status: "active", trialDaysLeft: null };
  }

  if (
    sub.status === "trial" &&
    sub.trialEndsAt &&
    sub.trialEndsAt.getTime() > Date.now()
  ) {
    const trialDaysLeft = Math.ceil(
      (sub.trialEndsAt.getTime() - Date.now()) / DAY_MS
    );
    return { allowed: true, status: "trial", trialDaysLeft };
  }

  // Trial vencido o suscripción cancelada → sin acceso al tutor.
  return { allowed: false, status: sub.status, trialDaysLeft: 0 };
}
