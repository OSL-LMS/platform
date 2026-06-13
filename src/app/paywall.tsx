"use client";

import { useEffect, useState } from "react";
import { initializePaddle, type Paddle } from "@paddle/paddle-js";
import { logout } from "./actions";

// Pantalla de pago: se muestra cuando el trial venció o la suscripción está
// cancelada. Abre el checkout de Paddle. Necesita estas env vars (NEXT_PUBLIC,
// inlined en build): NEXT_PUBLIC_PADDLE_CLIENT_TOKEN, NEXT_PUBLIC_PADDLE_PRICE_ID,
// NEXT_PUBLIC_PADDLE_ENV (sandbox|production).
//
// Regla de código: identificadores en inglés; texto de UI en español.
export default function Paywall({
  status,
  email,
}: {
  status: "trial" | "canceled";
  email: string;
}) {
  const [paddle, setPaddle] = useState<Paddle>();

  useEffect(() => {
    const token = process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN;
    if (!token) return;
    const environment =
      process.env.NEXT_PUBLIC_PADDLE_ENV === "production" ? "production" : "sandbox";
    initializePaddle({ environment, token }).then((p) => {
      if (p) setPaddle(p);
    });
  }, []);

  function openCheckout() {
    const priceId = process.env.NEXT_PUBLIC_PADDLE_PRICE_ID;
    if (!paddle || !priceId) {
      alert("El pago aún no está disponible. Vuelve en un momento.");
      return;
    }
    paddle.Checkout.open({
      items: [{ priceId, quantity: 1 }],
      customer: { email },
      // customData viaja a la suscripción; el webhook lee `email` para enlazarla.
      customData: { email },
      settings: { displayMode: "overlay", locale: "es" },
    });
  }

  const heading = status === "canceled" ? "Tu suscripción terminó" : "Tu prueba terminó";

  return (
    <main className="paywall">
      <h1>{heading}</h1>
      <p>
        Durante 7 días tuviste a tu tutor disponible a cualquier hora. Para
        seguir desatascándote —sin que te demos la respuesta— suscríbete y
        asegura el <strong>precio fundador</strong> para siempre.
      </p>

      <button className="paywall__cta" onClick={openCheckout}>
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
