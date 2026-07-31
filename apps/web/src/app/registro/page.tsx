import { Suspense } from "react";
import { connection } from "next/server";
import { curriculumSlug, getLessons, toLessonOptions } from "@shared/curriculum";
import RegistroForm from "./registro-form";
import TrackingPixel from "../tracking-pixel";

// Página pública de registro (parte ancha del embudo): captura correo + lección
// para avisos de clase. Excluida del middleware de auth (es pública).
//
// Es Server Component desde PRD-002: el selector de lección se llena desde
// `curriculum_nodes`. `connection()` la saca del prerender de build (sin él,
// `DATABASE_URL` no existe y el build revienta); lo que evita que consulte
// Postgres en cada visita es el `unstable_cache` compartido de `curriculum.ts`,
// no un export de esta página.
//
// Regla de código: identificadores en inglés; texto de UI en español.
export default async function RegistroPage() {
  await connection();
  const lessons = toLessonOptions(await getLessons(curriculumSlug()));

  return (
    <>
      <TrackingPixel path="/registro" />
      <Suspense fallback={null}>
        <RegistroForm lessons={lessons} />
      </Suspense>
    </>
  );
}
