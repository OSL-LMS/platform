/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output: required for running as a long-lived Node server on Railway.
  output: "standalone",
  // `pg` y el adapter Drizzle son código Node; no los empaquetes (evita el intento
  // de resolver `pg-native` y los mantiene fuera del bundle Edge del middleware).
  serverExternalPackages: ["pg"],

  // Consolidación de dominio: el sitio vive en contextia.io (el dominio aprobado
  // por Paddle, donde corre el checkout). El dominio viejo redirige preservando
  // la ruta, para que ningún usuario quede en un dominio sin checkout aprobado.
  // ponytail: 307 temporal mientras se asienta contextia.io; subir a
  // permanent:true (308) cuando el cambio sea definitivo y no se piense volver.
  async redirects() {
    return [
      {
        source: "/:path*",
        has: [{ type: "host", value: "tutor.angelkurten.com" }],
        destination: "https://contextia.io/:path*",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
