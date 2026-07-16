// Envía el aviso de clase a toda la lista (tabla registrations) vía Resend.
// Uso:
//   node scripts/send-class-email.mjs                  → dry-run: cuenta la lista y muestra el correo
//   node scripts/send-class-email.mjs --test a@b.com   → envía solo a esa dirección (prueba)
//   node scripts/send-class-email.mjs --send           → envío real a toda la lista
//
// Requiere: DATABASE_URL (la pública si corre fuera de Railway) y AUTH_RESEND_KEY.
// ponytail: sin manejo de bajas — la línea de "responde y te saco" lo cubre
// hasta que la lista justifique Resend Broadcasts o un ESP.
import { Pool } from "pg";
import { Resend } from "resend";

const FROM = "Ángel de Contextia <tutor@angelkurten.com>";
const SUBJECT = "La clase 1 grabada, el Discord — y hoy la clase 2 (8 PM Colombia)";
const TEXT = `Dos enlaces para que los guardes.

La grabación de la clase 1, por si te la perdiste o quieres repasar
un paso con calma:

  https://www.youtube.com/watch?v=T6g1Ynm8r3c

Y el Discord de la comunidad. Ahí compartimos las páginas, se
resuelven dudas entre clases y aviso todo lo importante:

  https://discord.gg/dmyrdCWR8a

Entra hoy y preséntate: di quién eres y deja el enlace de tu página
si ya la publicaste.

Y una cosa más: hoy jueves hay clase 2, a las 8 de la noche, hora de
Colombia, en https://twitch.tv/angelkurten. Trae tu página de la
clase 1 — vamos a cambiarla, guardarla y ver el cambio publicado.

Nos vemos a las 8.
Ángel

—
Si no quieres recibir estos avisos, responde a este correo y te saco
de la lista.`;

// Versión HTML: identidad "tinta de corrección", modo papel (el correo es papel
// por regla de marca). Estilos inline y Georgia como serif: los clientes de
// correo no cargan Fraunces. Un solo acento: el bermellón del botón.
const HTML = `<!DOCTYPE html>
<html lang="es">
<body style="margin:0;padding:0;background-color:#f7f3ec;">
  <div style="max-width:560px;margin:0 auto;padding:40px 24px;font-family:'IBM Plex Sans',-apple-system,Segoe UI,sans-serif;color:#1a1815;">

    <div style="font-family:Georgia,'Times New Roman',serif;font-size:26px;font-weight:700;letter-spacing:-0.01em;margin-bottom:36px;">contexti<span style="color:#c0392b;">&#9679;</span></div>

    <div style="border-left:3px solid #c0392b;padding-left:20px;margin-bottom:32px;">
      <div style="font-size:13px;letter-spacing:0.16em;text-transform:uppercase;color:#6b6560;font-weight:600;margin-bottom:12px;">Temporada 1 &middot; Avisos</div>
      <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:32px;line-height:1.15;margin:0;font-weight:700;">Dos enlaces para que los guardes.</h1>
    </div>

    <p style="font-size:16px;line-height:1.6;margin:0 0 20px;">La <strong>grabaci&oacute;n de la clase 1</strong>, por si te la perdiste o quieres repasar un paso con calma:</p>

    <p style="font-size:16px;line-height:1.6;margin:0 0 20px;"><a href="https://www.youtube.com/watch?v=T6g1Ynm8r3c" style="color:#c0392b;font-weight:600;">Ver la clase 1 en YouTube &rarr;</a></p>

    <p style="font-size:16px;line-height:1.6;margin:0 0 20px;">Y el <strong>Discord de la comunidad</strong>. Ah&iacute; compartimos las p&aacute;ginas, se resuelven dudas entre clases y aviso todo lo importante. Entra hoy y pres&eacute;ntate: di qui&eacute;n eres y deja el enlace de tu p&aacute;gina si ya la publicaste.</p>

    <p style="margin:32px 0;">
      <a href="https://discord.gg/dmyrdCWR8a" style="display:inline-block;background-color:#c0392b;color:#f7f3ec;font-size:17px;font-weight:700;text-decoration:none;padding:14px 26px;border-radius:4px;">Entrar al Discord</a>
    </p>

    <p style="font-size:16px;line-height:1.6;margin:0 0 20px;">Y una cosa m&aacute;s: <strong>hoy jueves hay clase 2</strong>, a las 8 de la noche, hora de Colombia, en <a href="https://twitch.tv/angelkurten" style="color:#c0392b;font-weight:600;">twitch.tv/angelkurten</a>. Trae tu p&aacute;gina de la clase 1 &mdash; vamos a cambiarla, guardarla y ver el cambio publicado.</p>

    <p style="font-size:16px;line-height:1.6;margin:0 0 8px;">Nos vemos a las 8.</p>
    <p style="font-family:Georgia,'Times New Roman',serif;font-size:18px;font-style:italic;margin:0 0 40px;">&Aacute;ngel</p>

    <p style="font-size:13px;line-height:1.5;color:#6b6560;border-top:1px solid #e2dcd1;padding-top:16px;margin:0;">Recibes este aviso porque te registraste en contextia.io. Si no quieres recibirlos, responde a este correo y te saco de la lista.</p>
  </div>
</body>
</html>`;

const mode = process.argv.includes("--send")
  ? "send"
  : process.argv.includes("--test")
    ? "test"
    : "dry-run";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const { rows } = await pool.query(
  "SELECT email FROM registrations ORDER BY created_at"
);
await pool.end();

console.log(`Registrados en la lista: ${rows.length}`);
console.log(`\nDe:      ${FROM}\nAsunto:  ${SUBJECT}\n\n${TEXT}\n`);

if (mode === "dry-run") {
  console.log("Dry-run: no se envió nada. Usa --test tu@correo o --send.");
  process.exit(0);
}

const recipients =
  mode === "test"
    ? [process.argv[process.argv.indexOf("--test") + 1]]
    : rows.map((r) => r.email);

if (mode === "test" && !recipients[0]) {
  console.error("Falta la dirección: --test tu@correo");
  process.exit(1);
}

const resend = new Resend(process.env.AUTH_RESEND_KEY ?? process.env.RESEND_API_KEY);
let sent = 0;
const failed = [];

// El endpoint batch de Resend acepta hasta 100 correos por llamada.
for (let i = 0; i < recipients.length; i += 100) {
  const chunk = recipients.slice(i, i + 100);
  const { error } = await resend.batch.send(
    chunk.map((to) => ({ from: FROM, to, subject: SUBJECT, text: TEXT, html: HTML }))
  );
  if (error) {
    failed.push(...chunk);
    console.error(`Lote ${i / 100 + 1} falló:`, error.message ?? error);
  } else {
    sent += chunk.length;
  }
  // Límite de Resend: 2 req/s
  if (i + 100 < recipients.length) await new Promise((r) => setTimeout(r, 600));
}

console.log(`Enviados: ${sent}/${recipients.length}`);
if (failed.length) {
  console.error(`Fallaron ${failed.length}:`, failed.join(", "));
  process.exit(1);
}
