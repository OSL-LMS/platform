// El barrido contra Postgres de verdad, con el cliente de Paddle sustituido por
// un doble.
//
// Cubre las filas 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31 y 34 de
// PRD-004 §9.
//
// ESCRIBEN Y BORRAN en `subscriptions`: exigen `API_TEST_DATABASE_URL` apuntando
// a una base desechable, y abortan si coincide con `DATABASE_URL`.
//
// LO QUE SOLO SE PUEDE PROBAR AQUÍ: el emparejamiento insensible a mayúsculas
// (§6.4) depende de que `subscriptions.email` sea `text` plano con unique, y el
// compare-and-set (§6.6) y el `setWhere` del alta (§6.5) son cláusulas SQL. Un
// doble del repositorio los daría todos por buenos.
//
// EL DOBLE DE PADDLE PUEDE TOCAR LA BASE ANTES DE EMITIR (`beforeFirst`), y es
// la costura que hace observables las carreras: el barrido carga la tabla entera
// ANTES de iterar, así que ese hueco es exactamente la ventana que §6.5 y §6.6
// existen para cerrar.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { ConsoleLogger, Global, Logger, Module } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { evaluate } from "../src/access/access.service.ts";
import { SubscriptionsRepository } from "../src/access/subscriptions.repository.ts";
import { API_CONFIG } from "../src/config.ts";
import { DrizzleModule, PG_POOL } from "../src/db/drizzle.module.ts";
import * as schema from "../src/db/schema.ts";
import { PADDLE_CLIENT, type ReportedSubscription } from "../src/reconcile/paddle.client.ts";
import { ReconcileModule } from "../src/reconcile/reconcile.module.ts";
import { ReconcileService } from "../src/reconcile/reconcile.service.ts";
import type { WorkerConfig } from "../src/worker-config.ts";
import { writeWorkerFailure } from "../src/worker.ts";
import { captureOutput, migrateTestDatabase, requireTestDatabaseUrl } from "./helpers.ts";

const MIXED = "Estudiante@Ejemplo.test";
const LOWER = "estudiante@ejemplo.test";
const DAY_MS = 24 * 60 * 60 * 1000;

/** Guion del doble de Paddle. Mutable entre tests: `pages` es lo que la pasada
 *  verá, y `beforeFirst` corre DESPUÉS de que el barrido cargue la tabla y ANTES
 *  del primer reporte. */
const script: {
  reports: ReportedSubscription[];
  beforeFirst?: () => Promise<void>;
} = { reports: [] };

const paddleDouble = {
  subscriptions: {
    list: () => ({
      async *[Symbol.asyncIterator](): AsyncIterator<ReportedSubscription> {
        if (script.beforeFirst) await script.beforeFirst();
        for (const report of script.reports) yield report;
      },
    }),
  },
};

function reported(email: string, overrides: Partial<ReportedSubscription> = {}): ReportedSubscription {
  return { id: "sub_prueba", status: "active", customData: { email }, ...overrides };
}

function workerConfig(databaseUrl: string): WorkerConfig {
  return {
    databaseUrl,
    poolMax: 1,
    posthogApiKey: undefined,
    posthogHost: "https://us.i.posthog.com",
    paddleApiKey: "pdl_apikey_de_pruebas",
    paddleEnvironment: "sandbox",
    reconcileApply: true,
    reconcileDeadlineMs: 20_000,
  };
}

/** Suministra `API_CONFIG` como lo hace `WorkerConfigModule`: global y
 *  EXPORTADO. Se pasa el MISMO objeto para poder mutar `reconcileApply` en la
 *  fila 27 sin reconstruir el contenedor. */
function stubWorkerConfigModule(config: WorkerConfig) {
  @Global()
  @Module({ providers: [{ provide: API_CONFIG, useValue: config }], exports: [API_CONFIG] })
  class StubWorkerConfigModule {}

  return StubWorkerConfigModule;
}

