import LegalFooter from "../legal-footer";

export const metadata = { title: "Política de privacidad — Tutor" };

// Borrador estándar para verificación de Paddle. Conviene revisión legal.
export default function PrivacidadPage() {
  return (
    <main className="legal">
      <h1>Política de privacidad</h1>
      <p className="legal__updated">Última actualización: 13 de junio de 2026</p>

      <h2>1. Qué datos recopilamos</h2>
      <ul>
        <li>
          <strong>Tu correo electrónico</strong> (y tu nombre, si lo das) para
          crear tu cuenta, enviarte el enlace de acceso y avisarte de las clases.
        </li>
        <li>
          <strong>Tus conversaciones con el tutor</strong>, para mantener tu
          historial y la continuidad del aprendizaje.
        </li>
        <li>
          <strong>Datos de pago</strong>, gestionados por nuestro procesador de
          pagos Paddle; nosotros no almacenamos tu tarjeta.
        </li>
      </ul>

      <h2>2. Para qué los usamos</h2>
      <p>
        Para prestarte el servicio: autenticarte, hacer funcionar el tutor,
        recordar tu progreso, gestionar tu suscripción y comunicarnos contigo
        sobre el curso.
      </p>

      <h2>3. Con quién los compartimos</h2>
      <p>Usamos proveedores que procesan datos por nuestra cuenta:</p>
      <ul>
        <li>
          <strong>Anthropic</strong> — procesa tus mensajes con el tutor para
          generar las respuestas del modelo de IA.
        </li>
        <li>
          <strong>Resend</strong> — envía los correos (enlace de acceso, avisos).
        </li>
        <li>
          <strong>Railway</strong> — aloja la aplicación y la base de datos.
        </li>
        <li>
          <strong>Paddle</strong> — procesa los pagos como comerciante registrado.
        </li>
      </ul>
      <p>No vendemos tus datos personales.</p>

      <h2>4. Conservación</h2>
      <p>
        Conservamos tus datos mientras tengas cuenta y durante el tiempo necesario
        para cumplir obligaciones legales. Puedes pedir su eliminación.
      </p>

      <h2>5. Tus derechos</h2>
      <p>
        Puedes solicitar acceso, corrección o eliminación de tus datos, así como
        oponerte a ciertos tratamientos, escribiéndonos a{" "}
        <a href="mailto:tutor@angelkurten.com">tutor@angelkurten.com</a>.
      </p>

      <h2>6. Sesión y cookies</h2>
      <p>
        Usamos una cookie de sesión para mantenerte con la sesión iniciada tras
        usar tu enlace de acceso. Es necesaria para que el servicio funcione.
      </p>

      <h2>7. Contacto</h2>
      <p>
        Dudas sobre privacidad:{" "}
        <a href="mailto:tutor@angelkurten.com">tutor@angelkurten.com</a>.
      </p>

      <LegalFooter />
    </main>
  );
}
