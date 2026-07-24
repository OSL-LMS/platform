"use client";

import { useState } from "react";

// Poster propio del VOD en la estética de la casa: el iframe de YouTube (pesado
// y con cookies) solo carga si el visitante le da al play. El play bermellón es
// el acento de esta pantalla — "tu siguiente paso" es mirar la clase.
export default function VodEmbed({ videoId, title }: { videoId: string; title: string }) {
  const [playing, setPlaying] = useState(false);

  if (playing) {
    return (
      <div className="vod vod--playing">
        <iframe
          src={`https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1`}
          title={title}
          allow="autoplay; encrypted-media; picture-in-picture"
          allowFullScreen
        />
      </div>
    );
  }

  return (
    <button type="button" className="vod" onClick={() => setPlaying(true)}>
      <span className="vod__bg" aria-hidden="true" />
      <span className="vod__scrim" aria-hidden="true" />
      <span className="vod__center">
        <span className="vod__play" aria-hidden="true" />
        <span className="vod__title">{title}</span>
        <span className="vod__ficha">L1 · 2 h · resultado: tu web pública en GitHub Pages</span>
      </span>
    </button>
  );
}
