import Link from "next/link";
import LegalFooter from "./legal-footer";
import { LESSONS } from "@/lib/lessons";

// Landing pública del producto (raíz del sitio). Es pública para que Paddle
// pueda verificar el dominio y para presentar la oferta. El tutor vive en /chat
// (protegido por el middleware).
//
// La página vende la ESCUELA, no el tutor: el tutor es el tercer escalón del
// embudo y este tráfico está en el primero. Ver `60 Negocio/Rediseño de la home.md`.
//
// Regla de código: identificadores en inglés; texto de UI en español.
export default function HomePage() {
  return (
    <>
      <header className="site-header">
        <Link href="/" aria-label="Contextia, inicio">
          {/* eslint-disable-next-line @next/next/no-img-element -- SVG con contornos, sin optimizar */}
          <img className="site-header__wordmark" src="/wordmark.svg" alt="Contextia" width={150} height={31} />
        </Link>
        <Link href="/precios">Precios</Link>
      </header>

      <main className="home">
        <section className="home__hero">
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

        <section className="home__first">
          <h2>Lo que construyes el primer día</h2>
          <p className="home__section-lead">
            No una lección teórica: una página web tuya, publicada en internet,
            con tu nombre y su propia dirección. En unas dos horas, desde cero y
            sin instalar nada.
          </p>
          {/* eslint-disable-next-line @next/next/no-img-element -- captura estática */}
          <img
            className="home__shot"
            src="/primera-pagina.png"
            alt="La plantilla de la primera clase, con los huecos [TU NOMBRE] sin rellenar todavía"
            width={900}
            height={599}
            loading="lazy"
          />
          <p className="home__caption">
            Así te llega: con los huecos sin rellenar. El primer día la publicas
            tal cual, y durante la semana la haces tuya — el nombre, los colores,
            un botón que funciona. La plantilla es pública y está comentada en
            español, línea a línea.
          </p>
        </section>

        <section className="home__teacher">
          <h2>Quién te enseña</h2>
          <div className="home__teacher-body">
            {/* eslint-disable-next-line @next/next/no-img-element -- retrato estático */}
            <img
              className="home__portrait"
              src="/angel-kurten.jpg"
              alt="Retrato de Angel Kürten"
              width={140}
              height={140}
            />
            <div>
              <p className="home__section-lead">
                Angel Kürten. Llevo más de quince años construyendo software y hoy
                dirijo un equipo de ingeniería, que pasé de 3 a 18 personas. He
                estado muchas veces al otro lado de la mesa cuando se contrata: sé
                lo que alguien como yo mira —y lo que ignora— cuando revisa el
                trabajo de un candidato.
              </p>
              <p className="home__section-lead">
                Doy cada clase en directo y sin editar. Cuando algo falla en
                pantalla, lo depuramos delante de ti: es la lección de programación
                más honesta que existe, y ningún vídeo grabado te la puede dar.
              </p>
              <p className="home__detail">
                Puedes verme antes de decidir nada:{" "}
                <a href="https://twitch.tv/angelkurten" target="_blank" rel="noreferrer">
                  twitch.tv/angelkurten
                </a>
              </p>
            </div>
          </div>
        </section>

        <section className="home__how">
          <h2>Cómo funciona</h2>
          <ol>
            <li>
              <strong>Mira las clases gratis</strong> — en vivo los martes y
              jueves, y grabadas para siempre. Desde cero.
            </li>
            <li>
              <strong>Practica con la tarea</strong> — con las guías escritas
              paso a paso y la comunidad.
            </li>
            <li>
              <strong>El tutor te desatasca</strong> — cuando te trabas a solas,
              a las once de la noche. Te guía para que la respuesta la encuentres
              tú. Es lo único que se paga.
            </li>
          </ol>
        </section>

        <section className="home__program">
          <h2>El programa de la primera temporada</h2>
          <p className="home__section-lead">
            Siete clases. Al final tienes una página publicada, un repositorio
            con historia y un botón que funciona.
          </p>
          <ol className="home__lessons">
            {LESSONS.map((l) => (
              <li key={l.id}>
                <span className="home__lesson-id">{l.id}</span>
                {l.title}
              </li>
            ))}
          </ol>
        </section>

        <section className="home__faq">
          <h2>Preguntas honestas</h2>

          <h3>¿Por qué pagar un tutor que no me da la respuesta?</h3>
          <p>
            Porque las respuestas regaladas no te hacen pasar una defensa ni te
            construyen un portafolio. El tutor conoce tu ruta, tu proyecto y la
            rúbrica de tu próxima evaluación. Y ChatGPT, gratis, sigue existiendo:
            te lo decimos nosotros.
          </p>

          <h3>¿No llego tarde? ¿No me va a reemplazar la IA?</h3>
          <p>
            El listón subió. La IA no te quita el trabajo de developer: te sube el
            listón, porque ahora hay que saber juzgar el código que escribe. Esta
            escuela existe para llevarte a ese listón nuevo.
          </p>

          <h3>¿Otro curso más que no voy a terminar?</h3>
          <p>
            El primer día ya tienes algo publicado con tu nombre. Después hay una
            cita fija dos veces por semana, una comunidad que empieza contigo y
            una tarea concreta cada clase. No prometemos empleo — prometemos
            evidencia de lo que sabes hacer.
          </p>
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
    </>
  );
}
