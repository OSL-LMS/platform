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

export const metadata: Metadata = {
  title: "Contextia — el tutor que no te da la respuesta",
  description:
    "La escuela donde aprendes a leer y juzgar código en la era de la IA. Clases gratis; el tutor te desatasca sin resolverte el ejercicio.",
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
