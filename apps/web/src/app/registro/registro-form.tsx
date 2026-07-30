"use client";

import { useActionState } from "react";
import { useSearchParams } from "next/navigation";
import { register, type RegisterResult } from "./actions";
import type { LessonOption } from "@shared/curriculum";

// El formulario de registro, extraído a componente cliente: la página pasó a
// Server Component para poder leer el currículo de la base de datos (PRD-002
// §7). Recibe solo `{slug, title}` — `/registro` es pública y sin login, y
// `payload.stuck` no tiene por qué serializarse hasta aquí.
//
// Regla de código: identificadores en inglés; texto de UI en español.
// useSearchParams exige un límite de Suspense; lo pone la página.
export default function RegistroForm({ lessons = [] }: { lessons?: LessonOption[] }) {
  // ¿De qué sección de la home vino este registro? (atribución del embudo)
  const src = useSearchParams().get("src");
  const [result, formAction, pending] = useActionState<RegisterResult | null, FormData>(
    register,
    null
  );

  if (result?.ok) {
    return (
      <main className="registro">
        <h1>¡Estás dentro! 🎉</h1>
        <p className="registro__lead">{result.message}</p>
        <p className="registro__lead">
          Y cuando quieras probar el tutor, <a href="/signin">entra con este
          mismo correo</a> — la prueba de 7 días empieza con tu primer mensaje,
          no antes.
        </p>
      </main>
    );
  }

  return (
    <main className="registro">
      <h1>Aprende a programar, en directo y gratis</h1>
      <p className="registro__lead">
        Déjame tu correo y te aviso de cada clase. Sin costo: las clases, las
        grabaciones y la comunidad son gratis. Esto no crea ninguna cuenta ni
        gasta tu prueba del tutor — es solo la lista de avisos.
      </p>

      <form className="registro__form" action={formAction}>
        <input type="hidden" name="src" value={src ?? ""} />
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
          {/* La selección inicial sale del currículo, no del literal "L1" que
              estaba escrito a mano: el `slug` es mutable. */}
          <select
            name="lesson"
            defaultValue={lessons[0]?.slug ?? ""}
            disabled={lessons.length === 0}
          >
            {lessons.map((l) => (
              <option key={l.slug} value={l.slug}>
                {l.slug} — {l.title}
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
