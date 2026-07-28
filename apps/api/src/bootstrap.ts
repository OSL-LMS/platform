// Configuración de la aplicación, en un solo sitio: la usan `main.ts` y los
// tests e2e. Si divergieran, las filas 32 y 40 de §9 estarían verificando una
// configuración que producción no tiene.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { ValidationPipe } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";

import { AllExceptionsFilter } from "./common/all-exceptions.filter.ts";

/** Cota de tamaño de cuerpo (PRD-003 §5.2). Es DE APLICACIÓN y no de ruta, a
 *  propósito: acotarlo solo al webhook exigiría montar un `express.raw({ limit })`
 *  como middleware de esa ruta, y una cota global es más difícil de perder al
 *  añadir endpoints. `rawBody: true` almacena el cuerpo entero ANTES de
 *  verificar la firma, en un endpoint que cualquiera alcanza; sin esto estaría
 *  acotado en 100kb por el defecto heredado de body-parser, o sea por accidente
 *  y no por decisión. */
export const BODY_LIMIT = "64kb";

export function configureApp(app: NestExpressApplication): void {
  app.useBodyParser("json", { limit: BODY_LIMIT });

  // Sin esto el límite de tasa NO acota a nadie en particular: detrás del proxy
  // de Railway todas las peticiones llegan con la misma IP de origen, así que
  // los 120/min de `throttle.ts` serían un cubo único para el mundo entero y el
  // primer bucle automatizado dejaría a todos los estudiantes en 429. Es un
  // fallo silencioso: en local, sin proxy, funciona bien.
  //
  // El `1` es el número de saltos de confianza, y es lo que lo hace resistente a
  // suplantación: proxy-addr confía en el par del socket (el borde de Railway) y
  // se queda con la ÚLTIMA entrada de `X-Forwarded-For`, que la añade ese mismo
  // borde. Un cliente que mande su propio `X-Forwarded-For` solo consigue
  // ensuciar entradas anteriores, que no se leen. Subirlo a 2 sí abriría esa
  // puerta; no tocar sin un segundo proxy real delante.
  app.set("trust proxy", 1);

  app.useGlobalFilters(new AllExceptionsFilter());

  // Defensa en profundidad para DTOs FUTUROS, y se dice en este orden a
  // propósito: el pipe solo actúa sobre parámetros decorados y tipados contra un
  // DTO, así que hoy no se ejecuta y no está protegiendo de nada. El control de
  // identidad es que los handlers de /v1/access* no declaran @Body/@Query/@Param
  // (§5.1) — no este pipe.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));

  // CORS NO se habilita (§8 punto 3). NestJS ya viene así por defecto, pero se
  // declara aquí para que sea una invariante revisable y no una omisión: esta
  // fase es solo servidor-a-servidor, el navegador sigue hablando con Next.
}
