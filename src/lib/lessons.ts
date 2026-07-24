// Las lecciones de E1-M1 ("Tu primera semana como developer").
// Los títulos vienen de los guiones de la bóveda. Un principiante absoluto no
// sabe qué es "L4": el selector tiene que decirle de qué va la lección.
// `outcome` es lo que el estudiante sabe hacer al terminarla — la home lo
// muestra en el temario: cada fila dice qué te llevas, no solo un titular.
export const LESSONS = [
  { id: "L1", title: "Hoy publicas en internet", outcome: "publicas tu web con tu nombre" },
  { id: "L2", title: "Leer código, antes de escribirlo", outcome: "explicas tu primer código y lo cambias" },
  { id: "L3", title: "Que se vea como tú quieres", outcome: "tu página, con tu diseño" },
  { id: "L4", title: "La terminal sin miedo", outcome: "te mueves por tu máquina como developer" },
  { id: "L5", title: "Git: tu trabajo, a salvo y con historia", outcome: "tu repositorio con historia de verdad" },
  { id: "L6", title: "Tu primer código ajeno que funciona", outcome: "integras y corriges código que no escribiste" },
  { id: "L7", title: "La evidencia y el ritual", outcome: "tu primera pieza de portafolio, defendida" },
] as const;

export type LessonId = (typeof LESSONS)[number]["id"];
