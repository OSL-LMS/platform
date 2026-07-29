// El contrato de proceso del worker (PRD-004 §5.1) sin arrancar un proceso.
//
// Cubre las filas 18, 32 y 33 de PRD-004 §9.
//
// POR QUÉ ESTAS TRES FILAS SON UNITARIAS Y NO E2E: los códigos de salida se
// afirman normalmente desde un proceso hijo (`build-boot.e2e-spec.ts`), pero un
// proceso lanzado así no admite sustitución de providers ni alcanza la API de
// Paddle con una clave de prueba. Importar `main()` —que por eso se exporta y
// solo se auto-invoca como entrypoint— y espiar `process.exit` es lo que permite
// afirmar sobre el MAPA de códigos y no sobre uno solo.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { ConsoleLogger, Global, Logger, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { captureOutput } from "../test/helpers.ts";
import { ReconcileDeadlineError } from "./reconcile/reconcile.service.ts";
import { CONTAINER_BUILD_LOGGER, installProcessErrorHandlers, main } from "./worker.ts";

const WORKER_ENV: Record<string, string> = {
  DATABASE_URL: "postgres://nadie:nadie@127.0.0.1:1/inalcanzable",
  PADDLE_API_KEY: "pdl_apikey_de_pruebas",
  PADDLE_ENV: "sandbox",
};

/** Las variables del worker, EXPLÍCITAS y aisladas del shell de quien corra
 *  esto. En esta máquina hay `PADDLE_API_KEY` viva exportada: sobrescribirla con
 *  una de pruebas es lo que impide que un test la use por accidente. */
