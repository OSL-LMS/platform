// Segundo punto de entrada de apps/api: UNA pasada del reconciliador y termina
// (PRD-004 §5.1). No es un demonio, no abre puerto, no declara controladores y
// no hereda el `ThrottlerGuard` global. Quien programa es Railway.
//
// AVISO DE ARRANQUE, igual que en `main.ts`: el fichero emitido es
// `dist/apps/api/src/worker.js`, NO `dist/worker.js`. El `rootDir` inferido por
// tsc es la raíz del repositorio. `pnpm --filter api start:worker` lo lanza.
//
// CUATRO COSAS DE ESTE FICHERO SON LOAD-BEARING Y NINGUNA ES OBVIA:
//
//  1. `main()` SE EXPORTA y solo se auto-invoca como entrypoint. Sin eso,
//     importarlo desde un test lo EJECUTA, y la fila 18 de §9 —que afirma sobre
//     el mapa de códigos de salida— no se puede escribir.
//  2. Los manejadores de `unhandledRejection` y `uncaughtException` se instalan
//     ANTES de construir el contexto, porque el contexto es lo que puede fallar.
//  3. El logger que se le pasa a `createApplicationContext` DESCARTA SUS
//     ARGUMENTOS, y es el control de PII real de esa ruta — no `abortOnError`.
//     Ver el bloque de `CONTAINER_BUILD_LOGGER`.
//  4. El camino del deadline termina en `process.exit(1)` INCONDICIONAL. El
//     `Collection` del SDK no expone cancelación (§5.2), así que perder la
//     carrera no detiene la iteración: un `fetch` en vuelo mantendría vivo el
//     bucle de eventos y el cron acumularía pasadas solapadas. Ese camino se
//     salta `onModuleDestroy`, así que el lote pendiente de PostHog SE PIERDE —
//     es aceptable para una pasada que ya falló, y se dice aquí para que nadie
//     cuente con lo contrario.
//
// Regla de código: identificadores en inglés, comentarios en español.

import "reflect-metadata";

import { ConsoleLogger, Logger, type INestApplicationContext, type LoggerService } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

import { causeCode, errorName } from "./common/error-fields.ts";
import { ConfigError } from "./config.ts";
import { ReconcileService } from "./reconcile/reconcile.service.ts";
import { WorkerModule } from "./worker.module.ts";
import { resolveWorkerConfig, type WorkerConfig } from "./worker-config.ts";

/** Margen para que cerrar el contexto vacíe el lote de PostHog y cierre el pool.
 *  Acotado a propósito: sin cota, un `shutdown()` que no vuelve dejaría vivo un
 *  proceso de cron que ya terminó su trabajo. */
const CLOSE_GRACE_MS = 5_000;

const logger = new Logger("reconcile");

/** Línea FIJA, sin interpolar nada de lo que se recibe. Ver abajo. */
const CONTAINER_ERROR_LINE =
  "reconcile: Nest registró un error construyendo el contenedor; el detalle se " +
  "descarta por PRD-004 §8.2\n";

/** EL LOGGER QUE DESCARTA SUS ARGUMENTOS, y el único control de PII del camino
 *  de construcción del contenedor.
 *
 *  El worker no puede instalar `AllExceptionsFilter`: ese control se monta sobre
 *  una `NestExpressApplication` en `bootstrap.ts` y `createApplicationContext`
 *  devuelve un `INestApplicationContext`, sin `useGlobalFilters` ni ciclo de
 *  petición. Los otros cuatro caminos de fuga los cubren `unhandledRejection`,
 *  `uncaughtException` y el `.catch()` de nivel superior, que registran solo
 *  `name` y `code`. El quinto —un fallo DURANTE la construcción— no lo cubre
 *  ninguno de los tres, y `abortOnError: false` tampoco:
 *  `ExceptionsZone.asyncRun` llama a `exceptionHandler.handle(e)`, que hace
 *  `logger.error(exception)` CON EL OBJETO CRUDO, y lo hace ANTES de ceder el
 *  control y pase lo que pase. `abortOnError` solo elige entre `process.exit(1)`
 *  y relanzar hacia nuestro `.catch()`; no evita ese registro.
 *
 *  Por eso no basta con un logger que "no formatee un `Error`": tiene que
 *  descartar lo que recibe. Un `DrizzleQueryError` lanzado por una fábrica lleva
 *  los parámetros ligados —con el correo— dentro de `message`. */
export const CONTAINER_BUILD_LOGGER: LoggerService = {
  // El ruido de arranque de Nest ("dependencies initialized") no le interesa a
  // un cron; y aunque interesara, no hay forma de saber que un argumento es
  // inocuo sin mirarlo.
  log(): void {},
  warn(): void {},
  debug(): void {},
  verbose(): void {},
  error(): void {
    process.stderr.write(CONTAINER_ERROR_LINE);
  },
  fatal(): void {
    process.stderr.write(CONTAINER_ERROR_LINE);
  },
};

/** Registro de un fallo bajo las reglas de §8.2: SOLO `name` y `code`.
 *
 *  Escribe directo a `process.stderr` y no por el `Logger` de Nest a propósito:
 *  cuando esto se llama, el logger global puede ser todavía el que descarta —un
 *  rechazo no manejado durante la construcción del contenedor es exactamente ese
 *  caso—, y el mensaje saneado se perdería.
 *
 *  `ApiError` del SDK de Paddle no asigna `name`, así que todo fallo suyo se
 *  registra como `name=Error`; lo que discrimina es `code`, que `causeCode()`
 *  lee y que pasa el guarda de forma. Un 403 por clave sin permiso sigue siendo
 *  diagnosticable. */
