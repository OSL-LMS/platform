// El programa completo E1→E4, fuente única del mapa de la home (hermana de
// LESSONS). Los datos vienen de `10 Currículo/Arquitectura curricular.md`;
// los estados siguen la regla de honestidad de `Nueva home de academia.md`:
// E3 y E4 existen a nivel de módulos y la home lo dice ("EN DISEÑO").

export type StageStatus = "en-emision" | "disenada" | "en-diseno";

export type Stage = {
  id: string;
  name: string;
  /** Lo que el estudiante habrá construido al certificar la etapa. */
  built: string;
  /** Marginalia "el rol de la IA aquí" — el argumento diferencial, por etapa. */
  aiRole: string;
  milestone: string;
  hours: number;
  status: StageStatus;
  statusLabel: string;
  /** Solo las etapas ya diseñadas listan módulos (E3/E4: etapa + hito, sin detalle). */
  modules?: string[];
};

export const PROGRAM: Stage[] = [
  {
    id: "E1",
    name: "Fundamentos",
    built:
      "Tu primera web publicada en internet y una aplicación de consola. JavaScript primero; Python como segundo idioma. Sin asistentes de código: los fundamentos son la base del juicio.",
    aiRole: "solo el tutor socrático — escribes a mano",
    milestone: "H1",
    hours: 160,
    status: "en-emision",
    statusLabel: "EN EMISIÓN — T0",
    modules: [
      "Tu primera semana como developer",
      "Pensar en código",
      "Estructuras y problemas",
      "El código de otros",
      "Segundo idioma",
    ],
  },
  {
    id: "E2",
    name: "Construcción",
    built:
      "Una aplicación full-stack en producción — TypeScript, React, Node, PostgreSQL — con al menos un usuario real que no eres tú. Y tu primera pull request a un proyecto open source real: la plataforma de la escuela, que construyen los propios estudiantes.",
    aiRole: "copiloto, con delegación documentada",
    milestone: "H2",
    hours: 260,
    status: "disenada",
    statusLabel: "DISEÑADA — SE EMITE EN DIRECTO",
    modules: [
      "Frontend real",
      "Backend y datos",
      "Producción",
      "Integrar IA en productos",
      "Proyecto eje",
    ],
  },
  {
    id: "E3",
    name: "Auditoría",
    built:
      "El rescate: recibes una base de código ajena, defectuosa y sin documentación — humano e IA mezclados — y la auditas, testeas, documentas y mejoras sin romperla. La etapa que no encontrarás en otra escuela.",
    aiRole: "la IA es el objeto de auditoría",
    milestone: "H3",
    hours: 140,
    status: "en-diseno",
    statusLabel: "EN DISEÑO",
  },
  {
    id: "E4",
    name: "Síntesis",
    built:
      "Un encargo con requisitos deliberadamente ambiguos de un cliente real: negocias el alcance, construyes orquestando agentes de IA y entregas en producción defendiendo cada decisión.",
    aiRole: "fuerza de trabajo orquestada",
    milestone: "H4",
    hours: 150,
    status: "en-diseno",
    statusLabel: "EN DISEÑO",
  },
];