async function buildWorkerContainer(config: WorkerConfig): Promise<TestingModule> {
  const moduleRef = await Test.createTestingModule({
    imports: [stubWorkerConfigModule(config), DrizzleModule, ReconcileModule],
  })
    .overrideProvider(PADDLE_CLIENT)
    .useValue(paddleDouble)
    .compile();

  // TRAMPA, Y ES LA QUE HACE QUE LA FILA 34 SIGNIFIQUE ALGO: `compile()` llama a
  // `Logger.overrideLogger(new TestingLogger())`
  // (`@nestjs/testing/testing-module.builder.js:128`), y ese logger ANULA `log`,
  // `warn`, `debug` y `verbose` — solo deja pasar `error`. El resumen de la
  // pasada es un `log` y la línea de `pendiente_revocacion` un `warn`, así que
  // sin devolver aquí un logger de verdad la fila 34 pasaría por vacuidad: "la
  // salida no contiene `@`" es trivialmente cierto cuando no hay salida.
  //
  // (Las filas 31 y 40 de PRD-003 §9 no tienen este problema porque afirman
  // sobre un `error`, que `TestingLogger` sí reenvía, y además exigen ver
  // `code=ECONNREFUSED` — una afirmación positiva que un logger mudo rompería.)
  //
  // `Logger.overrideLogger` es global, así que esto vale para todo el fichero.
  Logger.overrideLogger(new ConsoleLogger());
  return moduleRef;
}

