"use client";

// Red de seguridad de /chat (PRD-003 §5.3): defensa en profundidad deliberada,
// NO el manejador de la política de degradación. El contrato de
// src/lib/api-client.ts dice que fetchAccess()/fetchAccessTrial() nunca
// lanzan, así que este componente no tiene disparador declarado por esa vía.
// Existe porque hoy no hay NINGÚN error.tsx en src/app, y un throw inesperado
// en el render de /chat —la página que da acceso al producto de pago— caería
// en la pantalla de crash por defecto de Next. El disparador real y
// deliberado es la cookie de sesión troceada (api-client.ts,
// resolveSessionCookie(), §9 fila 35a): un caso raro pero intencional.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { useEffect } from "react";

export default function ChatError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Error inesperado en /chat:", error);
  }, [error]);

  return (
    <main className="chat-error">
      <h1>Algo falló</h1>
      <p>
        Tuvimos un problema cargando el chat. Recarga la página; si el
        problema sigue, vuelve a intentarlo en un momento.
      </p>
      <button onClick={() => reset()}>Reintentar</button>
    </main>
  );
}
