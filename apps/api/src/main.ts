// Punto de entrada de apps/api.
//
// AVISO DE ARRANQUE (PRD-003 §Design Decisions): el fichero emitido es
// `dist/apps/api/src/main.js`, NO `dist/main.js`. El `rootDir` inferido por tsc
// es la raíz del repositorio, porque el árbol de entrada incluye el import
// cruzado a `../../src/lib/schema.ts`. El comando de arranque en Railway es
// `node dist/apps/api/src/main.js`; los defaults de las herramientas asumen lo
// otro y nadie lo descubriría hasta el primer arranque.
//
// Regla de código: identificadores en inglés, comentarios en español.

import "reflect-metadata";

import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";

import { AppModule } from "./app.module.ts";
import { configureApp } from "./bootstrap.ts";
import { ConfigError, resolveApiConfig } from "./config.ts";
import { errorName } from "./common/error-fields.ts";

async function bootstrap(): Promise<void> {
  // Goal 5: la configuración se valida ANTES de levantar nada. `ConfigModule`
  // la vuelve a resolver dentro del contenedor (es una función pura del
  // entorno), pero validarla aquí es lo que da un mensaje legible en vez de un
  // error de DI.
  const config = resolveApiConfig();

  // `rawBody: true` es lo que hace que `req.rawBody` exista para el webhook.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  configureApp(app);
  app.enableShutdownHooks();

  await app.listen(config.port, "0.0.0.0");
  new Logger("bootstrap").log(`apps/api escuchando en el puerto ${config.port}`);
}

bootstrap().catch((err: unknown) => {
  // Un ConfigError lo escribimos nosotros y no lleva PII: se puede registrar
  // entero, y tiene que poder — un arranque que falla sin decir qué variable
  // falta no cumple el goal 5. Cualquier otro error cae bajo §8.
  const detail = err instanceof ConfigError ? err.message : errorName(err);
  new Logger("bootstrap").error(`apps/api no pudo arrancar: ${detail}`);
  process.exit(1);
});
