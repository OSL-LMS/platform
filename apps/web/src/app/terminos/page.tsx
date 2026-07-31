import LegalFooter from "../legal-footer";

export const metadata = { title: "Términos del servicio — Tutor" };

// Borrador estándar para verificación de Paddle. Conviene revisión legal antes
// de depender plenamente de él.
export default function TerminosPage() {
  return (
    <main className="legal">
      <h1>Términos del servicio</h1>
      <p className="legal__updated">Última actualización: 13 de junio de 2026</p>

      <h2>1. El servicio</h2>
      <p>
        Ofrecemos una escuela online para aprender a programar. El contenido
        educativo (clases, grabaciones, guías y comunidad) es gratuito. Por
        separado ofrecemos, mediante suscripción, acceso a un <strong>tutor de
        inteligencia artificial</strong> que acompaña al estudiante mientras
        practica. El servicio se presta a través del sitio{" "}
        <strong>contextia.io</strong>.
      </p>

      <h2>2. Tu cuenta</h2>
      <p>
        Para usar el tutor inicias sesión con un enlace de acceso enviado a tu
        correo. Eres responsable de mantener el acceso a ese correo y del uso de
        tu cuenta. Debes ser mayor de edad o contar con autorización de tu
        representante legal.
      </p>

      <h2>3. Suscripción, prueba gratuita y pagos</h2>
      <p>
        El tutor incluye una <strong>prueba gratuita de 7 días</strong>, sin
        cobro durante ese periodo. Al terminar la prueba, el acceso continuo
        requiere una suscripción mensual. Los pagos se procesan a través de{" "}
        <strong>Paddle.com</strong>, que actúa como comerciante registrado
        (merchant of record) de las transacciones. Puedes cancelar en cualquier
        momento; conservas el acceso hasta el final del periodo ya pagado.
      </p>

      <h2>4. Uso aceptable</h2>
      <p>
        Te comprometes a no usar el servicio para fines ilícitos, a no intentar
        vulnerar su seguridad, ni a revender o redistribuir el acceso al tutor.
        El tutor es para tu aprendizaje personal.
      </p>

      <h2>5. El tutor de IA y sus limitaciones</h2>
      <p>
        El tutor genera respuestas con modelos de inteligencia artificial. Puede
        equivocarse o dar información imprecisa, y no sustituye el juicio
        profesional. Su propósito es pedagógico: guiarte para que aprendas, no
        ofrecerte asesoría profesional, legal, financiera ni de ningún otro tipo.
      </p>

      <h2>6. Propiedad intelectual</h2>
      <p>
        El contenido y el software del servicio nos pertenecen o los usamos con
        licencia. El código y los proyectos que tú creas durante tu aprendizaje
        son tuyos.
      </p>

      <h2>7. Limitación de responsabilidad</h2>
      <p>
        El servicio se ofrece "tal cual". En la medida que permita la ley, no
        respondemos por daños indirectos o por pérdidas derivadas del uso del
        tutor o de la imposibilidad de usarlo.
      </p>

      <h2>8. Terminación</h2>
      <p>
        Puedes dejar de usar el servicio y cancelar tu suscripción cuando
        quieras. Podemos suspender cuentas que incumplan estos términos.
      </p>

      <h2>9. Cambios</h2>
      <p>
        Podemos actualizar estos términos. Si el cambio es relevante, lo
        comunicaremos por los medios disponibles.
      </p>

      <h2>10. Contacto</h2>
      <p>
        Para cualquier duda, escríbenos a{" "}
        <a href="mailto:tutor@angelkurten.com">tutor@angelkurten.com</a>.
      </p>

      <LegalFooter />
    </main>
  );
}
