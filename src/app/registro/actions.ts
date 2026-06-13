"use server";

import { db } from "@/lib/db";
import { registrations } from "@/lib/schema";
import { Resend } from "resend";

// Resultado que la server action devuelve al formulario (useActionState).
export type RegisterResult = { ok: boolean; message: string };

// Captura un registro en NUESTRA lista (Postgres) y manda un correo de
// bienvenida best-effort. El registro es el activo; el correo es secundario.
//
// Regla de código: identificadores en inglés; texto de UI en español.
export async function register(
  _prev: RegisterResult | null,
  formData: FormData
): Promise<RegisterResult> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const name = String(formData.get("name") ?? "").trim() || null;
  const currentLesson = String(formData.get("lesson") ?? "").trim() || null;

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { ok: false, message: "Pon un correo válido para avisarte de las clases." };
  }

  try {
    // onConflictDoNothing: si ya estaba registrado, no es un error para el usuario.
    await db
      .insert(registrations)
      .values({ email, name, currentLesson, source: "web" })
      .onConflictDoNothing({ target: registrations.email });
  } catch {
    return { ok: false, message: "Algo falló al registrarte. Reintenta en un momento." };
  }

  // Correo de bienvenida (best-effort): si falla, el registro ya quedó guardado.
  try {
    const apiKey = process.env.AUTH_RESEND_KEY ?? process.env.RESEND_API_KEY;
    if (apiKey) {
      const resend = new Resend(apiKey);
      await resend.emails.send({
        from: "tutor@angelkurten.com",
        to: email,
        subject: "¡Estás dentro! Pronto empezamos",
        text:
          "Gracias por registrarte.\n\n" +
          "Te avisaré de cada clase en vivo. En ellas vas a publicar tu primera " +
          "página web, aprender a leer y escribir código, y dar tus primeros pasos " +
          "como developer — todo gratis, en directo.\n\n" +
          "Nos vemos pronto.",
      });
    }
  } catch {
    // Best-effort: ignorar fallo de envío.
  }

  return {
    ok: true,
    message: "¡Listo, estás registrado! Te avisaré de cada clase. Revisa tu correo (y el spam, por si acaso).",
  };
}