describe("el barrido contra base real", () => {
  let moduleRef: TestingModule;
  let service: ReconcileService;
  let config: WorkerConfig;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    const databaseUrl = requireTestDatabaseUrl();
    migrateTestDatabase(databaseUrl);

    pool = new Pool({ connectionString: databaseUrl });
    db = drizzle(pool, { schema });

    config = workerConfig(databaseUrl);
    moduleRef = await buildWorkerContainer(config);
    service = moduleRef.get(ReconcileService);
  });

  afterAll(async () => {
    await moduleRef?.close();
    await pool?.end();
  });

  beforeEach(async () => {
    script.reports = [];
    script.beforeFirst = undefined;
    config.reconcileApply = true;
    await db.delete(schema.subscriptions);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Fila de `subscriptions` por correo exacto (sensible a mayúsculas, como la
   *  columna). */
  async function rowFor(email: string) {
    const rows = await db
      .select()
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.email, email));
    return rows[0];
  }

  async function insertRow(values: {
    email: string;
    status: "trial" | "active" | "canceled";
    trialEndsAt?: Date | null;
    paddleSubscriptionId?: string | null;
  }) {
    await db.insert(schema.subscriptions).values({
      email: values.email,
      status: values.status,
      trialEndsAt: values.trialEndsAt ?? null,
      paddleSubscriptionId: values.paddleSubscriptionId ?? null,
      updatedAt: new Date(),
    });
  }

  // -------------------------------------------------------------------------
  // Fila 19 — emparejamiento insensible a mayúsculas
  // -------------------------------------------------------------------------
  it("fila 19: repara la fila con mayúsculas, la conserva y no crea una segunda", async () => {
    // Es el escenario de §1: `billing` pasa el correo de Paddle a minúsculas y el
    // camino del tutor no transforma el del token, así que la fila que el tutor
    // lee puede ser la de mayúsculas mientras el webhook escribe otra.
    await insertRow({ email: MIXED, status: "trial", trialEndsAt: new Date(Date.now() - DAY_MS) });
    script.reports = [reported(LOWER, { id: "sub_activa" })];

    const counters = await service.run();

    const mixed = await rowFor(MIXED);
    expect(mixed.status).toBe("active");
    // El correo NUNCA se reescribe: es la llave del emparejamiento, no un dato
    // que el barrido normalice.
    expect(mixed.email).toBe(MIXED);
    expect(mixed.paddleSubscriptionId).toBe("sub_activa");
    // Y no ha aparecido una fila en minúsculas al lado.
    expect(await db.select().from(schema.subscriptions)).toHaveLength(1);
    expect(counters).toMatchObject({ repaired: 1, ambiguous: 0 });
  });

  // -------------------------------------------------------------------------
  // Fila 20 — dos filas para el mismo correo
  // -------------------------------------------------------------------------
  it("fila 20: con dos filas del mismo correo, AMBAS quedan `active` y `ambiguo=1`", async () => {
    // No se elige una: son la misma persona, y cuál lee el tutor depende de las
    // mayúsculas del token, que no son observables desde aquí (§6.4).
    await insertRow({ email: MIXED, status: "trial", trialEndsAt: new Date(Date.now() - DAY_MS) });
    await insertRow({ email: LOWER, status: "active" });
    script.reports = [reported(LOWER)];

    const counters = await service.run();

    const mixed = await rowFor(MIXED);
    const lower = await rowFor(LOWER);
    expect(mixed.status).toBe("active");
    expect(lower.status).toBe("active");
    expect(counters).toMatchObject({ ambiguous: 1, repaired: 1 });
    // Lo que el PRD promete de verdad: el acceso por el correo con mayúsculas
    // —el que lee el tutor— pasa a permitido.
    expect(evaluate(mixed)).toMatchObject({ allowed: true, status: "active" });
  });

  // -------------------------------------------------------------------------
  // Fila 21 — alta sin fila previa
  // -------------------------------------------------------------------------
  it("fila 21: un `active` sin fila se inserta EN MINÚSCULAS con su identificador", async () => {
    script.reports = [reported(MIXED, { id: "sub_alta" })];

    const counters = await service.run();

    // El correo se normaliza en `reconcilerEmailFromCustomData`, que es el mismo
    // extractor del webhook: la fila nueva nace con la misma forma que la que
    // habría creado un evento.
    const inserted = await rowFor(LOWER);
    expect(inserted.status).toBe("active");
    expect(inserted.paddleSubscriptionId).toBe("sub_alta");
    expect(await rowFor(MIXED)).toBeUndefined();
    expect(counters).toMatchObject({ repaired: 1, divergences: 1 });
  });

  // -------------------------------------------------------------------------
  // Fila 22 — alta que carrera con el webhook
  // -------------------------------------------------------------------------
  it("fila 22: si la fila aparece entre la carga y la escritura, el alta degrada a UPDATE", async () => {
    // `subscriptions.email` es `.unique()`: un INSERT pelado lanzaría violación
    // de unicidad y tumbaría la pasada entera. Por eso el alta usa
    // `upsertStatus` (§6.5).
    script.reports = [reported(LOWER, { id: "sub_carrera" })];
    script.beforeFirst = async () => {
      await insertRow({ email: LOWER, status: "trial", trialEndsAt: new Date(Date.now() + DAY_MS) });
    };

    const counters = await service.run();

    const row = await rowFor(LOWER);
    expect(row.status).toBe("active");
    expect(await db.select().from(schema.subscriptions)).toHaveLength(1);
    expect(counters).toMatchObject({ repaired: 1, outOfSync: 0 });
  });

  it("fila 22: y si la fila que apareció es `canceled`, el predicado NO la pisa", async () => {
    // La otra mitad de §6.5: una fila creada por el webhook con `canceled` es un
    // dato MÁS FRESCO. Pisarla con `active` la dejaría así para siempre, porque
    // el barrido nunca revoca.
    script.reports = [reported(LOWER, { id: "sub_carrera" })];
    script.beforeFirst = async () => {
      await insertRow({ email: LOWER, status: "canceled" });
    };

    const counters = await service.run();

    expect((await rowFor(LOWER)).status).toBe("canceled");
    expect(counters).toMatchObject({ repaired: 0, outOfSync: 1 });
  });

  // -------------------------------------------------------------------------
  // Fila 23 — compare-and-set
  // -------------------------------------------------------------------------
  it("fila 23: si la fila cambió tras la carga, la escritura afecta cero filas", async () => {
    await insertRow({ email: LOWER, status: "trial", trialEndsAt: new Date(Date.now() - DAY_MS) });
    script.reports = [reported(LOWER)];
    script.beforeFirst = async () => {
      // El webhook escribe `canceled` en la ventana entre la carga y la escritura.
      await db
        .update(schema.subscriptions)
        .set({ status: "canceled", updatedAt: new Date() })
        .where(eq(schema.subscriptions.email, LOWER));
    };

    const counters = await service.run();

    // No se pisa el valor nuevo. Sin la cláusula, esta fila se quedaría `active`
    // para siempre.
    expect((await rowFor(LOWER)).status).toBe("canceled");
    expect(counters).toMatchObject({ repaired: 0, outOfSync: 1, divergences: 1 });
  });

  // -------------------------------------------------------------------------
  // Fila 24 — fila que Paddle no conoce
  // -------------------------------------------------------------------------
  it("fila 24: una fila cuyo correo no está en la lista queda byte a byte igual", async () => {
    // Solo evidencia positiva (§6.3): una lista incompleta es indistinguible de
    // un "no existe", y con la regla contraria una página fallida dañaría a la
    // escuela entera.
    await insertRow({ email: "ajena@ejemplo.test", status: "trial", trialEndsAt: new Date() });
    const before = await rowFor("ajena@ejemplo.test");
    script.reports = [reported(LOWER)];

    const counters = await service.run();

    // `updated_at` incluido: si el barrido la hubiera "tocado sin cambiarla", el
    // sello delataría la escritura.
    expect(await rowFor("ajena@ejemplo.test")).toEqual(before);
    expect(counters).toMatchObject({ reviewed: 1 });
  });

  // -------------------------------------------------------------------------
  // Fila 25 — lista de Paddle vacía
  // -------------------------------------------------------------------------
  it("fila 25: una respuesta sin suscripciones no cambia nada", async () => {
    await insertRow({ email: LOWER, status: "trial", trialEndsAt: new Date(Date.now() - DAY_MS) });
    const before = await rowFor(LOWER);
    script.reports = [];

    const counters = await service.run();

    expect(await rowFor(LOWER)).toEqual(before);
    expect(counters).toMatchObject({ reviewed: 0, repaired: 0, divergences: 0 });
  });

  // -------------------------------------------------------------------------
  // Fila 26 — `trial_ends_at` intacto
  // -------------------------------------------------------------------------
  it("fila 26: reparar a `active` no modifica `trial_ends_at`", async () => {
    const trialEndsAt = new Date(Date.now() - 3 * DAY_MS);
    await insertRow({ email: LOWER, status: "trial", trialEndsAt });
    script.reports = [reported(LOWER)];

    await service.run();

    const row = await rowFor(LOWER);
    expect(row.status).toBe("active");
    expect(row.trialEndsAt?.getTime()).toBe(trialEndsAt.getTime());
  });

  // -------------------------------------------------------------------------
  // Fila 27 — modo sin escritura contra base real
  // -------------------------------------------------------------------------
  it("fila 27: sin `RECONCILE_APPLY`, ninguna fila cambia", async () => {
    config.reconcileApply = false;
    await insertRow({ email: LOWER, status: "trial", trialEndsAt: new Date(Date.now() - DAY_MS) });
    const before = await rowFor(LOWER);
    script.reports = [reported(LOWER), reported("sinfila@ejemplo.test", { id: "sub_alta" })];

    const counters = await service.run();

    expect(await rowFor(LOWER)).toEqual(before);
    // Ni siquiera el alta: el modo sin escritura no escribe por ninguna vía.
    expect(await db.select().from(schema.subscriptions)).toHaveLength(1);
    expect(counters).toMatchObject({ repaired: 0, divergences: 2 });
  });

  // -------------------------------------------------------------------------
  // Fila 28 — idempotencia
  // -------------------------------------------------------------------------
  it("fila 28: dos pasadas seguidas dejan el mismo estado y la segunda repara cero", async () => {
    // La primera pasada con escritura ES el backfill (§10): tiene que poder
    // repetirse sin efecto acumulado.
    await insertRow({ email: MIXED, status: "trial", trialEndsAt: new Date(Date.now() - DAY_MS) });
    script.reports = [reported(LOWER), reported("nueva@ejemplo.test", { id: "sub_nueva" })];

    const first = await service.run();
    const afterFirst = await db.select().from(schema.subscriptions).orderBy(schema.subscriptions.email);

    const second = await service.run();
    const afterSecond = await db.select().from(schema.subscriptions).orderBy(schema.subscriptions.email);

    expect(first.repaired).toBe(2);
    expect(second.repaired).toBe(0);
    expect(second.divergences).toBe(0);
    expect(afterSecond).toEqual(afterFirst);
  });

  // -------------------------------------------------------------------------
  // Fila 29 — fallo de escritura a mitad de barrido
  // -------------------------------------------------------------------------
  it("fila 29: fallando la segunda de tres, la primera persiste y la pasada propaga", async () => {
    // No hay transacción sobre el barrido (§8.4): una sobre la tabla que sirve el
    // acceso se mantendría abierta toda la pasada. Se acepta porque la pasada es
    // idempotente incluso bajo concurrencia.
    const emails = ["uno@ejemplo.test", "dos@ejemplo.test", "tres@ejemplo.test"];
    for (const email of emails) {
      await insertRow({ email, status: "trial", trialEndsAt: new Date(Date.now() - DAY_MS) });
    }
    script.reports = emails.map((email, n) => reported(email, { id: `sub_${n}` }));

    const repository = moduleRef.get(SubscriptionsRepository);
    const real = repository.updateStatusIfUnchanged.bind(repository);
    let calls = 0;
    const spy = vi
      .spyOn(repository, "updateStatusIfUnchanged")
      .mockImplementation(async (...args: Parameters<typeof real>) => {
        calls++;
        if (calls === 2) throw Object.assign(new Error("fallo simulado"), { code: "58000" });
        return real(...args);
      });

    await expect(service.run()).rejects.toThrow("fallo simulado");

    expect((await rowFor(emails[0])).status).toBe("active");
    expect((await rowFor(emails[1])).status).toBe("trial");
    expect((await rowFor(emails[2])).status).toBe("trial");

    // Y una segunda pasada completa el resto.
    spy.mockRestore();
    const counters = await service.run();
    expect(counters.repaired).toBe(2);
    for (const email of emails) expect((await rowFor(email)).status).toBe("active");
  });

  // -------------------------------------------------------------------------
  // Fila 34 — los logs de la pasada buena no llevan correos
  // -------------------------------------------------------------------------
  it("fila 34: la salida de una pasada con divergencias no contiene `@`", async () => {
    await insertRow({ email: MIXED, status: "trial", trialEndsAt: new Date(Date.now() - DAY_MS) });
    await insertRow({ email: "cancelada@ejemplo.test", status: "active" });
    script.reports = [
      reported(LOWER),
      reported("cancelada@ejemplo.test", { id: "sub_cancelada", status: "canceled" }),
      reported("nueva@ejemplo.test", { id: "sub_nueva" }),
      reported("rara@ejemplo.test", { id: "sub_rara", status: "estado_del_futuro" }),
    ];

    const output = captureOutput();
    let written = "";
    let counters;
    try {
      counters = await service.run();
    } finally {
      written = output.stop();
    }

    // Ni entero, ni truncado, ni hasheado (§8.2). El único identificador que sí
    // aparece es `paddle_subscription_id`, que es un seudónimo re-identificable
    // con acceso al panel de Paddle — no un dato anónimo.
    expect(written).not.toContain("@");
    expect(written).toContain("sub_cancelada");
    expect(written).toContain(`revisadas=${counters.reviewed}`);
  });
});

