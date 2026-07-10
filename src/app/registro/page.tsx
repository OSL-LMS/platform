"use client";

import { useActionState } from "react";
import { register, type RegisterResult } from "./actions";
import { LESSONS } from "@/lib/lessons";

// Página pública de registro (parte ancha del embudo): captura correo + lección
// para avisos de clase. Excluida del middleware de auth (es pública).
//
// Regla de código: identificadores en inglés; texto de UI en español.
export default function RegistroPage() {
  const [result, formAction, pending] = useActionState<RegisterResult | null, FormData>(
    register,
    null
  );

  if (result?.ok) {
    return (
      <main className="registro">
        <h1>¡Estás dentro! 🎉</h1>
        <p className="registro__lead">{result.message}</p>
      </main>
    );
  }

  return (
    <main className="registro">
      <h1>Aprende a programar, en directo y gratis</h1>
      <p className="registro__lead">
        Déjame tu correo y te aviso de cada clase. Sin costo: las clases, las
        grabaciones y la comunidad son gratis.
      </p>

      <form className="registro__form" action={formAction}>
        <label>
          Tu correo
          <input
            type="email"
            name="email"
            placeholder="tu@correo.com"
            autoComplete="email"
            required
            autoFocus
          />
        </label>

        <label>
          Tu nombre <span className="registro__opt">(opcional)</span>
          <input
            type="text"
            name="name"
            placeholder="¿Cómo te llamas?"
            autoComplete="given-name"
          />
        </label>

        <label>
          ¿En qué lección vas? <span className="registro__opt">(si ya empezaste)</span>
          <select name="lesson" defaultValue="L1">
            {LESSONS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.id} — {l.title}
              </option>
            ))}
          </select>
        </label>

        {result && !result.ok && (
          <p className="registro__error" role="alert">
            {result.message}
          </p>
        )}

        <button type="submit" disabled={pending}>
          {pending ? "Registrando…" : "Avísame de las clases"}
        </button>
      </form>
    </main>
  );
}
