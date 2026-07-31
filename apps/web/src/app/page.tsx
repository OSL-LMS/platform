import { connection } from "next/server";
import Link from "next/link";
import LegalFooter from "./legal-footer";
import TrackingPixel from "./tracking-pixel";
import VodEmbed from "./vod-embed";
import { curriculumSlug, getCurriculumForest, getLessons } from "@shared/curriculum";
import { toStageViews } from "@shared/curriculum-file";
import { formatSessionDate, nextSession, seasonAgenda } from "@/lib/schedule";

// Landing pública (raíz). Implementa `60 Negocio/Nueva home de academia.md`:
// la home como escuela en marcha (concepto "el aula en vivo"), con el programa
// completo E1→E4 y el bermellón siempre señalando "tu siguiente paso" — un
// acento por pantalla: CTA del hero, play del VOD, "estás aquí" en el mapa,
// la próxima lección del temario y el botón de matrícula.
//
// Fondos por bandas (decisión del 24 jul): papel ↔ surface alternos en
// estricto; la única franja en tinta es S8, el manifiesto.
//
// Regla: ninguna fecha escrita a mano — todas salen de src/lib/schedule.ts.
//
// Regla de código: identificadores en inglés; texto de UI en español.

// ISR corto: "próxima clase" se recalcula cada 10 minutos sin hacer la página
// dinámica. ponytail: si algún día importa el minuto exacto, force-dynamic.
export const revalidate = 600;

const VOD_L1 = "https://www.youtube.com/watch?v=T6g1Ynm8r3c";