// ---------------------------------------------------------------------------
// Filas 30 y 31 — fugas por errores REALES de Postgres
// ---------------------------------------------------------------------------
describe("los errores de base no dejan el correo en los logs", () => {
  let moduleRef: TestingModule;
  let service: ReconcileService;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let databaseUrl: string;

  beforeAll(async () => {
    databaseUrl = requireTestDatabaseUrl();
    migrateTestDatabase(databaseUrl);
    pool = new Pool({ connectionString: databaseUrl });
    db = drizzle(pool, { schema });
  });

  afterAll(async () => {
    await moduleRef?.close();
    await pool?.end();
  });

  beforeEach(async () => {
    script.reports = [];
    script.beforeFirst = undefined;
    await db.delete(schema.subscriptions);
    // Contenedor propio por test: la fila 30 CIERRA el pool inyectado, y un pool
    // cerrado no se reabre.
    await moduleRef?.close();
    moduleRef = await buildWorkerContainer(workerConfig(databaseUrl));
    service = moduleRef.get(ReconcileService);
  });

  // -------------------------------------------------------------------------
  // Fila 30 — DrizzleQueryError
  // -------------------------------------------------------------------------
  it("fila 30: un DrizzleQueryError real con el correo entre los parámetros ligados", async () => {
    // `DrizzleQueryError` embebe los parámetros ligados dentro de `message`
    // (`Failed query: … params: …`), y en el alta el primer parámetro ES el
    // correo. Se fuerza cerrando el pool DESPUÉS de que el barrido cargue la
    // tabla: la escritura falla con el error de verdad, no con uno fabricado.
    script.reports = [reported(LOWER, { id: "sub_alta" })];
    script.beforeFirst = async () => {
      await moduleRef.get<Pool>(PG_POOL).end();
    };

    const output = captureOutput();
    let duringRun = "";
    let caught: unknown;
    try {
      await service.run();
    } catch (err: unknown) {
      caught = err;
    } finally {
      duringRun = output.stop();
    }

    // 1. El riesgo es real: el error SÍ lleva el correo.
    expect(String((caught as Error).message)).toContain(LOWER);
    // 2. Y aun así no llegó a la salida durante la pasada…
    expect(duringRun).not.toContain("@");

    // 3. …ni llega cuando el worker lo registra, que es lo que ocurre en
    //    producción: `main()` lo pasa por aquí y por ningún otro sitio.
    const afterLog = captureOutput();
    writeWorkerFailure("la pasada falló", caught);
    const logged = afterLog.stop();

    expect(logged).not.toContain("@");
    expect(logged).toContain("name=");
  });

  // -------------------------------------------------------------------------
  // Fila 31 — DatabaseError de `pg` sin envolver
  // -------------------------------------------------------------------------
  it("fila 31: un DatabaseError de `pg` cuyo `detail` lleva `Key (email)=(…)`", async () => {
    // Sin envolver a propósito: es la forma que llega al listener `error` del
    // pool y a cualquier `catch` que no pase por drizzle. `code` (el SQLSTATE)
    // vive junto a `detail`, `where`, `table` y `column` en el mismo objeto, así
    // que la allowlist POR CAMPO es lo único que separa `23505` del correo.
    await pool.query("INSERT INTO subscriptions (email) VALUES ($1)", [LOWER]);

    let caught: unknown;
    try {
      await pool.query("INSERT INTO subscriptions (email) VALUES ($1)", [LOWER]);
    } catch (err: unknown) {
      caught = err;
    }

    expect(String((caught as { detail?: string }).detail)).toContain(LOWER);

    const output = captureOutput();
    writeWorkerFailure("la pasada falló", caught);
    const logged = output.stop();

    expect(logged).not.toContain("@");
    expect(logged).toContain("code=23505");
  });
});
