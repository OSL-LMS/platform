/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output: required for running as a long-lived Node server on Railway.
  output: "standalone",
  // `pg` y el adapter Drizzle son código Node; no los empaquetes (evita el intento
  // de resolver `pg-native` y los mantiene fuera del bundle Edge del middleware).
  serverExternalPackages: ["pg"],

  // Sin esto NO COMPILA nada de `packages/shared` (PRD-006 §5.3). Con
  // `externalDir` en falso, `next/dist/build/webpack-config.js` restringe el
  // `codeCondition` del loader a `include: [dir, ...babelIncludeRegexes]`, donde
  // `dir` es este directorio: `packages/shared/src/**` queda fuera, ningún
  // loader de SWC lo transforma, webpack parsea TypeScript como JavaScript y
  // `access.ts` revienta en su `export type`. `transpilePackages` NO es el
  // rodeo: resuelve directorios de paquete con `require.resolve` y
  // `packages/shared` no es un paquete a propósito (PRD-006 §Design Decisions).
  experimental: { externalDir: true },

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
