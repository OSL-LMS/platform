// Proxy del turno del tutor hacia apps/api (PRD-005 §5.3).
//
// Desde el paso E de §10 este handler NO tiene implementación local: el turno
// entero —prompt certificado, ventana de contexto, memoria y clave de
// Anthropic— vive en apps/api. Aquí sólo quedan cookie, Bearer y bytes.
//
// LO QUE ESTE FICHERO NO HACE, y es el punto de haberlo vaciado: no toca
// Postgres, no llama a Anthropic, no compone el bloque de system y no conoce el
// hilo. Si algo de eso vuelve a aparecer aquí, la frontera que ADR-001 compró
// se ha vuelto a cruzar.
//
// LA COOKIE DE SESIÓN NO SALE DE ESTE PROCESO: se lee del tarro y lo que viaja
// es el Bearer. La cabecera Cookie no se reenvía (§5.3) — tendría precedencia
// sobre el Bearer dentro de getToken() y abriría un segundo canal de credencial
// no declarado. Es la invariante que el camino directo habría retirado y que
// elegir el proxy conserva.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { auth } from "@/auth";
import {
  readSessionToken,
  resolveClientConfig,
  streamTutorTurn,
} from "@/lib/api-client";

// IMPORT POR EFECTO, y no sobra. `tutor-turn.ts` arma en su ámbito de módulo el
// guarda que impide arrancar este proceso con ANTHROPIC_API_KEY en el entorno
// (§8.3): desde el paso E esa clave pertenece SÓLO a apps/api, y un guarda en
// un módulo que nadie importa probaría que una función lanza, no que el
// arranque falla. `scripts/check-secrets.ts` afirma que este import existe.
import "@/lib/tutor-turn";

export async function POST(req: Request) {
  // Exigimos sesión antes de salir del proceso. apps/api la volvería a exigir
  // —SessionGuard es la única puerta de identidad allí— pero un 401 aquí evita
  // un salto de red para una petición que no puede prosperar.
  const session = await auth();
  if (!session?.user?.id || !session.user.email) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const config = resolveClientConfig();
  const token = await readSessionToken();
  if (typeof token !== "string") {
    // Cookie ausente, troceada o con nombre distinto al configurado: 401 ANTES
    // de salir del proceso. Desde §5.3 la rama troceada degrada aquí en vez de
    // lanzar, que dentro de un handler era un 500 provocable por un tercero
    // (§9 fila 38b).
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // El cuerpo se lee como texto y se reenvía tal cual: la validación de forma es
  // de `turn.dto.ts` (§5.1) y su 400 es exactamente lo que el cliente tiene que
  // ver. Bufferizar el cuerpo ENTRANTE no es lo que §5.3 prohíbe; lo que no
  // puede bufferizarse es la RESPUESTA.
  const body = await req.text();

  const upstream = await streamTutorTurn(token, body, {
    baseUrl: config.apiBaseUrl,
    timeoutMs: config.tutorTimeoutMs,
    clientSignal: req.signal,
  });

  if ("error" in upstream) {
    // apps/api no respondió antes de la primera cabecera, agotó
    // TUTOR_TIMEOUT_MS o devolvió un 3xx. NADA SE PERSISTIÓ: el stream no llegó
    // a abrirse. Un fallo POSTERIOR a las cabeceras no llega aquí y no tiene
    // status — el cuerpo ya empezó a viajar y la conexión se corta.
    return Response.json({ error: "Tutor service unavailable" }, { status: 503 });
  }

  return upstream;
}
