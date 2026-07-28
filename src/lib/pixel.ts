// PRD-003 §8: decisión de emisión del píxel anónimo de /api/t, extraída como
// función pura para que scripts/check-access-bridge.ts (§9 fila 39) la pruebe
// sin depender del resto del handler.
//
// NO puede vivir dentro de src/app/api/t/route.ts: Next.js solo permite que
// un fichero de Route Handler exporte los métodos HTTP y un puñado de claves
// de configuración (GET, POST, dynamic, revalidate…) — cualquier otro export
// nombrado falla el chequeo de tipos que `next build` genera en
// .next/types/app/**/route.ts. Se comprobó en esta fase: exportar
// shouldEmitPageview() directamente desde route.ts rompe `tsc --noEmit`.
//
// Regla de código: identificadores en inglés, comentarios en español.

// El píxel deja de reutilizar AUTH_SECRET como sal (esa reserva pasa a ser
// una credencial de dos servicios, y el argumento de "no requiere
// consentimiento" del píxel depende de que el hash no sea enlazable). Falla
// CERRADO, nunca con `?? ""`: sin ANALYTICS_SALT, un despliegue calcularía
// sha256(ip|ua|día|"") — reproducible por cualquiera sin conocer ningún
// secreto, peor que no emitir.
export function shouldEmitPageview(salt: string | undefined): boolean {
  return Boolean(salt);
}