function applyWorkerEnv(overrides: Record<string, string | undefined> = {}): void {
  const base: Record<string, string | undefined> = {
    ...WORKER_ENV,
    POSTHOG_API_KEY: undefined,
    RECONCILE_APPLY: undefined,
    RECONCILE_DEADLINE_MS: undefined,
    ...overrides,
  };

  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/** Contexto de Nest falso: lo único que `main()` le pide es un
 *  `ReconcileService` y un `close()`. */
function contextDouble(run: () => Promise<unknown>) {
  const close = vi.fn(async () => {});
  return { close, context: { get: () => ({ run }), close } };
}

describe("el mapa de códigos de salida", () => {
  const envSnapshot = { ...process.env };
  let exit: ReturnType<typeof vi.spyOn>;
  let listeners: {
    rejection: NodeJS.UnhandledRejectionListener[];
    exception: NodeJS.UncaughtExceptionListener[];
  };

  beforeEach(() => {
    applyWorkerEnv();
    // `main()` NO devuelve el control tras `process.exit` en producción; aquí sí,
    // por eso cada camino terminal lleva su `return`.
    exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    // `main()` instala manejadores de proceso. Se guarda el estado previo y se
    // restaura al terminar: quitarlos con `removeAllListeners` se llevaría por
    // delante los de Vitest, que son los que reportan un fallo asíncrono.
    listeners = {
      rejection: process.listeners("unhandledRejection"),
      exception: process.listeners("uncaughtException"),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.removeAllListeners("unhandledRejection");
    for (const listener of listeners.rejection) process.on("unhandledRejection", listener);
    process.removeAllListeners("uncaughtException");
    for (const listener of listeners.exception) process.on("uncaughtException", listener);
    process.env = { ...envSnapshot };
    Logger.overrideLogger(new ConsoleLogger());
  });

  // -------------------------------------------------------------------------
  // Fila 18 — pasada limpia → 0
  // -------------------------------------------------------------------------
  it("fila 18: una pasada limpia sale 0 y cierra el contexto", async () => {
    const { context, close } = contextDouble(async () => ({}));
    vi.spyOn(NestFactory, "createApplicationContext").mockResolvedValue(context as never);

    await main();

    // Cerrar el contexto es lo que cierra el pool y vacía el lote de PostHog por
    // los `OnModuleDestroy` que ya existen.
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  // -------------------------------------------------------------------------
  // Fila 18 — fallo de Paddle, de base y deadline → 1
  // -------------------------------------------------------------------------
  it("fila 18: un fallo de la API de Paddle sale 1", async () => {
    const { context, close } = contextDouble(async () => {
      throw Object.assign(new Error("Paddle 403"), { code: "forbidden" });
    });
    vi.spyOn(NestFactory, "createApplicationContext").mockResolvedValue(context as never);

    const output = captureOutput();
    await main();
    const written = output.stop();

    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    // Solo `name` y `code` (§8.2). `ApiError` del SDK no asigna `name`, así que
    // lo que discrimina un 403 por clave sin permiso es el `code`.
    expect(written).toContain("code=forbidden");
    expect(written).not.toContain("Paddle 403");
  });

  it("fila 18: un fallo de Postgres sale 1", async () => {
    const { context } = contextDouble(async () => {
      throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), {
        cause: { code: "ECONNREFUSED" },
      });
    });
    vi.spyOn(NestFactory, "createApplicationContext").mockResolvedValue(context as never);

    const output = captureOutput();
    await main();
    const written = output.stop();

    expect(exit).toHaveBeenCalledWith(1);
    expect(written).toContain("code=ECONNREFUSED");
  });

  it("fila 18: el deadline vencido sale 1", async () => {
    const { context, close } = contextDouble(async () => {
      throw new ReconcileDeadlineError("La pasada superó RECONCILE_DEADLINE_MS (30 ms)");
    });
    vi.spyOn(NestFactory, "createApplicationContext").mockResolvedValue(context as never);

    const output = captureOutput();
    await main();
    const written = output.stop();

    // Se INTENTA cerrar el contexto y se sale igual: `Collection` del SDK no
    // expone cancelación, así que un `fetch` en vuelo mantendría vivo el bucle
    // de eventos y el cron acumularía pasadas solapadas.
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(written).toContain("name=ReconcileDeadlineError");
  });

  it("fila 18: una configuración inválida sale 1 nombrando la variable y sin construir nada", async () => {
    applyWorkerEnv({ DATABASE_URL: undefined });
    const create = vi.spyOn(NestFactory, "createApplicationContext");

    const output = captureOutput();
    await main();
    const written = output.stop();

    expect(exit).toHaveBeenCalledWith(1);
    expect(written).toContain("DATABASE_URL");
    // El `ConfigError` lo escribimos nosotros y no lleva PII: se registra entero.
    // Y no se llega a construir el contenedor, así que no se abre el pool.
    expect(create).not.toHaveBeenCalled();
  });

  it("fila 18: un fallo construyendo el contenedor sale 1", async () => {
    vi.spyOn(NestFactory, "createApplicationContext").mockRejectedValue(
      Object.assign(new Error("no se pudo resolver una dependencia"), { code: "DI" })
    );

    await main();

    expect(exit).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// Fila 32 — fuga en la construcción del contenedor
// ---------------------------------------------------------------------------
describe("fila 32: el correo no sobrevive a un fallo en la construcción del contenedor", () => {
  afterEach(() => {
    // `createApplicationContext` llama a `Logger.overrideLogger()`, que es
    // GLOBAL: sin esto, el logger que descarta se quedaría puesto para el resto
    // del fichero y se comería cualquier registro posterior.
    Logger.overrideLogger(new ConsoleLogger());
  });

  it("ni el ExceptionHandler de Nest ni el `.catch()` dejan el correo en la salida", async () => {
    // LO QUE SE ESTÁ PROBANDO ES EL LOGGER, NO `abortOnError`.
    // `ExceptionsZone.asyncRun` llama a `exceptionHandler.handle(e)` —que hace
    // `logger.error(exception)` con el objeto crudo— ANTES de ceder el control y
    // pase lo que pase. `abortOnError` solo elige entre `process.exit(1)` y
    // relanzar. El error de abajo imita a un `DrizzleQueryError`, que embebe los
    // parámetros ligados —con el correo— dentro de `message`.
    const leak = "Failed query: select … params: estudiante@ejemplo.test";

    @Global()
    @Module({
      providers: [
        {
          provide: "EXPLOTA",
          useFactory: () => {
            throw new Error(leak);
          },
        },
      ],
      exports: ["EXPLOTA"],
    })
    class ModuloQueExplota {}

    const output = captureOutput();
    let threw = false;
    try {
      await NestFactory.createApplicationContext(ModuloQueExplota, {
        abortOnError: false,
        logger: CONTAINER_BUILD_LOGGER,
      });
    } catch {
      threw = true;
    }
    const written = output.stop();

    expect(threw).toBe(true);
    expect(written).not.toContain("@");
    expect(written).not.toContain("estudiante");
    // Y queda señal de que algo pasó: descartar el detalle no es enmudecer.
    expect(written).toContain("construyendo el contenedor");
  });

  it("un logger que solo evitara formatear el `Error` no bastaría", async () => {
    // La demostración de por qué el control es "descarta lo que recibe": el
    // objeto llega ENTERO al `error()` del logger, así que cualquier logger que
    // lo toque —`String(err)`, `err.message`, `JSON.stringify`— lo publica.
    const recibido: unknown[] = [];
    const espia = {
      log: () => {},
      warn: () => {},
      error: (...args: unknown[]) => recibido.push(...args),
    };

    @Module({
      providers: [
        {
          provide: "EXPLOTA",
          useFactory: () => {
            throw new Error("params: estudiante@ejemplo.test");
          },
        },
      ],
    })
    class ModuloQueExplota {}

    try {
      await NestFactory.createApplicationContext(ModuloQueExplota, {
        abortOnError: false,
        logger: espia,
      });
    } catch {
      /* lo que importa es lo que recibió el logger */
    }

    expect(recibido.some((arg) => String((arg as Error)?.message).includes("@"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fila 33 — fuga por rechazo y por excepción no capturados
// ---------------------------------------------------------------------------
describe("fila 33: los manejadores de proceso registran solo `name` y `code`", () => {
  let exit: ReturnType<typeof vi.spyOn>;
  let listeners: {
    rejection: NodeJS.UnhandledRejectionListener[];
    exception: NodeJS.UncaughtExceptionListener[];
  };

  beforeEach(() => {
    exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    listeners = {
      rejection: process.listeners("unhandledRejection"),
      exception: process.listeners("uncaughtException"),
    };
    // Los manejadores de Vitest se apartan durante el test: emitir el evento con
    // ellos puestos marcaría el fichero como fallido.
    process.removeAllListeners("unhandledRejection");
    process.removeAllListeners("uncaughtException");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.removeAllListeners("unhandledRejection");
    for (const listener of listeners.rejection) process.on("unhandledRejection", listener);
    process.removeAllListeners("uncaughtException");
    for (const listener of listeners.exception) process.on("uncaughtException", listener);
  });

  it("un rechazo no manejado no deja el correo en la salida y sale 1", async () => {
    installProcessErrorHandlers();
    const err = Object.assign(new Error("Key (email)=(estudiante@ejemplo.test) already exists"), {
      code: "23505",
    });

    const output = captureOutput();
    process.emit("unhandledRejection", err, Promise.resolve() as never);
    const written = output.stop();

    expect(written).toContain("name=Error");
    expect(written).toContain("code=23505");
    expect(written).not.toContain("@");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("una excepción no capturada tampoco, y sale 1", async () => {
    installProcessErrorHandlers();
    const err = Object.assign(new Error("params: estudiante@ejemplo.test"), {
      cause: { code: "ECONNRESET" },
    });

    const output = captureOutput();
    process.emit("uncaughtException", err);
    const written = output.stop();

    expect(written).toContain("code=ECONNRESET");
    expect(written).not.toContain("@");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("instalarlos dos veces no duplica manejadores", async () => {
    // `main()` se llama una vez por proceso en producción, pero los tests la
    // llaman muchas: sin idempotencia, cada llamada añadiría un par y Node
    // acabaría avisando de `MaxListenersExceeded`.
    installProcessErrorHandlers();
    installProcessErrorHandlers();
    installProcessErrorHandlers();

    expect(process.listenerCount("unhandledRejection")).toBe(1);
    expect(process.listenerCount("uncaughtException")).toBe(1);
  });
});
