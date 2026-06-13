import Link from "next/link";
import LegalFooter from "../legal-footer";

// Página pública de precios (también sirve de landing y de URL para Paddle).
// El precio fundador es provisional hasta la decisión de precio regionalizado.
//
// Regla de código: identificadores en inglés; texto de UI en español.
export const metadata = {
  title: "Precios — Tutor",
};

export default function PreciosPage() {
  return (
    <main className="pricing">
      <h1>Aprende a programar con un tutor que no te da la respuesta</h1>
      <p className="pricing__lead">
        Las clases, las grabaciones y la comunidad son gratis. Lo que se paga es
        el <strong>tutor de IA</strong>: te acompaña 24/7 mientras practicas y te
        desatasca con preguntas y pistas, sin resolverte el ejercicio.
      </p>

      <div className="pricing__cards">
        <section className="pricing__card">
          <h2>Gratis</h2>
          <p className="pricing__price">$0</p>
          <ul>
            <li>Clases en vivo</li>
            <li>Grabaciones</li>
            <li>Guías escritas paso a paso</li>
            <li>Comunidad</li>
          </ul>
          <Link className="pricing__cta pricing__cta--ghost" href="/registro">
            Registrarme gratis
          </Link>
        </section>

        <section className="pricing__card pricing__card--highlight">
          <h2>Tutor</h2>
          <p className="pricing__price">
            $10 <span>USD / mes</span>
          </p>
          <p className="pricing__trial">7 días de prueba gratis · precio fundador</p>
          <ul>
            <li>El tutor de IA, 24/7</li>
            <li>Método socrático: te guía, no te da la respuesta</li>
            <li>Recuerda tu progreso y tus conversaciones</li>
            <li>Cancela cuando quieras</li>
          </ul>
          <Link className="pricing__cta" href="/signin">
            Empezar mi prueba de 7 días
          </Link>
        </section>
      </div>

      <LegalFooter />
    </main>
  );
}
