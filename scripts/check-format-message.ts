// Comprobación del partidor de mensajes. Se ejecuta con:
//   node scripts/check-format-message.ts
// Node 22+ ejecuta TypeScript directamente. Sin framework: si algo se rompe,
// el assert lo dice.
import assert from "node:assert/strict";
import { formatMessage } from "../src/lib/format-message.ts";

// Prosa a secas: un solo trozo de texto.
assert.deepEqual(formatMessage("Hola, ¿en qué te atascaste?"), [
  { kind: "text", value: "Hola, ¿en qué te atascaste?" },
]);

// Código dentro de una frase.
assert.deepEqual(formatMessage("Prueba `git status` y mira."), [
  { kind: "text", value: "Prueba " },
  { kind: "code", value: "git status", block: false },
  { kind: "text", value: " y mira." },
]);

// Bloque con lenguaje declarado. Los saltos pegados al bloque se recortan: el
// <pre> ya trae su margen y si no, aparece una línea en blanco de más.
assert.deepEqual(formatMessage("Mira:\n```js\nconst a = 1;\n```\n¿Qué crees?"), [
  { kind: "text", value: "Mira:" },
  { kind: "code", value: "const a = 1;", block: true },
  { kind: "text", value: "¿Qué crees?" },
]);

// Un bloque solo, sin prosa alrededor, no deja trozos de texto vacíos.
assert.deepEqual(formatMessage("```\nls -l\n```"), [
  { kind: "code", value: "ls -l", block: true },
]);

// Varios inline en la misma línea.
assert.equal(formatMessage("`pwd`, `ls` y `cd`").filter((c) => c.kind === "code").length, 3);

// Durante el streaming llega texto a medias: un bloque sin cerrar no debe
// tragarse el resto del mensaje ni romper nada. Queda como texto hasta que cierre.
const parcial = formatMessage("Escribe:\n```js\nconst a =");
assert.equal(parcial.length, 1);
assert.equal(parcial[0].kind, "text");

// Un acento grave suelto tampoco rompe.
assert.equal(formatMessage("el backtick ` solo").length, 1);

// El texto sobrevive entero: nada se pierde por el camino.
const original = "Usa `cd ..` para subir.\n```\nls -l\n```\nY luego `pwd`.";
const reconstruido = formatMessage(original)
  .map((c) => (c.kind === "text" ? c.value : c.value))
  .join("");
assert.ok(reconstruido.includes("cd ..") && reconstruido.includes("ls -l") && reconstruido.includes("pwd"));

console.log("OK: formatMessage pasa las 8 comprobaciones");
