import Link from "next/link";
import LegalFooter from "./legal-footer";
import { LESSONS } from "@/lib/lessons";

// Landing pública del producto (raíz del sitio). Es pública para que Paddle
// pueda verificar el dominio y para presentar la oferta. El tutor vive en /chat
// (protegido por el middleware).
//
// La página presenta la ESCUELA (ya en marcha, cohorte abierta continua) y da
// dos acciones que no compiten: empezar gratis (CTA primario del hero) y
// entrar/probar el tutor (header + tarjeta de precio).
// Ver `60 Negocio/Home post-lanzamiento.md`.
//
// Regla: ninguna fecha fija en esta página — las fechas escritas a mano caducan
// solas (la del 14 de julio sobrevivió dos días al estreno).
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
        <nav>
          <Link href="/precios">Precios</Link>
          <Link href="/signin">Entrar</Link>
        </nav>
      </header>

      <main className="home">
        <section className="home__hero">
          <h1>
            Aprende a leer y dirigir el código que escribe la IA.
          </h1>
          <p className="home__lead">
            Escuela online de programación, en español y desde cero. Clases en
            vivo los martes y jueves a las 20:00 hora de Colombia — y todo queda
            grabado, así que entras cuando quieras. Las clases, las grabaciones
            y la comunidad son <strong>gratis</strong>, siempre.
          </p>

          {/* Un solo CTA primario, y es el gratuito. El tutor de pago se ofrece
              más abajo, después de demostrar el valor (regla del CTA de
              `Formato del directo`). */}
          <div className="home__cta-row">
            <Link className="pricing__cta" href="/registro">
              Empieza gratis
            </Link>
          </div>
          <p className="home__cta-note">
            Solo tu correo. Lo único de pago es el tutor, para cuando te atasques.
          </p>

          <p className="home__next">
            En directo, <strong>martes y jueves a las 20:00 h</strong> (hora de
            Colombia) en{" "}
            <a href="https://twitch.tv/angelkurten" target="_blank" rel="noreferrer">
              twitch.tv/angelkurten
            </a>
            . ¿Llegas con la temporada empezada? La clase 1 ya está{" "}
            <a
              href="https://www.youtube.com/watch?v=T6g1Ynm8r3c"
              target="_blank"
              rel="noreferrer"
            >
              grabada en YouTube
            </a>
            : mírala y alcanza al grupo.
          </p>
        </section>

        <section className="home__thesis">
          <h2>Qué es Contextia</h2>
          <p className="home__section-lead">
            El trabajo de developer cambió: cerca del 84&nbsp;% usa IA a diario
            y casi la mitad del código nuevo lo escribe una máquina. Lo que hoy
            se contrata no es teclear más rápido — es saber leer, juzgar y
            dirigir ese código.
          </p>
          <p className="home__section-lead">
            Contextia te forma para ese listón desde cero: clases en directo
            sin editar, proyectos que se publican de verdad y una regla que no
            se negocia — aquí nunca entregas código que no entiendes. No
            prometemos empleo: prometemos evidencia de lo que sabes hacer.
          </p>
        </section>

        <section className="home__how">
          <h2>Cómo funciona</h2>
          <ol>
            <li>
              <strong>Mira las clases gratis</strong> — en vivo los martes y
              jueves, y grabadas para siempre. Empiezas por la clase 1 y te
              pones al día a tu ritmo.
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
            español, línea a línea. Puedes ver cómo se hace, paso a paso, en{" "}
            <a
              href="https://www.youtube.com/watch?v=T6g1Ynm8r3c"
              target="_blank"
              rel="noreferrer"
            >
              la grabación de la clase 1
            </a>
            .
          </p>
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
                Angel Kürten. Llevo más de quince años construyendo software y he
                liderado equipos de ingeniería de más de 30 personas. He estado
                muchas veces al otro lado de la mesa cuando se contrata: sé lo que
                alguien como yo mira —y lo que ignora— cuando revisa el trabajo de
                un candidato.
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
                7 días de prueba gratis, sin tarjeta · precio fundador vitalicio ·
                ajustado a tu país
              </p>
              <ul>
                <li>El tutor de IA, 24/7</li>
                <li>Te guía, no te da la respuesta</li>
                <li>Recuerda tu progreso</li>
                <li>Cancela cuando quieras</li>
              </ul>
              {/* El trial nace en /signin: 7 días, sin tarjeta. */}
              <Link className="pricing__cta pricing__cta--ghost" href="/signin">
                Probar el tutor 7 días
              </Link>
            </div>
          </div>
          <p className="home__detail">
            ¿Más detalle? Mira la <Link href="/precios">página de precios</Link>.
          </p>
        </section>

        <section className="home__faq">
          <h2>Preguntas honestas</h2>

          <h3>¿Puedo entrar ahora que ya empezó?</h3>
          <p>
            Sí. Todas las clases quedan grabadas: empiezas por la clase 1 en
            YouTube, haces su tarea y te unes al siguiente directo. La temporada
            acaba de arrancar — ponerte al día es cuestión de una tarde.
          </p>

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

        <LegalFooter />
      </main>
    </>
  );
}
