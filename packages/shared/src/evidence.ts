// Tipos de dominio de la evidencia por lección (PRD-007 §6.1 y §5.2).
//
// Este módulo es PURO y SIN IMPORTS a propósito. Lo consumen tres sitios que no
// pueden depender de lo mismo: `schema.ts` (que sí conoce Drizzle), el parser
// del currículo `curriculum-file.ts` (que NO puede conocer la base de datos —
// es lo que permite correr el contrato entero sobre un PR sin Postgres) y las
// dos apps. Si este archivo importara el esquema, `curriculum-file.ts` pasaría
// a arrastrar Drizzle por la puerta de atrás.
//
// Importa con ruta relativa y extensión: Node no conoce los `paths` de tsconfig
// y estos módulos se importan desde `scripts/`.
//
// Regla de código: identificadores en inglés, comentarios en español.

/**
 * Los tres estados de una fila de `lesson_evidence`. La tupla es la FUENTE:
 * `schema.ts` se la pasa a `pgEnum`, de modo que el tipo de Postgres y el de
 * TypeScript no pueden divergir. El goal 2 de PRD-007 es que la distinción
 * entre declarado y verificado sobreviva a una consulta SQL de un tercero, y
 * eso exige que viva en el esquema, no en la interpretación.
 */
export const EVIDENCE_STATUSES = ["declared", "verified", "failed"] as const;

export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

/**
 * Qué comprobación admite una lección. Hoy solo `url`: PRD-007 §3 deja fuera la
 * verificación de contenido, así que un `repo` no existe todavía y tiene que
 * fallar EN EL ARCHIVO —por el `enum` del vocabulario de §6.4— en vez de
 * degradar en silencio en producción.
 */
export const EVIDENCE_KINDS = ["url"] as const;

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** El `payload` que llega de Postgres es `Record<string, unknown>`: lo escribió
 *  el cargador tras validar, pero el tipo no lo sabe. Se estrecha en vez de
 *  afirmarlo con `as`, para que un valor fuera del vocabulario se lea como
 *  "esta lección no pide evidencia" y no pinte un panel de un tipo que no
 *  existe (§4.3, primera fila). */
export function isEvidenceKind(value: unknown): value is EvidenceKind {
  return (
    typeof value === "string" &&
    (EVIDENCE_KINDS as readonly string[]).includes(value)
  );
}

/**
 * Lista cerrada de razones de fallo (PRD-007 §4.2). Es un CÓDIGO, nunca prosa
 * del destino: lo que traen los errores de red es el hostname o la IP resuelta
 * —`getaddrinfo ENOTFOUND …`, `connect ECONNREFUSED 10.0.0.5:443`— y §8.5
 * prohíbe que eso salga del verificador, ni a un log ni a una analítica.
 */
export type EvidenceFailureReason =
  | `http_${number}`
  | "too_many_redirects"
  | "malformed_redirect"
  | "insecure_redirect"
  | "blocked_address"
  | "network"
  | "dns"
  | "timeout";

/**
 * Una entrega tal como viaja al cliente (PRD-007 §5.2). `lessonNodeId` NO
 * aparece: al leer se resuelve a `lessonSlug`, y una fila cuyo nodo ya no
 * exista en el currículo se OMITE de la respuesta sin borrarse (§6.3).
 *
 * `checkedAt` es el literal ISO, no un `Date`: es lo que sale por HTTP.
 */
export type EvidenceItem = {
  lessonSlug: string;
  url: string;
  status: EvidenceStatus;
  checkedAt: string | null;
  failureReason: EvidenceFailureReason | null;
};
