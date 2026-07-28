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

// Que `code` sea un identificador corto legible por máquina es una CONVENCIÓN
// de Node y de `pg`, no un contrato: nada impide que una dependencia futura meta
// prosa ahí. Y el objeto al que llega la rama `err.code` —el `DatabaseError` de
// `pg` sin envolver— sí lleva el correo, solo que en otros campos:
// `pg-protocol/dist/parser.js:307-316` asigna `code` (el SQLSTATE) junto a
// `detail`, `where`, `table` y `column`, y en una violación de único `detail` es
// `Key (email)=(alguien@ejemplo.test) already exists.`. La allowlist por campo es
// lo único que separa `23505` de esa cadena, así que el guarda de forma la hace
// estructural en vez de convencional.
const CODE_SHAPE = /^[A-Za-z0-9_]{1,32}$/;

/** El código del fallo (p. ej. `ECONNREFUSED`, `23505`): lo único que lo hace
 *  diagnosticable sin contar nada del usuario. Se busca primero en
 *  `err.cause.code` —ahí lo deja `DrizzleQueryError`, que envuelve el error de
 *  `pg`— y si no, en `err.code`, que es donde lo trae un error de `pg` SIN
 *  envolver, como el del evento `error` del pool. `-` cuando no hay ninguno, o
 *  cuando lo que hay no tiene forma de código. */
export function causeCode(err: unknown): string {
  const target = (err as { cause?: { code?: unknown }; code?: unknown } | null) ?? {};
  const code = target.cause?.code ?? target.code;
  if (typeof code !== "string" && typeof code !== "number") return "-";
  const text = String(code);
  return CODE_SHAPE.test(text) ? text : "-";
}
