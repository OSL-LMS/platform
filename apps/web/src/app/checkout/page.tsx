"use client";

import { useEffect } from "react";
import { initializePaddle } from "@paddle/paddle-js";

// Página pública del "default payment link" de Paddle. Paddle le añade
// `?_ptxn=<txn>` a esta URL en sus flujos hospedados (emails de actualización de
// método de pago, dunning de impagos, portal del cliente) y Paddle.js abre el
// checkout automáticamente al detectar `_ptxn` — solo hace falta inicializarlo.
// No está en el matcher del middleware, así que es pública (Paddle debe poder
// cargarla sin login).
//
// Regla de código: identificadores en inglés; texto de UI en español.
export default function CheckoutPage() {
  useEffect(() => {
    const token = process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN;
    if (!token) return;
    const environment =
      process.env.NEXT_PUBLIC_PADDLE_ENV === "production" ? "production" : "sandbox";
    initializePaddle({ environment, token });
  }, []);

  return (
    <main style={{ maxWidth: 480, margin: "20vh auto", textAlign: "center", padding: "0 1rem" }}>
      <p>Abriendo el pago seguro…</p>
      <p>
        Si no se abre solo, vuelve a <a href="/chat">tu tutor</a> e inténtalo de
        nuevo.
      </p>
    </main>
  );
}
