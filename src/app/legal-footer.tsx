import Link from "next/link";

// Footer con enlaces a las páginas legales. Paddle exige que el sitio enlace a
// términos, privacidad y reembolsos para verificarlo.
export default function LegalFooter() {
  return (
    <footer className="legal-footer">
      <Link href="/precios">Precios</Link>
      <Link href="/terminos">Términos</Link>
      <Link href="/privacidad">Privacidad</Link>
      <Link href="/reembolsos">Reembolsos</Link>
    </footer>
  );
}
