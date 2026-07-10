import Link from "next/link";
import LegalFooter from "./legal-footer";

// Landing pública del producto (raíz del sitio). Es pública para que Paddle
// pueda verificar el dominio y para presentar la oferta. El tutor vive en /chat
// (protegido por el middleware).
//
// Regla de código: identificadores en inglés; texto de UI en español.
export default function HomePage() {
  return (
    <main className="home">
      <section className="home__hero">
        {/* eslint-disable-next-line @next/next/no-img-element -- SVG con contornos, sin optimizar */}
        <img className="home__wordmark" src="/wordmark.svg" alt="Contextia" width={220} height={45} />
        <h1>Aprende a programar con un tutor que no te da la respuesta</h1>
        <p className="home__lead">
          Una escuela online donde aprendes a ser developer en la era de la IA.
          Las clases, las grabaciones y la comunidad son <strong>gratis</strong>.
          Y cuando te atascas, un tutor de IA te acompaña 24/7 — te guía con
          preguntas y pistas, sin resolverte el ejercicio.
        </p>
        <div className="home__cta-row">
          <Link className="pricing__cta" href="/signin">
            Empezar mi prueba de 7 días
          </Link>
          <Link className="pricing__cta pricing__cta--ghost" href="/registro">
            Registrarme gratis
          </Link>
        </div>
      </section>

      <section className="home__how">
        <h2>Cómo funciona</h2>
        <ol>
          <li>
            <strong>Mira las clases gratis</strong> — en vivo y grabadas. Desde
            cero: publicas tu primera página web, lees y escribes tu primer código.
          </li>
          <li>
            <strong>Practica con la tarea</strong> — con las guías paso a paso y
            la comunidad.
          </li>
          <li>
            <strong>El tutor te desatasca</strong> — cuando te trabas, te guía
            para que la respuesta la encuentres tú. Así se aprende de verdad.
          </li>
        </ol>
      </section>

      <section className="home__pricing">
        <h2>Precio</h2>
        <div className="pricing__cards">
          <div className="pricing__card">
            <h3>Gratis</h3>
            <p className="pricing__price">$0</p>
            <ul>
              <li>Clases en vivo y grabaciones</li>
              <li>Guías paso a paso</li>
              <li>Comunidad</li>
            </ul>
            <Link className="pricing__cta pricing__cta--ghost" href="/registro">
              Registrarme
            </Link>
          </div>
          <div className="pricing__card pricing__card--highlight">
            <h3>Tutor</h3>
            <p className="pricing__price">
              $9,99 <span>USD / mes</span>
            </p>
            <p className="pricing__trial">
              7 días de prueba gratis · precio fundador · ajustado a tu país
            </p>
            <ul>
              <li>El tutor de IA, 24/7</li>
              <li>Te guía, no te da la respuesta</li>
              <li>Recuerda tu progreso</li>
              <li>Cancela cuando quieras</li>
            </ul>
            <Link className="pricing__cta" href="/signin">
              Empezar mi prueba
            </Link>
          </div>
        </div>
        <p className="home__detail">
          ¿Más detalle? Mira la <Link href="/precios">página de precios</Link>.
        </p>
      </section>

      <LegalFooter />
    </main>
  );
}
