// El píxel del denominador (ver /api/t): un <img> de 1×1 que cuenta la visita
// sin cookies ni JavaScript. `path` va en la URL porque las páginas son
// estáticas/ISR y el servidor no ve la ruta en el render.
//
// Regla de código: identificadores en inglés, comentarios en español.
export default function TrackingPixel({ path }: { path: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- píxel de 1×1, sin optimizar
    <img
      src={`/api/t?p=${encodeURIComponent(path)}`}
      alt=""
      width={1}
      height={1}
      aria-hidden="true"
      style={{ position: "absolute", width: 1, height: 1, opacity: 0 }}
    />
  );
}