export default async function HomePage() {
  // Saca la página del prerender de BUILD: sin esto Next la renderizaría con
  // `DATABASE_URL` ausente (db.ts cae a una cadena `placeholder`) y el build
  // reventaría en cada despliegue, incluido el rollback. El caché que sustituye
  // al de ruta completa vive en `curriculum.ts` (unstable_cache, TTL 600 s).
  await connection();

  const curriculum = curriculumSlug();
  const stages = toStageViews(await getCurriculumForest(curriculum));
  const season = seasonAgenda(await getLessons(curriculum));

  const next = nextSession();
  const agenda = next
    ? `Próxima clase — ${formatSessionDate(next)} · 20:00 Colombia · en Twitch`
    : "Pausa entre temporadas — las grabaciones siguen abiertas, gratis";

  return (
    <>
      {/* S0 · la secretaría: persiste al scroll (señal de plataforma). El
          filete inferior es el único "de prensa" que sobrevive: el umbral. */}
      <header className="home-header">
        <div className="home-header__inner">
          <Link href="/" aria-label="Contextia, inicio">
            {/* eslint-disable-next-line @next/next/no-img-element -- SVG con contornos, sin optimizar */}
            <img className="home-header__wordmark" src="/wordmark.svg" alt="Contextia" width={150} height={31} />
          </Link>
          <nav className="home-header__nav">
            <a href="#programa">El programa</a>
            <a href="#temporada">Clases en vivo</a>
            <a href="#tutor">El tutor</a>
            <Link href="/precios">Precios</Link>
            <Link href="/signin">Entrar</Link>
          </nav>
          <Link className="pricing__cta pricing__cta--compact" href="/registro?src=header">
            Empieza gratis
          </Link>
        </div>
      </header>

      <TrackingPixel path="/" />
      <main className="home">
        {/* S1 · hero: hay clase */}
        <section className="home-hero">
          <div className="wrap home-hero__grid">
            <div>
              <h1 className="display">
                La escuela donde aprendes a dirigir el código, no&nbsp;solo a escribirlo.
              </h1>
              <p className="home-hero__lead">
                Clases en vivo los martes y jueves, gratis y grabadas para
                siempre. En tu primera sesión publicas una página web con tu
                nombre — y de ahí, un camino de cuatro etapas hasta construir y
                defender software real en producción.
              </p>
              <Link className="pricing__cta home-hero__cta" href="/registro?src=hero">
                Empieza gratis — hoy publicas tu primera página
              </Link>
              <p className="agenda">
                {agenda}
                <br />
                Sin tarjeta. Sin instalar nada.
              </p>
              <a className="home-hero__secondary" href="#demo">
                Ver la clase 1 completa ↓
              </a>
            </div>
            {/* Fotografía pegada al papel. Activo pendiente: el fotograma real
                del directo (Angel + pantalla compartida); mientras llega, una
                composición honesta — el código de L1 y la cámara de clase. */}
            <figure className="stream">
              <div className="stream__frame">
                <pre className="stream__screen" aria-hidden="true">
                  {`<!doctype html>
<html lang="es">
  <head>
    <title>Mi primera página</title>
  </head>
  <body>
    <h1>[TU NOMBRE]</h1>
    <p>Esta página vive en internet.</p>
  </body>
</html>`}
                </pre>
                {/* eslint-disable-next-line @next/next/no-img-element -- retrato estático */}
                <img className="stream__cam" src="/angel-kurten.jpg" alt="Angel Kürten dando la clase en directo" width={132} height={132} />
              </div>
              <figcaption className="figcap">
                Así es la clase: tu código en pantalla, en directo y sin editar.
              </figcaption>
            </figure>
          </div>
        </section>

        {/* S2 · la demo: la clase 1 entera, sin pedirte nada */}
        <section id="demo" className="band-surface">
          <div className="wrap">
            <p className="eyebrow">La prueba</p>
            <h2>Mira la primera clase completa. Sin registro, sin recortes.</h2>
            <p className="narrow">
              Dos horas. Al final, cada estudiante tenía una página web con su
              nombre publicada en internet. Compruébalo.
            </p>
            <VodEmbed videoId="T6g1Ynm8r3c" title="Clase 1 — Hoy publicas en internet" />
            <p className="home-demo__note">
              ¿Prefieres verla con guía? <Link href="/registro?src=demo">Déjanos tu correo</Link>{" "}
              y te llega la guía de la clase 1 y el calendario de la temporada.
            </p>
          </div>
        </section>

        {/* S3 · el método: el manuscrito corregido */}
        <section>
          <div className="wrap home-method__grid">
            <div>
              <p className="eyebrow">El método</p>
              <h2 className="display">Aquí no se teclea. Aquí se corrige.</h2>
              <p>
                La IA ya escribe cerca de la mitad del código nuevo. El trabajo
                del developer de 2026 es leerlo, juzgarlo y responder por él.
                Eso es lo que enseñamos. Tu primera vez programando no es un
                folio en blanco: es explicar y modificar código vivo.
              </p>
              <ol className="home-method__steps">
                <li><span>01</span> leer → explicar → modificar</li>
                <li><span>02</span> romperlo a propósito → hipótesis → prueba → descarte</li>
                <li><span>03</span> defender en vivo lo que entregas</li>
              </ol>
              <p className="home-method__redline">
                La línea roja de toda la escuela: nunca entregas código que no entiendes.
              </p>
            </div>
            <div>
              {/* El manuscrito corregido: identidad de marca y una clase de 10
                  segundos a la vez. La anotación es el acento de esta pantalla. */}
              <div className="annotated">
                <pre>
                  <code>
                    {`// dark-mode.js — lección 6: tu primer código ajeno
const toggle = document.querySelector("#toggle");

toggle.addEventListener("click", () => {
  document.body.`}
                    <span className="annotated__underline">classList.toggle(&quot;dark&quot;)</span>
                    {`;
  localStorage.setItem("theme", `}
                    <span className="annotated__strike">&quot;dark&quot;</span>
                    {`);
});`}
                  </code>
                </pre>
                <span className="annotated__note" aria-hidden="true">
                  ¿y si el usuario ya tenía preferencia guardada? — caso borde
                </span>
              </div>
              <p className="figcap">Código real de la lección 6, corregido como se corrige en clase.</p>
            </div>
          </div>
        </section>

        {/* S4 · el programa completo */}
        <section id="programa" className="band-surface home-program">
          <div className="wrap">
            <p className="eyebrow eyebrow--center">El programa</p>
            <h2 className="display home-program__title">
              No te llevas un diploma.
              <br />
              Te llevas cuatro pruebas.
            </h2>
            <p className="home-program__lead">
              Cuatro etapas, cuatro defensas en vivo ante un mentor. De 11 a 12
              meses a tu ritmo, unas 15 horas por semana. Nada se aprueba con un
              test: explicas tus decisiones, depuras en directo y revisas código
              que nunca viste. Difícil de falsear con IA — por eso la evidencia
              vale.
            </p>

            <div className="stage-map">
              {stages.map((stage) => (
                <article key={stage.id} className={`stage${stage.status === "en-emision" ? " stage--here" : ""}`}>
                  <div>
                    {/* El texto visible sale del `slug`; `stage.id` es un UUID
                        y solo vale como `key` de React y llave de progreso. */}
                    <p className="stage__num">{stage.num}</p>
                    {stage.status === "en-emision" && <p className="stage__here">● Estás aquí</p>}
                  </div>
                  <div>
                    <h3>{stage.name}</h3>
                    <p>{stage.built}</p>
                    <p className="stage__ai-role">el rol de la IA aquí: {stage.aiRole}</p>
                    {stage.modules && (
                      <details className="stage__modules">
                        <summary>{stage.modules.length} módulos</summary>
                        <ol>
                          {stage.modules.map((m) => (
                            <li key={m}>{m}</li>
                          ))}
                        </ol>
                      </details>
                    )}
                  </div>
                  <div className="stage__side">
                    <span className="stage__data">
                      {stage.milestone} · ~{stage.hours} h{stage.modules ? ` · ${stage.modules.length} módulos` : ""}
                    </span>
                    <span className={`stamp${stage.status === "en-diseno" ? " stamp--dim" : ""}`}>
                      {stage.statusLabel}
                    </span>
                  </div>
                </article>
              ))}
            </div>

            <p className="home-program__thread">
              La IA cambia de rol contigo: en E1 no la usas, en E2 la diriges,
              en E3 la auditas, en E4 la orquestas.
            </p>
            <p className="home-program__close">
              No te vendemos un curso terminado: el programa se construye en
              directo, temporada a temporada, y las clases quedan grabadas y
              gratis para siempre.
            </p>
          </div>
        </section>

        {/* S5 · dónde empiezas: la temporada en emisión */}
        <section id="temporada">
          <div className="wrap">
            <p className="eyebrow">Ahora en emisión</p>
            <h2>Ahora mismo: tu primera semana como developer.</h2>
            <p className="narrow">
              Siete clases de 2 horas — martes y jueves, 20:00 Colombia, en
              Twitch — que terminan con tu página publicada, tu repositorio con
              historia y tu primera pieza de portafolio. Gratis, en vivo o en
              diferido, para siempre.
            </p>
            <table className="season">
              <tbody>
                {/* `title` y `outcome` vienen vacíos si la lección todavía no
                    está cargada: el calendario viaja con el código y el temario
                    se carga aparte. La fila degrada, la página no se cae. */}
                {season.map(({ session, title, outcome, emitted, isNext }) => {
                  return (
                    <tr key={session.lessonSlug} className={isNext ? "season__next" : undefined}>
                      <td className="season__id">{session.lessonSlug}</td>
                      <td className="season__title">{title}</td>
                      <td className="season__outcome">{outcome}</td>
                      <td className="season__status">
                        {emitted ? (
                          session.vodUrl ? (
                            <>
                              ✓ emitida —{" "}
                              <a href={session.vodUrl} target="_blank" rel="noreferrer">
                                ver VOD
                              </a>
                            </>
                          ) : (
                            <>✓ emitida</>
                          )
                        ) : (
                          <>
                            {isNext && <span className="season__dot" aria-hidden="true" />}
                            {formatSessionDate(session)}
                            {isNext && " · 20:00"}
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="home-season__note">
              Cada lección acaba con un cambio visible en tu página — aquí
              ninguna sesión termina a mitad de algo. En la primera semana ya
              rompes código a propósito y lo arreglas: tu primer debugging real.
            </p>
          </div>
        </section>

        {/* S6 · el tutor: el producto, por fin visible */}
        <section id="tutor" className="band-surface">
          <div className="wrap">
            <p className="eyebrow">Lo único de pago</p>
            <div className="home-tutor__grid">
              <div>
                <h2>El tutor que no te da la respuesta.</h2>
                <p>
                  Las clases son gratis para siempre. Lo único de pago es esto:
                  un tutor socrático disponible 24/7 que te hace las preguntas
                  que te harían en un code review — hasta que lo entiendes tú.
                </p>
                <p className="home-tutor__price">
                  <strong>$9,99/mes</strong> o el precio limpio de tu país.
                  Precio fundador, vitalicio mientras no canceles: cuando el
                  precio suba, el tuyo no. 7 días de prueba, sin tarjeta.
                </p>
                <p className="home-tutor__honest">
                  ¿Puedes hacer el programa con ChatGPT gratis? Puedes — y te
                  dará la respuesta. Nuestro tutor está diseñado para no
                  dártela. Por eso aprendes.
                </p>
                {/* El trial nace en /signin: 7 días, sin tarjeta. */}
                <Link className="pricing__cta" href="/signin">
                  Prueba el tutor 7 días
                </Link>
              </div>
              {/* Demo estática con las burbujas reales del chat: el único
                  bloque "elevado" de la página, y con razón — es el producto. */}
              <div className="home-tutor__demo" aria-label="Demostración del tutor">
                <p className="home-tutor__demo-label">Sobre la lección 2 · conversación abreviada</p>
                <div className="bubble bubble--user">
                  No entiendo por qué no cambia el texto:{" "}
                  <code className="bubble__inline-code">document.querySelector(&quot;h1&quot;).textContent = saludo;</code>
                </div>
                <div className="bubble bubble--assistant">
                  Antes de tocar nada: ¿qué esperabas que valiera{" "}
                  <code className="bubble__inline-code">saludo</code> en esa línea — y dónde se le da
                  valor por última vez?
                </div>
                <div className="bubble bubble--user">
                  Arriba… pero está dentro de la función. Ah. ¿Fuera de la función ya no existe?
                </div>
                <div className="bubble bubble--assistant">
                  Eso que acabas de descubrir tiene nombre: <em>ámbito</em>. Compruébalo tú: saca un{" "}
                  <code className="bubble__inline-code">console.log(saludo)</code> fuera de la función
                  y cuéntame qué ves.
                </div>
              </div>
            </div>

            {/* La frontera gratis/pago tipografiada, no tarjetas con sombra. */}
            <div className="frontier">
              <div>
                <h3>Gratis, para siempre</h3>
                <ul>
                  <li>Las clases en vivo, martes y jueves</li>
                  <li>Todas las grabaciones (VODs)</li>
                  <li>Guías y plantillas de cada lección</li>
                  <li>La comunidad en Discord</li>
                  <li>El programa entero, E1 → E4</li>
                </ul>
              </div>
              <div>
                <h3>El tutor — $9,99/mes</h3>
                <ul>
                  <li>Tutor socrático 24/7 sobre tu propio código</li>
                  <li>Te pregunta como en un code review — nunca te da la solución</li>
                  <li>Disponible cuando te atascas: a las once de la noche también</li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* S7 · el profesor y la cohorte */}
        <section>
          <div className="wrap">
            <p className="eyebrow">Quién enseña</p>
            <div className="home-teacher__grid">
              <div>
                <h2>En directo, con un profesor que responde por lo que enseña.</h2>
                <p>
                  Angel Kürten lleva más de quince años construyendo software y
                  ha liderado equipos de ingeniería de más de 30 personas. Da
                  cada clase en directo y sin editar: cuando algo falla en
                  pantalla, se depura delante de ti. Puedes verle antes de
                  decidir nada, en{" "}
                  <a href="https://twitch.tv/angelkurten" target="_blank" rel="noreferrer">
                    twitch.tv/angelkurten
                  </a>
                  .
                </p>
                <p className="home-teacher__quote">
                  «Mi trabajo no es que me veas programar. Es que el martes que
                  viene, lo publicado sea tuyo.»
                </p>
                <p className="home-teacher__discord">
                  El aula sigue abierta entre clase y clase —{" "}
                  <a href="https://discord.gg/dmyrdCWR8a" target="_blank" rel="noreferrer">
                    entra al Discord, gratis
                  </a>
                  .
                </p>
              </div>
              <figure className="home-teacher__figure">
                {/* eslint-disable-next-line @next/next/no-img-element -- captura estática */}
                <img
                  className="home-teacher__shot"
                  src="/primera-pagina.png"
                  alt="La plantilla de la primera clase, con los huecos [TU NOMBRE] sin rellenar todavía"
                  width={900}
                  height={599}
                  loading="lazy"
                />
                <figcaption className="figcap">
                  Así te llega la plantilla de la clase 1: con los huecos sin
                  rellenar. El primer día la publicas tal cual; durante la
                  semana la haces tuya.
                </figcaption>
              </figure>
            </div>
            {/* ponytail: el muro de la cohorte (capturas reales autorizadas)
                se añade cuando exista la curaduría — prohibido inflarlo. */}
          </div>
        </section>

        {/* S8 · la promesa: la única franja en tinta de la página */}
        <section className="band-ink">
          <div className="wrap home-promise">
            <p className="eyebrow">La promesa</p>
            <h2>No prometemos empleo. Prometemos evidencia.</h2>
            <p>
              Prometer trabajo, en 2026, o es ignorancia o es mentira. Lo que sí
              construyes aquí puede verificarse, no solo creerse: al final del
              camino construyes y mantienes aplicaciones completas dirigiendo
              herramientas de IA con criterio propio — sabes qué pedir, sabes
              juzgar lo que recibes, y respondes personalmente por todo el
              código que entregas.
            </p>
            <ul className="home-promise__list">
              <li>
                <span className="seal">H1</span> Proyectos publicados en producción, con historia en Git desde el primer día.
              </li>
              <li>
                <span className="seal">H2</span> Una aplicación full-stack con usuarios reales y una pull request open source con su revisión.
              </li>
              <li>
                <span className="seal">H3</span> Auditorías de código ajeno — humano y de IA — documentadas y verificables.
              </li>
              <li>
                <span className="seal">H4</span> Cuatro defensas en vivo, grabadas: tú, explicando tus decisiones ante un mentor.
              </li>
            </ul>
          </div>
        </section>

        {/* S9 · preguntas honestas (el copy anterior, re-maquetado) */}
        <section className="band-surface">
          <div className="wrap home-faq">
            <p className="eyebrow">Preguntas honestas</p>
            <details className="qa">
              <summary>¿Puedo entrar ahora que ya empezó?</summary>
              <p>
                Sí. Todas las clases quedan grabadas: empiezas por la clase 1 en{" "}
                <a href={VOD_L1} target="_blank" rel="noreferrer">YouTube</a>,
                haces su tarea y te unes al siguiente directo. La temporada acaba
                de arrancar — ponerte al día es cuestión de una tarde.
              </p>
            </details>
            <details className="qa">
              <summary>¿Funciona en Windows?</summary>
              <p>
                Sí: la escuela se hace con Windows, macOS o Linux. Cuando un paso
                cambia según tu sistema, la guía lo señala explícitamente.
              </p>
            </details>
            <details className="qa">
              <summary>¿Por qué pagar un tutor que no me da la respuesta?</summary>
              <p>
                Porque las respuestas regaladas no te hacen pasar una defensa ni
                te construyen un portafolio. El tutor conoce tu ruta, tu proyecto
                y la rúbrica de tu próxima evaluación. Y ChatGPT, gratis, sigue
                existiendo: te lo decimos nosotros.
              </p>
            </details>
            <details className="qa">
              <summary>¿No llego tarde? ¿No me va a reemplazar la IA?</summary>
              <p>
                El listón subió. La IA no te quita el trabajo de developer: te
                sube el listón, porque ahora hay que saber juzgar el código que
                escribe. Esta escuela existe para llevarte a ese listón nuevo.
              </p>
            </details>
            <details className="qa">
              <summary>¿Otro curso más que no voy a terminar?</summary>
              <p>
                El primer día ya tienes algo publicado con tu nombre. Después hay
                una cita fija dos veces por semana, una comunidad que empieza
                contigo y una tarea concreta cada clase. No prometemos empleo —
                prometemos evidencia de lo que sabes hacer.
              </p>
            </details>
          </div>
        </section>

        {/* S10 · el cierre: la matrícula. El punto del botón es el mismo gesto
            que el punto de la "i" del wordmark. */}
        <section className="home-closing">
          <div className="wrap">
            <h2>
              {next
                ? `La próxima clase es este ${formatSessionDate(next).split(" ")[0]}. Puedes estar dentro.`
                : "Las grabaciones te esperan. Puedes estar dentro."}
            </h2>
            <Link className="pricing__cta home-closing__cta" href="/registro?src=cierre">
              Empieza gratis — hoy publicas tu primera página <span aria-hidden="true">●</span>
            </Link>
            <p className="home-closing__support">
              Gratis. Sin tarjeta. Te llega el enlace del directo, el calendario
              de la temporada y la guía de la clase 1.
            </p>
            <p className="agenda">{agenda}</p>
          </div>
        </section>

        <div className="wrap">
          <LegalFooter />
        </div>
      </main>
    </>
  );
}
