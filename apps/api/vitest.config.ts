// Configuración de Vitest para apps/api (PRD-003 §9).
//
// `unplugin-swc` NO es opcional: el transformador por defecto de Vitest
// (esbuild) no emite metadatos de decorador, y la DI de NestJS los necesita —
// sin el plugin, `Test.createTestingModule` no resuelve ningún provider. La
// fila 2 de §9 vigila exactamente esta configuración.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { resolve } from "node:path";
import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

const REPO_ROOT = resolve(import.meta.dirname, "../..");

export default defineConfig({
  // La transformación la hace SWC, no el Oxc que Vite 7 trae por defecto: es lo
  // único que emite metadatos de decorador. Desactivar Oxc explícitamente evita
  // que las dos pasadas se pisen.
  oxc: false,
  server: {
    // Los tests cargan `src/lib/schema.ts` de la RAÍZ del repositorio, fuera de
    // este paquete. Sin esto Vite se niega a servir el fichero.
    fs: { allow: [REPO_ROOT] },
  },
  plugins: [
    swc.vite({
      module: { type: "es6" },
      jsc: {
        target: "es2022",
        parser: { syntax: "typescript", decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  test: {
    include: ["src/**/*.spec.ts", "test/**/*.e2e-spec.ts"],
    // Los ficheros e2e comparten la base de pruebas y abren puertos: en
    // paralelo se pisan. Los unitarios son baratos, así que serializar todo
    // cuesta poco y evita una clase entera de fallos intermitentes.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 240_000,
  },
});
