// Pantalla de inicio de sesión: el estudiante escribe su correo y recibe un
// magic link (enlace mágico) para entrar. Sin contraseñas.
//
// Es un Server Component: el formulario dispara una Server Action que llama a
// `signIn("resend", ...)`. Tras enviar el correo mostramos el aviso de "revisa
// tu bandeja" leyendo el query param `?enviado=1`.
//
// Regla de código: identificadores en inglés, comentarios en español;
// texto de UI en español.

import { redirect } from "next/navigation";
import { signIn } from "@/auth";

// Server Action: envía el magic link y vuelve a /signin con el aviso de
// "te enviamos un enlace". Va fuera del componente para no recrearla en cada
// render.
async function pedirEnlace(formData: FormData) {
  "use server";
  const email = String(formData.get("email") ?? "").trim();
  if (!email) return;
  // `redirect: false` evita que Auth.js nos lleve a su página por defecto de
  // "verifica tu correo"; mostramos nuestro propio aviso. `redirectTo` es a
  // dónde vuelve el estudiante tras hacer clic en el enlace del correo.
  await signIn("resend", { email, redirectTo: "/", redirect: false });
  // Volvemos a /signin marcando que el enlace ya salió.
  redirect("/signin?enviado=1");
}

export default async function SigninPage({
  searchParams,
}: {
  searchParams: Promise<{ enviado?: string }>;
}) {
  const params = await searchParams;
  const linkEnviado = params.enviado === "1";

  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1.5rem",
      }}
    >
      <div style={{ width: "100%", maxWidth: "26rem" }}>
        <h1 style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>
          Entra a tu tutor
        </h1>
        <p style={{ color: "#555", marginBottom: "1.5rem" }}>
          Escribe tu correo y te enviamos un enlace para entrar. Sin
          contraseñas.
        </p>

        {linkEnviado ? (
          <div
            role="status"
            style={{
              padding: "1rem",
              borderRadius: "0.5rem",
              background: "#eef7ee",
              border: "1px solid #cae6ca",
              color: "#1f5132",
            }}
          >
            Te enviamos un enlace a tu correo. Ábrelo desde este dispositivo
            para entrar. Revisa también la carpeta de spam.
          </div>
        ) : (
          <form
            action={pedirEnlace}
            style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
          >
            <label htmlFor="email" style={{ fontWeight: 600 }}>
              Correo electrónico
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              placeholder="tu@correo.com"
              style={{
                padding: "0.75rem",
                borderRadius: "0.5rem",
                border: "1px solid #ccc",
                fontSize: "1rem",
              }}
            />
            <button
              type="submit"
              style={{
                padding: "0.75rem",
                borderRadius: "0.5rem",
                border: "none",
                background: "#111",
                color: "#fff",
                fontSize: "1rem",
                cursor: "pointer",
              }}
            >
              Enviar enlace
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
