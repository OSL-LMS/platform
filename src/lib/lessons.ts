// Las lecciones de E1-M1 ("Tu primera semana como developer").
// Los títulos vienen de los guiones de la bóveda. Un principiante absoluto no
// sabe qué es "L4": el selector tiene que decirle de qué va la lección.
// `outcome` es lo que el estudiante sabe hacer al terminarla — la home lo
// muestra en el temario: cada fila dice qué te llevas, no solo un titular.
//
// `stuck` es el temario del tutor: lo que la plataforma le inyecta cuando el
// estudiante declara esta lección. Vive aquí, como dato, y NO dentro del system
// prompt: el prompt está certificado por el banco de evals y no se toca por una
// clase nueva; el temario cambia cada semana con la clase. Añadir una lección es
// una fila más aquí (la misma que ya exige el selector y `schedule.ts`).
//
// REGLA DE CONTENIDO de `stuck`: describe el ATASCO y los límites de lo que se
// enseña, nunca la solución del reto sembrado. Lo que se escriba aquí el tutor
// puede decirlo — es su contexto, no su conocimiento secreto.
export const LESSONS = [
  {
    id: "L1",
    title: "Hoy publicas en internet",
    outcome: "publicas tu web con tu nombre",
    stuck:
      "publicar con GitHub Pages. Errores frecuentes: nombre de usuario con mayúsculas o espacios; el repositorio no se llama exactamente `usuario.github.io` (un typo aquí causa el 404 más común del curso); no esperar los minutos del primer despliegue; no encontrar «Use this template» por no tener sesión iniciada.",
  },
  {
    id: "L2",
    title: "Leer código, antes de escribirlo",
    outcome: "explicas tu primer código y lo cambias",
    stuck:
      "leer y editar HTML. Errores frecuentes: borrar sin querer un `<`, `>` o `/` y romper la página; no recargar con fuerza; confundir comentarios con código; miedo a tocar.",
  },
  {
    id: "L3",
    title: "Que se vea como tú quieres",
    outcome: "tu página, con tu diseño",
    stuck:
      "CSS. Errores frecuentes: el cambio no se ve (caché — recargar con `Ctrl+Shift+R` / `Cmd+Shift+R`); borrar un `;` o `}` y perder todos los estilos (el historial del archivo en GitHub permite comparar); contraste ilegible.",
  },
  {
    id: "L4",
    title: "La terminal sin miedo",
    outcome: "te mueves por tu máquina como developer",
    stuck:
      "la terminal. Errores frecuentes: miedo inicial; perderse entre carpetas (no saber «dónde estoy»); diferencias entre Windows y Mac.",
  },
  {
    id: "L5",
    title: "Git: tu trabajo, a salvo y con historia",
    outcome: "tu repositorio con historia de verdad",
    stuck:
      "git local. Es la lección con más fricción del módulo: instalación según sistema operativo, autenticación con GitHub, el flujo add → commit → push.",
  },
  {
    id: "L6",
    title: "Tu primer código ajeno que funciona",
    outcome: "integras y corriges código que no escribiste",
    stuck:
      "integrar un fragmento de JavaScript ajeno (el botón de modo oscuro); romperlo a propósito y arreglarlo es parte del ejercicio. **En esta lección no se enseña JavaScript**: si pregunta por `const`, funciones o eventos, responde en una frase que eso llega en el módulo siguiente y que hoy le basta con lo que intuye del fragmento.",
  },
  {
    id: "L7",
    title: "La evidencia y el ritual",
    outcome: "tu primera pieza de portafolio, defendida",
    stuck: "el cierre del módulo: checklist del micro-hito y presentación en su crew.",
  },
] as const;

export type LessonId = (typeof LESSONS)[number]["id"];

// El módulo en emisión. Sale del prompt por la misma razón que las lecciones:
// cuando empiece M2, esto cambia y el prompt certificado sigue igual.
export const MODULE = {
  title: "Tu primera semana como developer",
  audience:
    "principiantes absolutos: están publicando su primera página web con GitHub Pages, leyendo su primer HTML y CSS, y usando la terminal y git por primera vez en su vida",
} as const;

/**
 * El bloque de contexto que acompaña al system prompt en cada petición al tutor
 * (y en el runner de evals). El prompt es invariante y certificado; esto es
 * dato y cambia con cada clase.
 *
 * `lessonId` llega del cliente, así que es entrada no confiable: solo se usa
 * para BUSCAR en LESSONS. Nunca se interpola en el prompt — si no coincide con
 * una lección real, el tutor procede sin ella y pregunta.
 */
export function buildLessonContext(lessonId?: string): string {
  const index = LESSONS.map((l) => `${l.id} ${l.title}`).join(" · ");
  const header =
    `Contexto de la sesión (inyectado por la plataforma).\n\n` +
    `Módulo en curso: "${MODULE.title}". Tus estudiantes son ${MODULE.audience}.\n` +
    `Lecciones del módulo: ${index}.`;

  const current = LESSONS.find((l) => l.id === lessonId);
  if (!current) {
    return `${header}\n\nEl estudiante no ha declarado en qué lección va: pregúntaselo antes de ayudarlo.`;
  }

  return (
    `${header}\n\n` +
    `El estudiante va en la Lección ${current.id}, "${current.title}" — al terminarla, ${current.outcome}.\n` +
    `De qué va y qué se le atasca (úsalo para formular mejores preguntas, no para recitar soluciones): ${current.stuck}`
  );
}
