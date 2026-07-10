// Partir el mensaje del tutor en trozos de prosa y trozos de código.
//
// El tutor responde en texto plano con markdown ligero: `comando` entre acentos
// graves y, de vez en cuando, un bloque entre tres acentos. No renderizamos
// markdown completo (ni negritas ni listas): eso pediría una dependencia entera
// para resolver un problema que aquí tiene quince líneas. Solo el código, que es
// lo que se lee mal sin monoespaciada.
//
// Nada de esto toca el prompt del tutor: cambiarlo exigiría pasar el banco de
// evals completo antes de desplegar.

export type Chunk =
  | { kind: "text"; value: string }
  | { kind: "code"; value: string; block: boolean };

const FENCE = /```(?:[a-zA-Z]*)\n?([\s\S]*?)```/g;
const INLINE = /`([^`\n]+)`/g;

function splitInline(text: string): Chunk[] {
  const chunks: Chunk[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) chunks.push({ kind: "text", value: text.slice(last, m.index) });
    chunks.push({ kind: "code", value: m[1], block: false });
    last = m.index + m[0].length;
  }
  if (last < text.length) chunks.push({ kind: "text", value: text.slice(last) });
  return chunks;
}

export function formatMessage(raw: string): Chunk[] {
  const chunks: Chunk[] = [];
  let last = 0;
  for (const m of raw.matchAll(FENCE)) {
    if (m.index > last) {
      // El <pre> ya trae su propio margen: el salto de línea que precede al bloque
      // sumaría una línea en blanco de más.
      chunks.push(...splitInline(raw.slice(last, m.index).replace(/\n$/, "")));
    }
    chunks.push({ kind: "code", value: m[1].replace(/\n$/, ""), block: true });
    last = m.index + m[0].length;
  }
  if (last < raw.length) {
    chunks.push(...splitInline(raw.slice(last).replace(/^\n/, "")));
  }
  return chunks.filter((c) => c.kind !== "text" || c.value !== "");
}
