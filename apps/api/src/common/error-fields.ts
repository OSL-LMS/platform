// Los DOS únicos campos de un error que este servicio puede registrar.
//
// PRD-003 §8: el correo no puede llegar nunca a los logs, y la regla es DE
// SERVICIO, no de un `catch` suelto. `DrizzleQueryError` embebe los parámetros
// ligados dentro de `message` (drizzle-orm@0.45.2/errors.js:
// `super(\`Failed query: ${query}\nparams: ${params}\`)`), y `params` incluye el
// correo. Por eso ningún sitio de apps/api registra `err.message`, `err.stack`
// ni el objeto de error: se pasa por aquí.
//
// Regla de código: identificadores en inglés, comentarios en español.

/** `err.name` cuando lo hay; si no, el tipo, que tampoco lleva datos. */
export function errorName(err: unknown): string {
  if (err instanceof Error) return err.name;
  return `no-Error(${typeof err})`;
}

/** `err.cause.code` — el código de la causa (p. ej. `ECONNREFUSED`,
 *  `23505`), que es lo que hace diagnosticable un fallo sin contar nada del
 *  usuario. `-` cuando no hay. */
export function causeCode(err: unknown): string {
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
  const code = cause?.code;
  return typeof code === "string" || typeof code === "number" ? String(code) : "-";
}
