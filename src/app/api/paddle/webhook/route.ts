// Webhook de Paddle: recibe eventos de suscripción y actualiza la tabla
// `subscriptions`. Verifica la firma con el SDK oficial.
//
// IMPORTANTE: hay que leer el body CRUDO con req.text() (no req.json()), o la
// verificación de firma falla.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { Paddle, Environment, EventName } from "@paddle/paddle-node-sdk";
import { setSubscriptionStatus } from "@/lib/access";
import { track } from "@/lib/analytics";

const paddle = new Paddle(process.env.PADDLE_API_KEY ?? "", {
  environment:
    process.env.PADDLE_ENV === "production"
      ? Environment.production
      : Environment.sandbox,
});

// Extrae el correo de la app que enviamos como customData en el checkout. Es la
// llave para enlazar la suscripción de Paddle con nuestra fila de subscriptions.
function emailFromCustomData(data: unknown): string | null {
  const cd = (data as { customData?: Record<string, unknown> } | null)?.customData;
  const email = cd?.email;
  return typeof email === "string" ? email.toLowerCase() : null;
}

export async function POST(req: Request) {
  const signature = req.headers.get("paddle-signature") ?? "";
  const secret = process.env.PADDLE_WEBHOOK_SECRET ?? "";
  const body = await req.text(); // body crudo — NO usar req.json()

  let event;
  try {
    event = await paddle.webhooks.unmarshal(body, secret, signature);
  } catch {
    return new Response("firma inválida", { status: 400 });
  }
  if (!event) {
    return new Response("sin evento", { status: 400 });
  }

  // PRD-003 §10 paso 4: por defecto encendido (cualquier valor salvo
  // "false") — cero cambio de comportamiento hasta que el operador lo apague
  // explícitamente al activar el segundo destino de Paddle hacia apps/api.
  const paddleTrackEnabled = process.env.PADDLE_TRACK_ENABLED !== "false";

  try {
    switch (event.eventType) {
      case EventName.SubscriptionCreated:
      case EventName.SubscriptionActivated:
      case EventName.SubscriptionUpdated: {
        const data = event.data as { id?: string; status?: string };
        const email = emailFromCustomData(event.data);
        const canceled = data.status === "canceled";
        if (email) {
          await setSubscriptionStatus(
            email,
            canceled ? "canceled" : "active",
            data.id
          );

          // Cierre del embudo. El evento sale del webhook y no del navegador
          // porque el pago solo es real cuando Paddle lo confirma aquí.
          // PRD-003 §10 paso 4: detrás de PADDLE_TRACK_ENABLED (por defecto
          // encendido) para poder silenciar Next sin desplegar código cuando
          // apps/api reciba su propio destino de Paddle — así no se duplica
          // el evento en el embudo mientras conviven los dos webhooks.
          if (paddleTrackEnabled) {
            track(
              email,
              canceled ? "subscription_canceled" : "subscription_activated",
              { paddle_event: event.eventType }
            );
          }
        }
        break;
      }

      case EventName.SubscriptionCanceled: {
        const email = emailFromCustomData(event.data);
        if (email) {
          await setSubscriptionStatus(email, "canceled");

          if (paddleTrackEnabled) {
            track(email, "subscription_canceled", {
              paddle_event: event.eventType,
            });
          }
        }
        break;
      }
    }
  } catch (err) {
    // Error no transitorio nuestro: devolvemos 200 igual para que Paddle no
    // reintente en bucle; lo registramos para revisarlo.
    console.error("Error procesando webhook de Paddle:", err);
  }

  return new Response("ok", { status: 200 });
}
