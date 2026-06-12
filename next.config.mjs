/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output: required for running as a long-lived Node server on Railway.
  output: "standalone",
  // `pg` y el adapter Drizzle son código Node; no los empaquetes (evita el intento
  // de resolver `pg-native` y los mantiene fuera del bundle Edge del middleware).
  serverExternalPackages: ["pg"],
};

export default nextConfig;
