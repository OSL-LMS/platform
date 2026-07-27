// Partir el mensaje del tutor en trozos de prosa, código y énfasis.
//
// El tutor responde en texto plano con markdown ligero: `comando` entre acentos
// graves, algún bloque entre tres acentos y *énfasis* o **negrita** con
// asteriscos. No renderizamos markdown completo (ni listas ni enlaces ni
// encabezados): eso pediría una dependencia entera para un problema que aquí
// tiene treinta líneas. Solo lo que el tutor usa de verdad y se lee mal en
// crudo — el código sin monoespaciada, y los asteriscos, que si no se
// interpretan salen literales en la burbuja ("*commit*").
//
// Nada de esto toca el prompt del tutor: cambiarlo exigiría pasar el banco de
// evals completo antes de desplegar. Por eso el arreglo vive aquí, en el
// render, y no en una instrucción de "no uses asteriscos".

export type Chunk =
  | { kind: "text"; value: string }
  | { kind: "code"; value: string; block: boolean }
  | { kind: "emphasis"; value: string; strong: boolean };

const FENCE = /```(?:[a-zA-Z]*)\n?([\s\S]*?)```/g;
const INLINE = /`([^`\n]+)`/g;
// `**negrita**` o `*énfasis*`. El contenido no puede tener asteriscos ni saltos
// de línea, así que un asterisco suelto ("2 * 3") no abre nada.
const EMPHASIS = /(\*\*|\*)([^*\n]+)\1/g;

function splitEmphasis(text: string): Chunk[] {
  const chunks: Chunk[] = [];
  let last = 0;
  for (const m of text.matchAll(EMPHASIS)) {
    if (m.index > last) chunks.push({ kind: "text", value: text.slice(last, m.index) });
    chunks.push({ kind: "emphasis", value: m[2], strong: m[1] === "**" });
    last = m.index + m[0].length;
  }
  if (last < text.length) chunks.push({ kind: "text", value: text.slice(last) });
  return chunks;
}

function splitInline(text: string): Chunk[] {
  const chunks: Chunk[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    // El énfasis se busca solo fuera del código: dentro de `` `código` `` un
    // asterisco es un asterisco.
    if (m.index > last) chunks.push(...splitEmphasis(text.slice(last, m.index)));
    chunks.push({ kind: "code", value: m[1], block: false });
    last = m.index + m[0].length;
  }
  if (last < text.length) chunks.push(...splitEmphasis(text.slice(last)));
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
