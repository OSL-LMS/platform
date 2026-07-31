// Proxy de la evidencia por lección hacia apps/api (PRD-007 §5.3).
//
// Mismo patrón que src/app/api/chat/route.ts y por las mismas razones: `auth()`
// PRIMERO —para no gastar un salto de red en una petición que no puede
// prosperar—, luego `readSessionToken()`, y reenvío con `Authorization: Bearer`
// CONSTRUYENDO las cabeceras.
//
// LA COOKIE DE SESIÓN NO SALE DE ESTE PROCESO: lo que viaja es el Bearer. La
// cabecera Cookie no se reenvía (§5.3) — tendría precedencia sobre el Bearer
// dentro de getToken() y abriría un segundo canal de credencial no declarado—,
// ni el X-Forwarded-For del cliente hacia un servicio con `trust proxy` puesto.
// El conjunto saliente lo fija `api-client.ts` y no se compone aquí.
//
// LO QUE ESTE FICHERO NO HACE: no valida la URL, no resuelve DNS y no abre
// ninguna conexión al destino del estudiante. Todo eso es dominio y vive en
// apps/api desde ADR-001; aquí quedan cookie, Bearer y bytes.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { auth } from "@/auth";
import {
  EVIDENCE_BRIDGE_TIMEOUT_MS,
  fetchEvidence,
  readSessionToken,
  resolveClientConfig,
  submitEvidence,
} from "@/lib/api-client";

const UNAUTHORIZED = { error: "Unauthorized" };
const UNAVAILABLE = { error: "Evidence service unavailable" };

/** Sesión + token, o la respuesta 401 que corresponde. Las dos ramas de 401 son
 *  las mismas que en /api/chat: sin sesión, y cookie ausente, troceada o con
 *  nombre distinto al configurado. */
async function resolveBearer(): Promise<string | Response> {
  const session = await auth();
  if (!session?.user?.id || !session.user.email) {
    return Response.json(UNAUTHORIZED, { status: 401 });
  }

  const token = await readSessionToken();
  if (typeof token !== "string") {
    return Response.json(UNAUTHORIZED, { status: 401 });
  }

  return token;
}

export async function POST(req: Request) {
  const bearer = await resolveBearer();
  if (typeof bearer !== "string") return bearer;

  const config = resolveClientConfig();

  // El cuerpo se lee como texto y se reenvía tal cual: la validación de forma
  // es de `evidence.dto.ts` (§5.1). Está acotado por la cota global de 64 kb de
  // `bootstrap.ts` en el otro lado y por `@MaxLength(2048)` sobre `url`.
  const body = await req.text();

  const result = await submitEvidence(
    bearer,
    body,
    config.apiBaseUrl,
    EVIDENCE_BRIDGE_TIMEOUT_MS
  );

  if ("error" in result) {
    // §4.2, última fila: apps/api no respondió (o respondió algo que la regla
    // positiva de §5.3 no acepta). 503, el panel muestra que no se pudo
    // guardar, y EL CHAT SIGUE FUNCIONANDO — la entrega nunca bloquea el avance.
    return Response.json(UNAVAILABLE, { status: 503 });
  }

  // Un `status: "failed"` viaja por aquí con 200: es un estado de la fila, no un
  // error de la petición (goal 4).
  return Response.json(result, { status: 200, headers: { "Cache-Control": "no-store" } });
}

export async function GET() {
  const bearer = await resolveBearer();
  if (typeof bearer !== "string") return bearer;

  const config = resolveClientConfig();

  const result = await fetchEvidence(
    bearer,
    config.apiBaseUrl,
    EVIDENCE_BRIDGE_TIMEOUT_MS
  );

  if ("error" in result) {
    // §4.3: el panel se pinta igual, en estado "sin entrega" y con una línea que
    // dice que no se pudo leer el estado anterior. Nunca bloquea la entrega.
    return Response.json(UNAVAILABLE, { status: 503 });
  }

  return Response.json(result, { status: 200, headers: { "Cache-Control": "no-store" } });
}
