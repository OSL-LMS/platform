import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tu tutor — escuela de developers",
  description: "El tutor que te ayuda a aprender sin darte la respuesta.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
