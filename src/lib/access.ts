// Frontera gratis/pago: el trial de 7 días arranca con el PRIMER MENSAJE al
// tutor, no al hacer login — entrar a curiosear no gasta la prueba.
// Diseño: bóveda `30 Producto/Frontera gratis-pago.md` y
// `60 Negocio/Home post-lanzamiento.md` (decisión del 16 jul 2026).
//
// Regla de código: identificadores en inglés, comentarios en español.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { subscriptions } from "@/lib/schema";
import { track } from "@/lib/analytics";

const TRIAL_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export type Access = {
  allowed: boolean;
  // "none": aún sin trial (no ha escrito al tutor). Puede ver el chat;
  // su primer mensaje arranca la prueba (ensureTrial en /api/chat).
  status: "none" | "trial" | "active" | "canceled";
  trialDaysLeft: number | null; // días restantes de trial; null si no aplica
};

function evaluate(sub: typeof subscriptions.$inferSelect): Access {
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
  return { allowed: false, status: sub.status as Access["status"], trialDaysLeft: 0 };
}

// Solo LEE el acceso del estudiante; nunca crea el trial. Sin fila en
// `subscriptions` el estudiante puede ver el chat ("none"): lo que se cobra es
// hablar con el tutor, y eso pasa por ensureTrial.
export async function getAccess(email: string): Promise<Access> {
  const existing = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.email, email))
    .limit(1);

  const sub = existing[0];
  if (!sub) {
    return { allowed: true, status: "none", trialDaysLeft: null };
  }
  return evaluate(sub);
}

// Crea el trial si no existe (7 días, sin tarjeta) y devuelve el acceso.
// Se llama SOLO desde /api/chat, al primer mensaje real al tutor.
export async function ensureTrial(email: string): Promise<Access> {
  const existing = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.email, email))
    .limit(1);

  let sub = existing[0];

  if (!sub) {
    const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * DAY_MS);
    const inserted = await db
      .insert(subscriptions)
      .values({ email, status: "trial", trialEndsAt })
      .onConflictDoNothing({ target: subscriptions.email })
      .returning();
    sub = inserted[0];

    // Solo cuando ESTE request creó la fila. Si el insert chocó con la carrera
    // de abajo, el evento ya lo emitió el request que ganó: un trial, un evento.
    if (sub) {
      track(email, "trial_started", { trial_days: TRIAL_DAYS });
    }

    // Carrera improbable (dos primeros mensajes a la vez): si el insert chocó
    // por el unique de email, releemos la fila ya creada.
    if (!sub) {
      const reread = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.email, email))
        .limit(1);
      sub = reread[0];
    }
  }

  return evaluate(sub);
}
