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
        <h1>
          El martes 14 de julio publicas tu primera página en internet. Con tu
          nombre.
        </h1>
        <p className="home__lead">
          Clase en vivo y gratis por Twitch, 20:00 hora de Colombia. Aquí no
          aprendes a escribir el código que ya escribe la IA: aprendes a leerlo,
          juzgarlo y dirigirlo — que es lo que hoy se contrata. Las clases, las
          grabaciones y la comunidad son <strong>gratis</strong>, siempre.
        </p>

        {/* Un solo CTA, y es el gratuito. La regla del CTA de `Formato del directo`
            y la Escaleta de T0: el tutor de pago no se vende antes de que exista
            la tarea que produce el atasco. */}
        <div className="home__cta-row">
          <Link className="pricing__cta" href="/registro">
            Avísame de la primera clase
          </Link>
        </div>
        <p className="home__cta-note">
          Solo tu correo. Nada que pagar hoy: el tutor llega cuando te atasques.
        </p>

        <p className="home__next">
          Próxima clase: <strong>martes 14 de julio, 20:00 h</strong> (hora de
          Colombia). En directo y gratis en{" "}
          <a href="https://twitch.tv/angelkurten" target="_blank" rel="noreferrer">
            twitch.tv/angelkurten
          </a>
          .
        </p>
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
            <Link className="pricing__cta" href="/registro">
              Registrarme gratis
            </Link>
          </div>
          <div className="pricing__card pricing__card--highlight">
            <h3>Tutor</h3>
            <p className="pricing__price">
              $9,99 <span>USD / mes</span>
            </p>
            <p className="pricing__trial">
              7 días de prueba gratis, sin tarjeta · precio fundador · ajustado a
              tu país
            </p>
            <ul>
              <li>El tutor de IA, 24/7</li>
              <li>Te guía, no te da la respuesta</li>
              <li>Recuerda tu progreso</li>
              <li>Cancela cuando quieras</li>
            </ul>
            {/* No "empezar la prueba" desde la home: el trial nace al primer login
                y se agotaría antes de que exista la tarea de L1 (21 de julio). */}
            <Link className="pricing__cta pricing__cta--ghost" href="/precios">
              Cómo funciona el tutor
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
