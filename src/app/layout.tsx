import type { Metadata } from "next";
import { Fraunces, IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

// next/font descarga las fuentes en tiempo de build y las autoaloja: no hay
// petición a Google en producción, ni salto de tipografía al cargar.
// Identidad: Fraunces para titulares, IBM Plex Sans para todo lo demás.
// Fraunces se carga como fuente variable: así viaja el eje de peso completo y
// el `opsz` (tamaño óptico). `axes` no se puede combinar con pesos fijos.
const fraunces = Fraunces({
  subsets: ["latin"],
  axes: ["opsz"],
  variable: "--font-fraunces",
  display: "swap",
});

const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-sans",
  display: "swap",
});

// El código que menciona el tutor se lee en monoespaciada, no en la de texto.
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400"],
  variable: "--font-plex-mono",
  display: "swap",
});

// `metadataBase` es lo que convierte /opengraph-image.png en una URL absoluta.
// Sin él, Next no emite la tarjeta y los enlaces se comparten como un rectángulo
// gris. La imagen y su alt viven en src/app/opengraph-image.{png,alt.txt}.
export const metadata: Metadata = {
  metadataBase: new URL("https://contextia.io"),
  title: "Contextia — la escuela de developers de la era de la IA",
  description:
    "Aprende a leer y juzgar el código que escribe la IA. Clases en vivo y gratis por Twitch, martes y jueves a las 20:00 hora de Colombia.",
  openGraph: {
    type: "website",
    locale: "es_ES",
    url: "https://contextia.io",
    siteName: "Contextia",
    title: "El martes 14 de julio publicas tu primera página en internet",
    description:
      "Escuela online de programación, en español y desde cero. Clases en vivo y gratis por Twitch. No prometemos empleo: prometemos evidencia.",
  },
  twitter: {
    card: "summary_large_image",
    title: "El martes 14 de julio publicas tu primera página en internet",
    description:
      "Escuela online de programación, en español y desde cero. Clases en vivo y gratis por Twitch.",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="es"
      className={`${fraunces.variable} ${plexSans.variable} ${plexMono.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
