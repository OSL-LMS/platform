// El barrido en aislamiento, con el cliente de Paddle y el repositorio
// sustituidos por dobles.
//
// Cubre las filas 4, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16 y 17 de PRD-004 §9.
//
// NINGÚN TEST DE ESTE FICHERO TOCA LA RED NI POSTGRES. El servicio se construye
// a mano en vez de por `Test.createTestingModule` porque aquí no se está
// probando el grafo —eso es la fila 39 y los e2e—, sino la política del barrido,
// y un constructor explícito hace visible de qué depende.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { describe, expect, it, vi } from "vitest";

import type {
  SubscriptionChanges,
  SubscriptionSnapshot,
} from "../access/subscriptions.repository.ts";
import type { ReportedSubscription } from "./paddle.client.ts";
import {
  ReconcileDeadlineError,
  ReconcileService,
  formatSummary,
  type SweepCounters,
} from "./reconcile.service.ts";
import type { WorkerConfig } from "../worker-config.ts";

const STUDENT = "estudiante@ejemplo.test";

function workerConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    databaseUrl: "postgres://nadie:nadie@127.0.0.1:1/inalcanzable",
    poolMax: 1,
    posthogApiKey: undefined,
    posthogHost: "https://us.i.posthog.com",
    paddleApiKey: "pdl_apikey_de_pruebas",
    paddleEnvironment: "sandbox",
    reconcileApply: true,
    reconcileDeadlineMs: 5_000,
    ...overrides,
  };
}

/** Una fila local tal y como la devuelve `listAll()`. */
function row(overrides: Partial<SubscriptionSnapshot> = {}): SubscriptionSnapshot {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    email: STUDENT,
    status: "trial",
    paddleSubscriptionId: null,
    ...overrides,
  };
}

/** Un reporte de Paddle con lo único que el barrido lee (§5.2). */
function reported(overrides: Partial<ReportedSubscription> = {}): ReportedSubscription {
  return {
    id: "sub_prueba",
    status: "active",
    customData: { email: STUDENT },
    ...overrides,
  };
}

type RepositoryDouble = {
  listAll: ReturnType<typeof vi.fn>;
  updateStatusIfUnchanged: ReturnType<typeof vi.fn>;
  upsertStatus: ReturnType<typeof vi.fn>;
};

function repositoryDouble(rows: SubscriptionSnapshot[]): RepositoryDouble {
  return {
    listAll: vi.fn(async () => rows),
    updateStatusIfUnchanged: vi.fn(async () => true),
    upsertStatus: vi.fn(async () => true),
  };
}

/** Cliente de Paddle que entrega las páginas dadas, una tras otra. Cada página
 *  cede el bucle de eventos antes de emitirse, que es lo que el SDK hace de
 *  verdad al pedir la siguiente. */
function paddleDouble(pages: ReportedSubscription[][]) {
  const pagesStarted: number[] = [];
  return {
    pagesStarted,
    client: {
      subscriptions: {
        list: () => ({
          async *[Symbol.asyncIterator](): AsyncIterator<ReportedSubscription> {
            for (const [n, page] of pages.entries()) {
              await Promise.resolve();
              pagesStarted.push(n);
              for (const subscription of page) yield subscription;
            }
          },
        }),
      },
    },
  };
}

type Harness = {
  service: ReconcileService;
  repository: RepositoryDouble;
  track: ReturnType<typeof vi.fn>;
};

function harness(
  rows: SubscriptionSnapshot[],
  pages: ReportedSubscription[][],
  config: Partial<WorkerConfig> = {}
): Harness {
  const repository = repositoryDouble(rows);
  const track = vi.fn();
  const service = new ReconcileService(
    workerConfig(config),
    paddleDouble(pages).client,
    repository as never,
    { track } as never
  );
  return { service, repository, track };
}

/** Ninguna escritura, por ninguna de las dos vías. */
function expectNoWrites(repository: RepositoryDouble): void {
  expect(repository.updateStatusIfUnchanged).not.toHaveBeenCalled();
  expect(repository.upsertStatus).not.toHaveBeenCalled();
}

