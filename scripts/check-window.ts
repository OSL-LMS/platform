// Comprobación de la ventana de conversación. Se ejecuta con:
//   node scripts/check-window.ts
// Node 22+ ejecuta TypeScript directamente. Sin framework: si algo se rompe,
// el assert lo dice.
//
// Lo que se protege: que el recorte nunca deje la ventana empezando por un
// turno del `assistant`. La API de Anthropic exige que el primero sea `user`;
// si esto se rompe, el tutor devuelve 400 justo a los estudiantes con la
// conversación más larga — los más constantes.
import assert from "node:assert/strict";
import { trimWindow, MAX_WINDOW_MESSAGES } from "../packages/shared/src/window.ts";
import type { ConversationMessage } from "../packages/shared/src/schema.ts";

// Hilo alterno user/assistant de `n` mensajes, empezando por el usuario.
const thread = (n: number): ConversationMessage[] =>
  Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `m${i}`,
  }));

// Por debajo del límite: no se toca nada (misma referencia de contenido).
const corto = thread(4);
assert.deepEqual(trimWindow(corto), corto);

// Justo en el límite: intacto.
const justo = thread(MAX_WINDOW_MESSAGES);
assert.equal(trimWindow(justo).length, MAX_WINDOW_MESSAGES);

// Por encima: recorta y el primero es del usuario.
const largo = thread(MAX_WINDOW_MESSAGES + 11);
const recortado = trimWindow(largo);
assert.ok(recortado.length <= MAX_WINDOW_MESSAGES);
assert.equal(recortado[0].role, "user");
// El último mensaje siempre sobrevive: es el turno que dispara la respuesta.
assert.equal(recortado.at(-1)!.content, largo.at(-1)!.content);

// El corte que caería en un `assistant` avanza hasta el siguiente `user`:
// con ventana par y hilo impar, `slice(-N)` empieza en assistant.
const impar = thread(MAX_WINDOW_MESSAGES + 1);
assert.equal(trimWindow(impar)[0].role, "user");
assert.equal(trimWindow(impar).length, MAX_WINDOW_MESSAGES - 1);

// Caso degenerado: sin ningún turno del usuario en la ventana, devuelve el
// último mensaje en vez de una lista vacía (que sería un 400 seguro).
const soloAssistant: ConversationMessage[] = Array.from(
  { length: MAX_WINDOW_MESSAGES + 3 },
  (_, i) => ({ role: "assistant", content: `a${i}` })
);
assert.deepEqual(trimWindow(soloAssistant), [soloAssistant.at(-1)]);

console.log(`check-window: OK — ventana de ${MAX_WINDOW_MESSAGES} mensajes`);
