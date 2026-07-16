import Link from "next/link";

// Footer con enlaces a las páginas legales. Paddle exige que el sitio enlace a
// términos, privacidad y reembolsos para verificarlo. Discord y YouTube van
// aquí para que la comunidad sea descubrible sin login.
export default function LegalFooter() {
  return (
    <footer className="legal-footer">
      <Link href="/precios">Precios</Link>
      <Link href="/terminos">Términos</Link>
      <Link href="/privacidad">Privacidad</Link>
      <Link href="/reembolsos">Reembolsos</Link>
      <a href="https://discord.gg/dmyrdCWR8a" target="_blank" rel="noreferrer">
        Discord
      </a>
      <a
        href="https://www.youtube.com/watch?v=T6g1Ynm8r3c"
        target="_blank"
        rel="noreferrer"
      >
        YouTube
      </a>
    </footer>
  );
}
