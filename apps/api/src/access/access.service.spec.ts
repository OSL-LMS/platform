// Paridad del dominio de acceso con `src/lib/access.ts`: mismos estados,
// mismos días de trial, mismo `email` sin transformar (goal 6).
//
// Cubre las filas 13, 14, 15, 16, 17 y 18 de PRD-003 §9.
//
// Mockean el REPOSITORIO vía override de provider: no tocan Postgres.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { Test } from "@nestjs/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AnalyticsService } from "../analytics/analytics.service.ts";
import { ConfigModule } from "../config.module.ts";
import type { Subscription } from "../db/schema.ts";
import { applyApiEnv } from "../../test/helpers.ts";
import { AccessModule } from "./access.module.ts";
import { AccessService } from "./access.service.ts";
import { SubscriptionsRepository } from "./subscriptions.repository.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

function row(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    email: "estudiante@ejemplo.test",
    status: "trial",
    trialEndsAt: new Date(Date.now() + 3 * DAY_MS),
    paddleSubscriptionId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Subscription;
}

let service: AccessService;
let repository: {
  findByEmail: ReturnType<typeof vi.fn>;
  insertTrial: ReturnType<typeof vi.fn>;
  upsertStatus: ReturnType<typeof vi.fn>;
};
let analytics: { track: ReturnType<typeof vi.fn> };

beforeAll(() => {
  applyApiEnv();
});

beforeEach(async () => {
  repository = {
    findByEmail: vi.fn(),
    insertTrial: vi.fn(),
    upsertStatus: vi.fn(),
  };
  analytics = { track: vi.fn() };

  const moduleRef = await Test.createTestingModule({ imports: [ConfigModule, AccessModule] })
    .overrideProvider(SubscriptionsRepository)
    .useValue(repository)
    .overrideProvider(AnalyticsService)
    .useValue(analytics)
    .compile();

  service = moduleRef.get(AccessService);
});