describe("el barrido solo escribe hacia `active`", () => {
  // -------------------------------------------------------------------------
  // Fila 7 — divergencia hacia `active`
  // -------------------------------------------------------------------------
  it("fila 7: Paddle `active` y fila `trial` caducada → se escribe `active`", async () => {
    const local = row({ status: "trial" });
    const { service, repository } = harness([local], [[reported({ status: "active" })]]);

    const counters = await service.run();

    expect(repository.updateStatusIfUnchanged).toHaveBeenCalledTimes(1);
    const [id, observed, changes] = repository.updateStatusIfUnchanged.mock.calls[0] as [
      string,
      string,
      SubscriptionChanges,
    ];
    expect(id).toBe(local.id);
    // El compare-and-set va contra el estado OBSERVADO en la carga (§6.6).
    expect(observed).toBe("trial");
    expect(changes.status).toBe("active");
    // `trial_ends_at` NUNCA se toca: ni siquiera aparece en el `set`.
    expect(changes).not.toHaveProperty("trialEndsAt");
    expect(counters).toMatchObject({ reviewed: 1, repaired: 1, divergences: 1 });
  });

  it("fila 7: rellena `paddle_subscription_id` solo si la fila no lo tenía", async () => {
    const sinId = harness([row({ status: "trial" })], [[reported({ id: "sub_nuevo" })]]);
    await sinId.service.run();
    expect(sinId.repository.updateStatusIfUnchanged.mock.calls[0][2]).toMatchObject({
      paddleSubscriptionId: "sub_nuevo",
    });

    // Con uno ya guardado NO se pisa: el barrido no reasigna vínculos.
    const conId = harness(
      [row({ status: "trial", paddleSubscriptionId: "sub_viejo" })],
      [[reported({ id: "sub_nuevo" })]]
    );
    await conId.service.run();
    expect(conId.repository.updateStatusIfUnchanged.mock.calls[0][2]).not.toHaveProperty(
      "paddleSubscriptionId"
    );
  });

  // -------------------------------------------------------------------------
  // Fila 8 — divergencia hacia `canceled` NO se escribe
  // -------------------------------------------------------------------------
  it("fila 8: Paddle `canceled` y fila `active` → cero escrituras, pendiente_revocacion=1", async () => {
    // La propiedad de §1.3: el barrido concede acceso, no lo quita.
    const { service, repository } = harness(
      [row({ status: "active" })],
      [[reported({ status: "canceled" })]]
    );

    const counters = await service.run();

    expectNoWrites(repository);
    expect(counters).toMatchObject({ pendingRevocation: 1, divergences: 1, repaired: 0 });
  });

  it("fila 8: una fila que ya está `canceled` no cuenta como divergencia", async () => {
    const { service, repository } = harness(
      [row({ status: "canceled" })],
      [[reported({ status: "canceled" })]]
    );

    const counters = await service.run();

    expectNoWrites(repository);
    expect(counters).toMatchObject({ pendingRevocation: 0, divergences: 0 });
  });

  // -------------------------------------------------------------------------
  // Fila 9 — `canceled` sin fila local no crea nada
  // -------------------------------------------------------------------------
  it("fila 9: Paddle `canceled` para un correo sin fila → nada escrito", async () => {
    // Crear la fila `canceled` sería IRREVERSIBLE: `ensureTrial` hace corto
    // circuito ante cualquier fila existente, así que esa persona no podría
    // estrenar nunca el trial de 7 días (§1.3 punto 1).
    const { service, repository } = harness([], [[reported({ status: "canceled" })]]);

    const counters = await service.run();

    expectNoWrites(repository);
    expect(counters).toMatchObject({ pendingRevocation: 1 });
  });

  // -------------------------------------------------------------------------
  // Fila 10 — re-suscripción
  // -------------------------------------------------------------------------
  it("fila 10: dos suscripciones del mismo correo, una `canceled` y otra `active`", async () => {
    // Es lo normal, no un ataque: quien cancela y se vuelve a suscribir tiene
    // dos, y la cancelada no sale nunca de la lista (§6.4).
    const { service, repository } = harness(
      [row({ status: "trial" })],
      [[reported({ id: "sub_viejo", status: "canceled" }), reported({ id: "sub_nuevo" })]]
    );

    const counters = await service.run();

    expect(repository.updateStatusIfUnchanged).toHaveBeenCalledTimes(1);
    expect(counters).toMatchObject({ repaired: 1, pendingRevocation: 1 });
  });

  it("fila 10: el orden de la lista de Paddle no cambia el resultado", async () => {
    // Se escribe solo hacia `active` y el compare-and-set va contra el estado
    // OBSERVADO en la carga, así que la pasada es idempotente y conmutativa.
    const invertido = harness(
      [row({ status: "trial" })],
      [[reported({ id: "sub_nuevo" }), reported({ id: "sub_viejo", status: "canceled" })]]
    );

    const counters = await invertido.service.run();

    expect(invertido.repository.updateStatusIfUnchanged).toHaveBeenCalledTimes(1);
    expect(counters).toMatchObject({ repaired: 1, pendingRevocation: 1 });
  });

  it("fila 10: dos reportes `active` del mismo correo escriben UNA vez", async () => {
    // Sin la marca de fila ya resuelta, la segunda escritura fallaría el
    // compare-and-set contra lo que acaba de escribir la primera y contaría un
    // `desincronizado` que no ocurrió.
    const { service, repository } = harness(
      [row({ status: "trial" })],
      [[reported({ id: "sub_a" }), reported({ id: "sub_b" })]]
    );

    const counters = await service.run();

    expect(repository.updateStatusIfUnchanged).toHaveBeenCalledTimes(1);
    expect(counters).toMatchObject({ repaired: 1, divergences: 1, outOfSync: 0 });
  });

  // -------------------------------------------------------------------------
  // Fila 11 — sin divergencia, sin escritura
  // -------------------------------------------------------------------------
  it("fila 11: los estados que ya coinciden no generan escrituras", async () => {
    const { service, repository } = harness([row({ status: "active" })], [[reported()]]);

    const counters = await service.run();

    expectNoWrites(repository);
    expect(counters).toMatchObject({ reviewed: 1, divergences: 0, repaired: 0 });
  });

  it("fila 11: una fila que Paddle no reporta no se toca ni se cuenta", async () => {
    // Solo evidencia positiva (§6.3): una lista incompleta —una página que falla,
    // un `customData` vacío, una clave recortada— es indistinguible de un "no
    // existe", y con la regla contraria cualquiera de ellas dañaría a la escuela
    // entera.
    const { service, repository } = harness([row({ email: "otra@ejemplo.test" })], [[reported()]]);

    const counters = await service.run();

    // La única escritura es el alta del correo QUE SÍ está en la lista.
    expect(repository.updateStatusIfUnchanged).not.toHaveBeenCalled();
    expect(repository.upsertStatus).toHaveBeenCalledTimes(1);
    expect(counters).toMatchObject({ reviewed: 1 });
  });
});

