// Las lecciones de E1-M1 ("Tu primera semana como developer").
// Los títulos vienen de los guiones de la bóveda. Un principiante absoluto no
// sabe qué es "L4": el selector tiene que decirle de qué va la lección.
export const LESSONS = [
  { id: "L1", title: "Hoy publicas en internet" },
  { id: "L2", title: "Leer código, antes de escribirlo" },
  { id: "L3", title: "Que se vea como tú quieres" },
  { id: "L4", title: "La terminal sin miedo" },
  { id: "L5", title: "Git: tu trabajo, a salvo y con historia" },
  { id: "L6", title: "Tu primer código ajeno que funciona" },
  { id: "L7", title: "La evidencia y el ritual" },
] as const;

export type LessonId = (typeof LESSONS)[number]["id"];
