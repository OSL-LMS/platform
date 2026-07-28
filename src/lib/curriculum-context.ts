// El bloque de contexto que acompaña al system prompt en cada petición al tutor.
// El prompt es invariante y certificado; esto es dato y cambia con cada clase.
//
// Este módulo es PURO a propósito: no toca base de datos, así que la puerta de
// revisión de un PR (`node scripts/check-curriculum.ts`) puede medir el bloque
// compuesto llamando a la función real, no aproximándola. Ver PRD-002 §5.2.
//
// Importa con ruta relativa y extensión (no con el alias `@/lib/…`): Node no
// conoce los `paths` de tsconfig y este módulo se importa desde `scripts/`.
//
// Regla de código: identificadores en inglés, comentarios en español.

import type { CurriculumNode } from "./curriculum-file.ts";

/**
 * `moduleLessons` son SOLO las lecciones del módulo de la lección declarada —
 * no todas las del currículo. La línea "Lecciones del módulo:" miente en cuanto
 * un segundo módulo recibe lecciones, y el llamador es quien sabe acotarla.
 *
 * `lessonSlug` llega del cliente, así que es entrada no confiable: solo se usa
 * para BUSCAR en `moduleLessons`. Nunca se interpola en el prompt — si no
 * coincide con una lección real, el tutor procede sin ella y pregunta.
 */
export function buildLessonContext(
  moduleLessons: CurriculumNode[],
  ancestors: CurriculumNode[],
  lessonSlug?: string
): string {
  const lines = ["Contexto de la sesión (inyectado por la plataforma).", ""];

  // El módulo es el ancestro `module` más cercano. Sin él (una lección colgada
  // directamente de una etapa, o ningún ancestro) se omite la frase entera: un
  // "Módulo en curso: undefined" viajaría al modelo tal cual.
  const moduleNode = [...ancestors].reverse().find((a) => a.kind === "module");
  if (moduleNode) {
    const audience = moduleNode.payload.audience;
    // `audience` es opcional en el vocabulario (el módulo de un adoptante puede
    // no tenerla) pero alcanza el bloque de system: se omite la frase, no se
    // interpola vacío.
    const audienceSentence =
      typeof audience === "string" && audience.length > 0
        ? ` Tus estudiantes son ${audience}.`
        : "";
    lines.push(`Módulo en curso: "${moduleNode.title}".${audienceSentence}`);
  }

  if (moduleLessons.length > 0) {
    const index = moduleLessons.map((l) => `${l.slug} ${l.title}`).join(" · ");
    lines.push(`Lecciones del módulo: ${index}.`);
  }

  const header = lines.join("\n");

  const current = moduleLessons.find((l) => l.slug === lessonSlug);
  if (!current) {
    return `${header}\n\nEl estudiante no ha declarado en qué lección va: pregúntaselo antes de ayudarlo.`;
  }

  return (
    `${header}\n\n` +
    `El estudiante va en la Lección ${current.slug}, "${current.title}" — al terminarla, ${current.payload.outcome}.\n` +
    `De qué va y qué se le atasca (úsalo para formular mejores preguntas, no para recitar soluciones): ${current.payload.stuck}`
  );
}