describe("el emparejamiento y las altas", () => {
  it("empareja sin distinguir mayúsculas y actúa sobre TODAS las filas que casen", async () => {
    const mixta = row({ id: "fila-mixta", email: "Estudiante@Ejemplo.test", status: "trial" });
    const minuscula = row({ id: "fila-minuscula", email: STUDENT, status: "trial" });
    const { service, repository } = harness([mixta, minuscula], [[reported()]]);

    const counters = await service.run();

    expect(repository.updateStatusIfUnchanged).toHaveBeenCalledTimes(2);
    expect(counters).toMatchObject({ repaired: 2, divergences: 2, ambiguous: 1 });
  });

  it("`ambiguo` cuenta correos duplicados, no filas ni reportes", async () => {
    // §10 paso 4 lo lee como "cuántas cuentas duplicadas ha producido la
    // asimetría de mayúsculas": dos reportes del mismo correo duplicado siguen
    // siendo UNA cuenta duplicada.
    const { service } = harness(
      [row({ id: "a", email: "Estudiante@Ejemplo.test" }), row({ id: "b", email: STUDENT })],
      [[reported({ id: "sub_a" }), reported({ id: "sub_b" })]]
    );

    expect((await service.run()).ambiguous).toBe(1);
  });

  it("un correo sin fila se da de alta con `upsertStatus` y el predicado de §6.5", async () => {
    const { service, repository } = harness([], [[reported({ id: "sub_nuevo" })]]);

    const counters = await service.run();

    expect(repository.upsertStatus).toHaveBeenCalledTimes(1);
    const [email, changes, options] = repository.upsertStatus.mock.calls[0] as [
      string,
      SubscriptionChanges,
      { preserveCanceled?: boolean },
    ];
    expect(email).toBe(STUDENT);
    expect(changes).toMatchObject({ status: "active", paddleSubscriptionId: "sub_nuevo" });
    // Sin el predicado, un upsert incondicional pisaría con `active` una fila
    // que el webhook acabara de crear en `canceled` — y como el barrido nunca
    // revoca, se quedaría así para siempre.
    expect(options).toEqual({ preserveCanceled: true });
    expect(counters).toMatchObject({ repaired: 1, divergences: 1 });
  });

  it("dos reportes `active` de un correo sin fila dan UNA sola alta", async () => {
    const { service, repository } = harness(
      [],
      [[reported({ id: "sub_a" }), reported({ id: "sub_b" })]]
    );

    const counters = await service.run();

    expect(repository.upsertStatus).toHaveBeenCalledTimes(1);
    expect(counters).toMatchObject({ repaired: 1, divergences: 1 });
  });

  it("un conflicto descartado por el predicado cuenta `desincronizado`", async () => {
    const { service, repository } = harness([], [[reported()]]);
    repository.upsertStatus.mockResolvedValue(false);

    const counters = await service.run();

    expect(counters).toMatchObject({ repaired: 0, outOfSync: 1 });
  });

  it("un compare-and-set que afecta cero filas cuenta `desincronizado`", async () => {
    const { service, repository } = harness([row({ status: "trial" })], [[reported()]]);
    repository.updateStatusIfUnchanged.mockResolvedValue(false);

    const counters = await service.run();

    expect(counters).toMatchObject({ repaired: 0, outOfSync: 1, divergences: 1 });
  });
});

