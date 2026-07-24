import { createHash } from "node:crypto";
import { track } from "@/lib/analytics";

// El denominador del embudo: un píxel first-party que cuenta las visitas a las
// páginas públicas SIN cookies y sin identificar a nadie — el distinct_id es un
// hash de IP+UA con sal que rota a diario, así que no persiste ni permite
// seguimiento entre días; por eso no requiere consentimiento (y funciona
// aunque el visitante rechace el banner). Los pageviews con consentimiento
// llegan aparte vía posthog-js; este evento usa otro nombre para no duplicar.
//
// Se eligió píxel sobre middleware a propósito: no cuenta prefetches de Next
// ni peticiones curl, reutiliza analytics.ts (posthog-node, runtime Node) y no
// toca el middleware de auth. Ver `30 Producto/Stack de la app del tutor.md`.
//
// Regla de código: identificadores en inglés, comentarios en español.

const PUBLIC_PATHS = new Set(["/", "/registro", "/precios", "/signin"]);
const BOT_RE = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|headless/i;

// GIF transparente de 1×1, la respuesta de siempre: el píxel nunca falla hacia
// el navegador, pase lo que pase con la telemetría.
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

function gif(): Response {
  return new Response(GIF, {
    headers: {
      "Content-Type": "image/gif",
      // Sin caché: cada carga de página debe volver a pedir el píxel.
      "Cache-Control": "no-store, max-age=0",
    },
  });
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.searchParams.get("p") ?? "";
  const userAgent = req.headers.get("user-agent") ?? "";
  if (!PUBLIC_PATHS.has(path) || BOT_RE.test(userAgent)) return gif();

  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  const day = new Date().toISOString().slice(0, 10);
  const salt = process.env.AUTH_SECRET ?? "";
  const distinctId =
    "anon-" +
    createHash("sha256").update(`${ip}|${userAgent}|${day}|${salt}`).digest("hex").slice(0, 32);

  // El Referer del píxel es la URL completa de la página que lo cargó — ahí
  // viajan las UTM de los posts (la atribución de canal, sin tocar la página).
  const properties: Record<string, unknown> = { path };
  const referer = req.headers.get("referer");
  if (referer) {
    try {
      const refUrl = new URL(referer);
      for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_content"]) {
        const value = refUrl.searchParams.get(key);
        if (value) properties[key] = value;
      }
    } catch {
      // Referer malformado: se cuenta la visita sin UTM.
    }
  }

  track(distinctId, "server_pageview", properties);
  return gif();
}
