// Extractor del correo que viaja en `customData` del checkout. UNO SOLO,
// compartido por el webhook y el reconciliador (PRD-004 §6.2).
//
// Vivía en `billing.controller.ts:52-56`. Se extrae por la misma razón que el
// mapa de estados: es el único guarda de tipo sobre un campo que el NAVEGADOR
// controla en el checkout público (PRD-003 §8), y un segundo extractor
// divergente sería la misma clase de fallo.
//
// DOS FUNCIONES Y NO UNA, Y LA ELECCIÓN ES DELIBERADA. Las dos cotas que §6.2
// pide —descartar lo que no lleve `@` y lo que pase de 254 caracteres— NO van en
// la función compartida, van en un envoltorio del lado del reconciliador:
//
//   - Meterlas en la compartida cambiaría el webhook. Hoy un `customData.email`
//     de `"nope"` escribe una fila con ese valor; con las cotas dentro dejaría
//     de escribirla. Eso es comportamiento observable de una rama que PRD-004 §3
//     declara fuera de alcance, y las filas 5 y 6 de §9 existen para sostener
//     que la extracción no lo mueva.
//   - La asimetría no es descuido, es la que el PRD describe: el webhook escribe
//     UNA vez, ante un evento que Paddle confirmó; el reconciliador reprocesa la
//     lista entera cada hora, así que un dato basura allí es un dato basura
//     re-procesado 24 veces al día.
//
// Quien quiera cerrar la brecha del webhook tiene que hacerlo en su propio PRD,
// con su propia regresión: no basta con mover estas dos líneas de sitio.
//
// El `.toLowerCase()` SE CONSERVA en las dos: la asimetría con el camino del
// tutor —que usa el correo del token sin transformar— es preexistente y
// deliberada (PRD-003 §6, §9 filas 18 y 33). PRD-004 §6.4 explica las filas
// duplicadas que esa asimetría ya ha producido en la base.
//
// Regla de código: identificadores en inglés, comentarios en español.

/** Cota de RFC 5321 para la ruta de un correo. Se mide DESPUÉS de normalizar,
 *  que es la longitud que acabaría en la columna: `toLowerCase()` no conserva la
 *  longitud para todo Unicode. */
export const MAX_EMAIL_LENGTH = 254;

/** El extractor del webhook, con el comportamiento exacto que tenía inline en
 *  `billing.controller.ts`. No lo endurezcas aquí — ver la cabecera. */
export function emailFromCustomData(data: unknown): string | null {
  const cd = (data as { customData?: Record<string, unknown> } | null)?.customData;
  const email = cd?.email;
  return typeof email === "string" ? email.toLowerCase() : null;
}

/** El extractor del reconciliador: lo mismo más las dos cotas de §6.2. Lo que
 *  descarta suma a `sin_correo` en el resumen de la pasada (§8.2), que es lo que
 *  hace medible cuán mal está el enlace por `customData` (§10 paso 4). */
export function reconcilerEmailFromCustomData(data: unknown): string | null {
  const email = emailFromCustomData(data);
  if (email === null) return null;
  if (!email.includes("@")) return null;
  if (email.length > MAX_EMAIL_LENGTH) return null;
  return email;
}