describe("lo que el barrido descarta", () => {
  // -------------------------------------------------------------------------
  // Fila 4 — estado no declarado por el SDK
  // -------------------------------------------------------------------------
  it("fila 4: un `status` fuera de los cinco no mapea, no escribe y suma a `desconocido`", async () => {
    // El webhook cae a `active` ante lo mismo (§6.2) y las dos políticas son
    // correctas para su lado: aquí no se escribe porque un estado que el SDK
    // pineado no declara solo puede venir de una versión más nueva de la API, y
    // adivinar hacia dónde cae es cómo se escribe una denegación por accidente.
    const { service, repository } = harness(
      [row({ status: "trial" })],
      [[reported({ status: "estado_del_futuro" })]]
    );

    const counters = await service.run();

    expectNoWrites(repository);
    expect(counters).toMatchObject({ reviewed: 1, unknownStatus: 1, divergences: 0 });
  });

  it("fila 4: un `status` heredado del prototipo tampoco mapea", async () => {
    const { service, repository } = harness(
      [row({ status: "trial" })],
      [[reported({ status: "toString" })]]
    );

    const counters = await service.run();

    expectNoWrites(repository);
    expect(counters.unknownStatus).toBe(1);
  });

  it("un `customData` sin correo utilizable suma a `sin_correo` y no escribe", async () => {
    const { service, repository } = harness(
      [],
      [
        [
          reported({ customData: null }),
          reported({ customData: { email: 42 } }),
          reported({ customData: { email: "nope" } }),
          reported({ customData: { email: `${"a".repeat(250)}@ejemplo.test` } }),
        ],
      ]
    );

    const counters = await service.run();

    expectNoWrites(repository);
    expect(counters).toMatchObject({ reviewed: 4, missingEmail: 4 });
  });
});

