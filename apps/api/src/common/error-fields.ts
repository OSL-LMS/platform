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

/** El código del fallo (p. ej. `ECONNREFUSED`, `23505`): lo único que lo hace
 *  diagnosticable sin contar nada del usuario. Se busca primero en
 *  `err.cause.code` —ahí lo deja `DrizzleQueryError`, que envuelve el error de
 *  `pg`— y si no, en `err.code`, que es donde lo trae un error de `pg` SIN
 *  envolver, como el del evento `error` del pool. `-` cuando no hay ninguno. */
export function causeCode(err: unknown): string {
  const target = (err as { cause?: { code?: unknown }; code?: unknown } | null) ?? {};
  const code = target.cause?.code ?? target.code;
  return typeof code === "string" || typeof code === "number" ? String(code) : "-";
}