describe("AccessService", () => {
  // -------------------------------------------------------------------------
  // Fila 13 — sin fila, acceso "none"
  // -------------------------------------------------------------------------
  it("fila 13: sin fila devuelve {allowed:true, status:'none'} y no crea trial", async () => {
    repository.findByEmail.mockResolvedValue(undefined);

    // Entrar a mirar NO gasta la prueba: lo que se cobra es hablar con el tutor.
    await expect(service.getAccess("estudiante@ejemplo.test")).resolves.toEqual({
      allowed: true,
      status: "none",
      trialDaysLeft: null,
    });
    expect(repository.insertTrial).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Fila 14 — trial vigente devuelve días restantes
  // -------------------------------------------------------------------------
  it("fila 14: un trial vigente devuelve los días restantes con Math.ceil", async () => {
    // 2 días y pico → 3, igual que `access.ts:34`.
    repository.findByEmail.mockResolvedValue(
      row({ status: "trial", trialEndsAt: new Date(Date.now() + 2 * DAY_MS + 60_000) })
    );

    await expect(service.getAccess("estudiante@ejemplo.test")).resolves.toEqual({
      allowed: true,
      status: "trial",
      trialDaysLeft: 3,
    });
  });

  // -------------------------------------------------------------------------
  // Fila 15 — trial vencido
  // -------------------------------------------------------------------------
  it("fila 15: un trial vencido cierra el acceso", async () => {
    repository.findByEmail.mockResolvedValue(
      row({ status: "trial", trialEndsAt: new Date(Date.now() - DAY_MS) })
    );

    await expect(service.getAccess("estudiante@ejemplo.test")).resolves.toEqual({
      allowed: false,
      status: "trial",
      trialDaysLeft: 0,
    });
  });

  // -------------------------------------------------------------------------
  // Fila 16 — canceled
  // -------------------------------------------------------------------------
  it("fila 16: canceled cierra el acceso", async () => {
    repository.findByEmail.mockResolvedValue(row({ status: "canceled", trialEndsAt: null }));

    await expect(service.getAccess("estudiante@ejemplo.test")).resolves.toEqual({
      allowed: false,
      status: "canceled",
      trialDaysLeft: 0,
    });
  });

  // -------------------------------------------------------------------------
  // Fila 17 — active
  // -------------------------------------------------------------------------
  it("fila 17: active abre el acceso con trialDaysLeft null", async () => {
    repository.findByEmail.mockResolvedValue(row({ status: "active", trialEndsAt: null }));

    await expect(service.getAccess("estudiante@ejemplo.test")).resolves.toEqual({
      allowed: true,
      status: "active",
      trialDaysLeft: null,
    });
  });

  // -------------------------------------------------------------------------
  // Fila 18 — el email del token se usa SIN transformar
  // -------------------------------------------------------------------------
  it("fila 18: el email del token no se pasa a minúsculas en el camino de acceso", async () => {
    // La asimetría con el `.toLowerCase()` del webhook (fila 33) es deliberada y
    // PREEXISTENTE (§6). Añadir aquí un `.toLowerCase()` al ver la asimetría es
    // exactamente lo que haría un implementador razonable, y sería un cambio de
    // comportamiento observable que merece su propio PRD.
    const mixed = "Estudiante@X.com";
    repository.findByEmail.mockResolvedValue(undefined);
    repository.insertTrial.mockResolvedValue(row({ email: mixed }));

    await service.getAccess(mixed);
    expect(repository.findByEmail).toHaveBeenCalledWith(mixed);

    repository.findByEmail.mockClear();
    await service.ensureTrial(mixed);
    expect(repository.findByEmail).toHaveBeenCalledWith(mixed);
    expect(repository.insertTrial).toHaveBeenCalledWith(mixed, expect.any(Date));
    expect(analytics.track).toHaveBeenCalledWith(mixed, "trial_started", { trial_days: 7 });
  });

  // -------------------------------------------------------------------------
  // Paridad de `ensureTrial` que las filas de arriba no cubren
  // -------------------------------------------------------------------------
  it("ensureTrial crea el trial de 7 días y emite un solo evento", async () => {
    repository.findByEmail.mockResolvedValue(undefined);
    const created = row({ status: "trial", trialEndsAt: new Date(Date.now() + 7 * DAY_MS) });
    repository.insertTrial.mockResolvedValue(created);

    await expect(service.ensureTrial("estudiante@ejemplo.test")).resolves.toEqual({
      allowed: true,
      status: "trial",
      trialDaysLeft: 7,
    });
    expect(analytics.track).toHaveBeenCalledTimes(1);
  });

  it("ensureTrial con fila existente no reinserta ni reemite", async () => {
    repository.findByEmail.mockResolvedValue(row({ status: "active", trialEndsAt: null }));

    await expect(service.ensureTrial("estudiante@ejemplo.test")).resolves.toEqual({
      allowed: true,
      status: "active",
      trialDaysLeft: null,
    });
    expect(repository.insertTrial).not.toHaveBeenCalled();
    expect(analytics.track).not.toHaveBeenCalled();
  });

  it("ensureTrial que pierde la carrera relee la fila y NO emite evento", async () => {
    // `onConflictDoNothing().returning()` vacío: la fila la creó el request que
    // ganó, y ese ya emitió el evento. Un trial, un evento.
    const winner = row({ status: "trial", trialEndsAt: new Date(Date.now() + 7 * DAY_MS) });
    repository.findByEmail.mockResolvedValueOnce(undefined).mockResolvedValueOnce(winner);
    repository.insertTrial.mockResolvedValue(undefined);

    await expect(service.ensureTrial("estudiante@ejemplo.test")).resolves.toEqual({
      allowed: true,
      status: "trial",
      trialDaysLeft: 7,
    });
    expect(analytics.track).not.toHaveBeenCalled();
    expect(repository.findByEmail).toHaveBeenCalledTimes(2);
  });

  it("setSubscriptionStatus sin id de Paddle no pisa el guardado", async () => {
    await service.setSubscriptionStatus("estudiante@ejemplo.test", "canceled");

    expect(repository.upsertStatus).toHaveBeenCalledWith("estudiante@ejemplo.test", {
      status: "canceled",
      updatedAt: expect.any(Date),
    });
  });

  it("setSubscriptionStatus con id de Paddle lo escribe", async () => {
    await service.setSubscriptionStatus("estudiante@ejemplo.test", "active", "sub_123");

    expect(repository.upsertStatus).toHaveBeenCalledWith("estudiante@ejemplo.test", {
      status: "active",
      updatedAt: expect.any(Date),
      paddleSubscriptionId: "sub_123",
    });
  });
});
