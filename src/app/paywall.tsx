"use client";

import { logout } from "./actions";

// Pantalla de pago: se muestra cuando el trial venció o la suscripción está
// cancelada. El checkout de Paddle se cablea cuando exista la cuenta de Paddle
// (micro-paso 4); por ahora el botón muestra un aviso.
//
// Regla de código: identificadores en inglés; texto de UI en español.
export default function Paywall({
  status,
}: {
  status: "trial" | "canceled";
}) {
  const heading = status === "canceled" ? "Tu suscripción terminó" : "Tu prueba terminó";

  return (
    <main className="paywall">
      <h1>{heading}</h1>
      <p>
        Durante 7 días tuviste a tu tutor disponible a cualquier hora. Para
        seguir desatascándote —sin que te demos la respuesta— suscríbete y
        asegura el <strong>precio fundador</strong> para siempre.
      </p>

      <button
        className="paywall__cta"
        onClick={() => {
          // TODO(micro-paso 4): abrir el checkout de Paddle aquí.
          alert("El pago estará disponible muy pronto. ¡Gracias por tu paciencia!");
        }}
      >
        Suscribirme — precio fundador
      </button>

      <p className="paywall__note">
        Mientras tanto, las clases, las grabaciones y la comunidad del Discord
        siguen siendo gratis.
      </p>

      <form action={logout}>
        <button type="submit" className="paywall__logout">
          Salir
        </button>
      </form>
    </main>
  );
}