describe("modo sin escritura", () => {
  // -------------------------------------------------------------------------
  // Fila 12 — `RECONCILE_APPLY` ausente
  // -------------------------------------------------------------------------
  it("fila 12: con divergencias y sin `RECONCILE_APPLY`, cero escrituras y cuentas completas", async () => {
    const { service, repository, track } = harness(
      [row({ id: "con-fila", status: "trial" }), row({ id: "cancelada", email: "otra@ejemplo.test", status: "active" })],
      [
        [
          reported(),
          reported({ id: "sub_otra", status: "canceled", customData: { email: "otra@ejemplo.test" } }),
          reported({ id: "sub_alta", customData: { email: "sinfila@ejemplo.test" } }),
        ],
      ],
      { reconcileApply: false }
    );

    const counters = await service.run();

    expectNoWrites(repository);
    expect(track).not.toHaveBeenCalled();
    // Las cuentas son las MISMAS que en modo con escritura salvo `reparadas`:
    // el paso 5 de §10 consiste en comparar la semana de observación con la
    // primera pasada que escribe, y eso exige que los números sean comparables.
    expect(counters).toMatchObject({
      reviewed: 3,
      repaired: 0,
      divergences: 3,
      pendingRevocation: 1,
    });
  });
});

describe("la iteración sobre la API de Paddle", () => {
  // -------------------------------------------------------------------------
  // Fila 13 — paginación
  // -------------------------------------------------------------------------
  it("fila 13: una colección de dos páginas se recorre entera con `for await`", async () => {
    const double = paddleDouble([
      [reported({ id: "sub_1", customData: { email: "uno@ejemplo.test" } })],
      [reported({ id: "sub_2", customData: { email: "dos@ejemplo.test" } })],
    ]);
    const repository = repositoryDouble([]);
    const service = new ReconcileService(
      workerConfig(),
      double.client,
      repository as never,
      { track: vi.fn() } as never
    );

    const counters = await service.run();

    expect(double.pagesStarted).toEqual([0, 1]);
    expect(counters.reviewed).toBe(2);
    expect(repository.upsertStatus).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Fila 14 — fallo de la API de Paddle
  // -------------------------------------------------------------------------
  it("fila 14: un rechazo a mitad de iteración propaga", async () => {
    // Sale 1 y no 0: una pasada que no pudo mirar la lista entera no completó
    // nada, y decir lo contrario haría creer al paso 4 de §10 que no hay deriva.
    const repository = repositoryDouble([]);
    const service = new ReconcileService(
      workerConfig(),
      {
        subscriptions: {
          list: () => ({
            async *[Symbol.asyncIterator](): AsyncIterator<ReportedSubscription> {
              yield reported({ customData: { email: "uno@ejemplo.test" } });
              throw Object.assign(new Error("Paddle no responde"), { code: "ECONNRESET" });
            },
          }),
        },
      },
      repository as never,
      { track: vi.fn() } as never
    );

    await expect(service.run()).rejects.toThrow("Paddle no responde");
    // La escritura anterior al fallo SÍ persiste: no hay transacción sobre el
    // barrido (§8.4), y es seguro porque la pasada es idempotente.
    expect(repository.upsertStatus).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Fila 17 — deadline vencido
  // -------------------------------------------------------------------------
  it("fila 17: la pasada rechaza con el error de deadline", async () => {
    // EL DOBLE CEDE A TRAVÉS DE UN TEMPORIZADOR REAL. Un iterable que nunca
    // await-ea un macrotask no deja correr el temporizador del deadline: la
    // pasada no termina, el deadline no dispara, y el fichero entero muere por
    // `testTimeout` a los 30 s. El bucle está ACOTADO por la misma razón — si
    // fuera infinito seguiría vivo después de que el test pase.
    const repository = repositoryDouble([]);
    const service = new ReconcileService(
      workerConfig({ reconcileDeadlineMs: 30 }),
      {
        subscriptions: {
          list: () => ({
            async *[Symbol.asyncIterator](): AsyncIterator<ReportedSubscription> {
              for (let i = 0; i < 40; i++) {
                await new Promise((resolve) => setTimeout(resolve, 5));
              }
              yield reported();
            },
          }),
        },
      },
      repository as never,
      { track: vi.fn() } as never
    );

    await expect(service.run()).rejects.toBeInstanceOf(ReconcileDeadlineError);
  });

  it("una pasada que termina a tiempo no deja vivo el temporizador del deadline", async () => {
    // Sin el `clearTimeout`, un barrido de 2 s dejaría el proceso esperando los
    // 300 s del defecto a un temporizador que ya no le importa a nadie.
    const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    const { service } = harness([], [[reported()]], { reconcileDeadlineMs: 60_000 });

    await service.run();

    expect(process.getActiveResourcesInfo().filter((r) => r === "Timeout").length).toBe(before);
  });
});

describe("el rastro de la pasada", () => {
  // -------------------------------------------------------------------------
  // Fila 15 — formato del resumen
  // -------------------------------------------------------------------------
  it("fila 15: la línea lleva los nueve campos de §8.2, en orden y con sus valores", async () => {
    // LA FORMA ES CONTRATO: el paso 4 de §10 depende de leerla.
    const counters: SweepCounters = {
      reviewed: 9,
      repaired: 2,
      divergences: 5,
      pendingRevocation: 3,
      missingEmail: 1,
      outOfSync: 1,
      ambiguous: 4,
      unknownStatus: 7,
    };

    expect(formatSummary(counters, true)).toBe(
      "revisadas=9 reparadas=2 divergencias=5 pendiente_revocacion=3 sin_correo=1 " +
        "desincronizado=1 ambiguo=4 desconocido=7 aplicar=true"
    );
    expect(formatSummary(counters, false)).toContain("aplicar=false");
  });

  it("fila 15: la pasada emite esa línea con las cuentas que devuelve", async () => {
    const { service } = harness([row({ status: "trial" })], [[reported()]]);
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    let counters: SweepCounters;
    try {
      counters = await service.run();
    } finally {
      process.stdout.write = original;
    }

    expect(written.join("")).toContain(formatSummary(counters, true));
  });

  // -------------------------------------------------------------------------
  // Fila 16 — evento de auditoría
  // -------------------------------------------------------------------------
  it("fila 16: una reparación emite `subscription_reconciled` con `from` y `to`", async () => {
    const { service, track } = harness([row({ status: "trial" })], [[reported({ id: "sub_x" })]]);

    await service.run();

    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(STUDENT, "subscription_reconciled", {
      from: "trial",
      to: "active",
      paddle_subscription_id: "sub_x",
    });
  });

  it("fila 16: un alta emite el evento con `from: none`", async () => {
    const { service, track } = harness([], [[reported({ id: "sub_y" })]]);

    await service.run();

    expect(track).toHaveBeenCalledWith(STUDENT, "subscription_reconciled", {
      from: "none",
      to: "active",
      paddle_subscription_id: "sub_y",
    });
  });

  it("fila 16: una divergencia NO reparada no emite evento", async () => {
    // Ni la dirección `canceled` —que no se escribe— ni una escritura que pierde
    // el compare-and-set dejan rastro de algo que no ocurrió.
    const { service, track } = harness(
      [row({ status: "active" })],
      [[reported({ status: "canceled" })]]
    );

    await service.run();

    expect(track).not.toHaveBeenCalled();
  });
});