export function writeWorkerFailure(what: string, err: unknown): void {
  process.stderr.write(`reconcile: ${what}: name=${errorName(err)} code=${causeCode(err)}\n`);
}

const onUnhandledRejection = (reason: unknown): void => {
  writeWorkerFailure("rechazo no manejado", reason);
  process.exit(1);
};

const onUncaughtException = (err: unknown): void => {
  writeWorkerFailure("excepción no capturada", err);
  process.exit(1);
};

/** Idempotente: `off` antes de `on` con las MISMAS referencias. Llamarla dos
 *  veces —los tests lo hacen— no acumula manejadores ni dispara el aviso de
 *  `MaxListenersExceeded`. */
export function installProcessErrorHandlers(): void {
  process.off("unhandledRejection", onUnhandledRejection);
  process.on("unhandledRejection", onUnhandledRejection);
  process.off("uncaughtException", onUncaughtException);
  process.on("uncaughtException", onUncaughtException);
}

/** Devuelve el registro normal. El descarte protege SOLO la construcción del
 *  contenedor; si se quedara puesto se comería la línea de resumen de §8.2 —que
 *  el paso 4 de §10 depende de leer— y nuestros propios mensajes ya saneados,
 *  porque `Logger.overrideLogger()` es global y alcanza a toda instancia de
 *  `Logger`, incluidas las creadas antes. */
function restoreLogger(): void {
  Logger.overrideLogger(new ConsoleLogger());
}

async function closeWithinGrace(context: INestApplicationContext | undefined): Promise<void> {
  if (context === undefined) return;

  let timer: NodeJS.Timeout | undefined;
  const grace = new Promise<"grace">((resolve) => {
    timer = setTimeout(() => resolve("grace"), CLOSE_GRACE_MS);
  });

  try {
    // Cerrar el contexto cierra el pool y vacía PostHog por los
    // `OnModuleDestroy` que ya existen. Si no vuelve a tiempo se sigue adelante:
    // un cron que no termina es peor que un lote de telemetría perdido.
    const outcome = await Promise.race([context.close().then(() => "closed" as const), grace]);
    if (outcome === "grace") {
      process.stderr.write(
        `reconcile: cerrar el contexto superó ${CLOSE_GRACE_MS} ms; se sale de todas formas\n`
      );
    }
  } catch (err: unknown) {
    writeWorkerFailure("error cerrando el contexto", err);
  } finally {
    clearTimeout(timer);
  }
}

export async function main(): Promise<void> {
  // ANTES de construir el contexto: lo que puede fallar es justo lo siguiente.
  installProcessErrorHandlers();

  let config: WorkerConfig;
  try {
    config = resolveWorkerConfig();
  } catch (err: unknown) {
    // Un `ConfigError` lo escribimos nosotros y no lleva PII: se puede registrar
    // entero, y TIENE que poder — un arranque que falla sin decir qué variable
    // falta no cumple el goal 8. Cualquier otro error cae bajo §8.2.
    if (err instanceof ConfigError) process.stderr.write(`reconcile: ${err.message}\n`);
    else writeWorkerFailure("error resolviendo la configuración", err);
    process.exit(1);
    return;
  }

  // Traza de arranque. Es lo que permite a la fila 39 de §9 afirmar sobre el
  // arranque sin esperar a un fallo posterior: entre la configuración y la
  // primera salida solo hay la carga de la tabla y la llamada a Paddle, y ningún
  // test puede alcanzar la segunda.
  logger.log(`reconcile: config resuelta env=${config.paddleEnvironment}`);

  let context: INestApplicationContext | undefined;
  try {
    try {
      context = await NestFactory.createApplicationContext(WorkerModule, {
        // Relanza hacia aquí en vez de llamar a `process.exit(1)` por su cuenta,
        // que es lo que permite cerrar y registrar bajo nuestras reglas. NO es
        // el control de PII: ver `CONTAINER_BUILD_LOGGER`.
        abortOnError: false,
        logger: CONTAINER_BUILD_LOGGER,
      });
    } finally {
      restoreLogger();
    }

    await context.get(ReconcileService).run();
  } catch (err: unknown) {
    // Los dos fallos se arreglan de forma distinta —uno es configuración o
    // grafo, el otro es Paddle, Postgres o el deadline—, así que se nombran
    // distinto. Que `context` siga sin definir es exactamente "no llegó a
    // construirse".
    writeWorkerFailure(context === undefined ? "fallo construyendo el contenedor" : "la pasada falló", err);
    await closeWithinGrace(context);
    process.exit(1);
    return;
  }

  await closeWithinGrace(context);
  process.exit(0);
}

/** `require.main === module` es lo que separa "me han lanzado" de "me han
 *  importado". Los `typeof` no son decorativos: el transformador de los tests
 *  emite ESM, donde ninguno de los dos identificadores existe, y sin el guarda
 *  el fichero lanzaría `ReferenceError` al importarlo. */
const isEntrypoint =
  typeof require !== "undefined" && typeof module !== "undefined" && require.main === module;

if (isEntrypoint) {
  // El tercero de los manejadores de §5.1. Los otros dos son de proceso; este
  // recoge lo que `main()` no haya podido.
  main().catch((err: unknown) => {
    writeWorkerFailure("error no capturado en main()", err);
    process.exit(1);
  });
}
