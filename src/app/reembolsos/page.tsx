import LegalFooter from "../legal-footer";

export const metadata = { title: "Política de reembolsos — Tutor" };

// Borrador estándar para verificación de Paddle. Conviene revisión legal.
export default function ReembolsosPage() {
  return (
    <main className="legal">
      <h1>Política de reembolsos</h1>
      <p className="legal__updated">Última actualización: 13 de junio de 2026</p>

      <h2>1. Prueba gratuita de 7 días</h2>
      <p>
        El tutor incluye 7 días de prueba sin costo. Durante la prueba no se te
        cobra nada, así que puedes evaluarlo sin compromiso.
      </p>

      <h2>2. Cómo se cobra</h2>
      <p>
        Al terminar la prueba, si decides continuar, se cobra la suscripción
        mensual a través de Paddle. La suscripción se renueva cada mes hasta que
        la canceles.
      </p>

      <h2>3. Cancelación</h2>
      <p>
        Puedes cancelar en cualquier momento. Al cancelar, no se generan cobros
        futuros y conservas el acceso al tutor hasta el final del periodo que ya
        pagaste.
      </p>

      <h2>4. Reembolsos</h2>
      <p>
        Si no quedaste satisfecho, puedes solicitar el <strong>reembolso
        completo dentro de los 14 días siguientes a tu primera cobranza</strong>.
        Los periodos mensuales ya transcurridos no son reembolsables, salvo que
        la ley aplicable disponga otra cosa.
      </p>

      <h2>5. Cómo solicitar un reembolso</h2>
      <p>
        Escríbenos a{" "}
        <a href="mailto:tutor@angelkurten.com">tutor@angelkurten.com</a> con el
        correo de tu cuenta. Los reembolsos los procesa Paddle, nuestro
        comerciante registrado, sobre el método de pago original.
      </p>

      <LegalFooter />
    </main>
  );
}
