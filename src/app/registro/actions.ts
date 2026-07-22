"use server";

import { db } from "@/lib/db";
import { registrations } from "@/lib/schema";
import { track } from "@/lib/analytics";
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

  // Boca del embudo. Se emite también si el correo ya estaba registrado
  // (onConflictDoNothing): PostHog deduplica por distinct_id en el embudo, y un
  // reintento del formulario es señal útil, no ruido.
  track(email, "registered", { source: "web", lesson: currentLesson });

  // Correo de bienvenida (best-effort): si falla, el registro ya quedó guardado.
  try {
    const apiKey = process.env.AUTH_RESEND_KEY ?? process.env.RESEND_API_KEY;
    if (apiKey) {
      const resend = new Resend(apiKey);
      await resend.emails.send({
        from: "tutor@angelkurten.com",
        to: email,
        subject: "¡Estás dentro! Empieza hoy con la clase 1",
        text:
          "Gracias por registrarte. La escuela ya está en marcha y puedes " +
          "empezar hoy mismo:\n\n" +
          "La clase 1, grabada:\n" +
          "  https://www.youtube.com/watch?v=T6g1Ynm8r3c\n\n" +
          "El Discord de la comunidad (comparte tu página y pregunta lo que sea):\n" +
          "  https://discord.gg/dmyrdCWR8a\n\n" +
          "Las clases en vivo son martes y jueves a las 20:00, hora de Colombia, " +
          "en https://twitch.tv/angelkurten — y todas quedan grabadas, así que " +
          "entras cuando quieras.\n\n" +
          "Te avisaré de cada clase. Nos vemos en el directo.",
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
