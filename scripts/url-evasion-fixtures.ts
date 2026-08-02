// LA TABLA DE EVASIÓN, en un solo sitio. La consumen `check-curriculum.ts` y
// `check-seasons.ts`, que ejercitan los DOS parsers que llaman a
// `checkUrlSafety` — el del currículo y el de temporadas.
//
// Está compartida a propósito (PRD-008 §9 fila 10). Copiada, la segunda tabla
// puede quedarse corta sin que nada se ponga rojo: tres casos ad-hoc dejarían
// pasar tabulador-en-esquema, prefijo C0 y barra invertida, que son justo los
// tres que motivaron las tres piezas de `curriculum-file.ts`. Como el detector
// tiene además una sola implementación desde PRD-008 §6.4, una fuente única de
// fixtures sobre una implementación única es lo que hace que "los dos parsers
// están cubiertos" sea cierto y no una promesa.
//
// Regla de código: identificadores en inglés, comentarios en español.

/**
 * Catorce cadenas que NAVEGAN exactamente igual que su versión limpia, porque
 * el parser de URL del navegador normaliza antes de mirar. Si el detector mira
 * el valor crudo no casan — y como es la ÚNICA puerta, ni el control de esquema
 * ni la allowlist de host llegan a correr.
 *
 * Las tres clases, y por qué cada una existe, están en `curriculum-file.ts`
 * (`URL_LIKE`, `stripUrlNoise`, `DANGEROUS_SCHEME`): hay que pensarlas juntas.
 */
export const URL_EVASIONS = [
  // (a) tab/LF/CR en cualquier posición: el parser los elimina.
  "https:\t//evil.example.com/x",
  "https:\n//evil.example.com/x",
  "https:\r//evil.example.com/x",
  "java\tscript:alert(1)",
  "javascript:\talert(1)",
  "javascript: alert(1)",
  // (b) controles C0 iniciales: el parser los recorta, y `\s` de JavaScript NO
  //     cubre U+0000-U+0008 ni U+000E-U+001F, así que `^\s*` no llegaba nunca
  //     al esquema. En JSON `"\u0001https://…"` es perfectamente legal y tan
  //     visible en un diff como lo era el tabulador.
  "\u0000https://evil.example.com/x",
  "\u0001https://evil.example.com/x",
  "\u001Fhttps://evil.example.com/x",
  "\u0000javascript:alert(1)",
  "\u000Bhttps://evil.example.com/x",
  // (c) `\` donde el navegador acepta `/`: relativo a protocolo igual que `//`.
  "/\\evil.example.com/x",
  "\\\\evil.example.com/x",
  "\\/evil.example.com/x",
];

/** Cuántas son. Quien consuma la tabla lo afirma contra esta constante: encoger
 *  la lista tiene que ponerse rojo en los dos check, no en ninguno. */
export const URL_EVASION_COUNT = 14;
