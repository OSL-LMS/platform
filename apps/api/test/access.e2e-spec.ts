// Los endpoints de acceso contra Postgres de verdad.
//
// Cubre las filas 11, 19, 20, 21, 22, 23 y 40 de PRD-003 §9.
//
// ESCRIBEN Y BORRAN en `subscriptions`: exigen `API_TEST_DATABASE_URL` apuntando
// a una base desechable, y abortan si coincide con `DATABASE_URL`.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { Test } from "@nestjs/testing";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AnalyticsService } from "../src/analytics/analytics.service.ts";
import { AppModule } from "../src/app.module.ts";
import * as schema from "../src/db/schema.ts";
import {
  DEAD_DATABASE_URL,
  applyApiEnv,
  captureOutput,
  migrateTestDatabase,
  requireTestDatabaseUrl,
  sessionToken,
  startApp,
  stopApp,
  type RunningApp,
} from "./helpers.ts";

const STUDENT = "Estudiante@Ejemplo.test";
const OTHER_STUDENT = "victima@ejemplo.test";

const analytics = { track: vi.fn() };

function authorized(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

describe("acceso contra base real", () => {
  let running: RunningApp;
  let token: string;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    const databaseUrl = requireTestDatabaseUrl();
    migrateTestDatabase(databaseUrl);

    applyApiEnv({ DATABASE_URL: databaseUrl });

    pool = new Pool({ connectionString: databaseUrl });
    db = drizzle(pool, { schema });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AnalyticsService)
      .useValue(analytics)
      .compile();

    running = await startApp(moduleRef);
    token = await sessionToken({ id: "user-1", email: STUDENT });
  });

  afterAll(async () => {
    await stopApp(running?.app);
    await pool?.end();
  });

  beforeEach(async () => {
    analytics.track.mockClear();
    await db.delete(schema.subscriptions);
  });

  // -------------------------------------------------------------------------
  // Fila 19 — un email suministrado por el llamante se IGNORA
  // -------------------------------------------------------------------------
  it("fila 19: un email por query no lee la fila de otro estudiante", async () => {
    // La víctima paga; el atacante no tiene fila. Si el handler leyera el query
    // string, el atacante vería `active`.
    await db
      .insert(schema.subscriptions)
      .values({ email: OTHER_STUDENT, status: "active", updatedAt: new Date() });

    const response = await fetch(
      `${running.baseUrl}/v1/access?email=${encodeURIComponent(OTHER_STUDENT)}`,
      { headers: authorized(token) }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      allowed: true,
      status: "none",
      trialDaysLeft: null,
    });
  });

  it("fila 19: un email por cuerpo no escribe la fila de otro estudiante", async () => {
    await db
      .insert(schema.subscriptions)
      .values({ email: OTHER_STUDENT, status: "active", updatedAt: new Date() });

    const response = await fetch(`${running.baseUrl}/v1/access/trial`, {
      method: "POST",
      headers: { ...authorized(token), "content-type": "application/json" },
      body: JSON.stringify({ email: OTHER_STUDENT, userId: "otro" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ allowed: true, status: "trial" });

    // La fila de la víctima no se ha tocado…
    const victim = await db
      .select()
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.email, OTHER_STUDENT));
    expect(victim).toHaveLength(1);
    expect(victim[0].status).toBe("active");

    // …y el trial se creó para el correo DEL TOKEN.
    const mine = await db
      .select()
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.email, STUDENT));
    expect(mine).toHaveLength(1);
    expect(mine[0].status).toBe("trial");
  });

  // -------------------------------------------------------------------------
  // Fila 20 — GET /v1/access nunca crea trial
  // -------------------------------------------------------------------------
  it("fila 20: GET /v1/access no deja fila en subscriptions", async () => {
    // La frontera del producto depende de esto: entrar a mirar no gasta la
    // prueba, lo que se cobra es hablar con el tutor.
    const response = await fetch(`${running.baseUrl}/v1/access`, { headers: authorized(token) });
    expect(response.status).toBe(200);

    const rows = await db.select().from(schema.subscriptions);
    expect(rows).toHaveLength(0);
    expect(analytics.track).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Fila 21 — trial concurrente: una fila, un evento
  // -------------------------------------------------------------------------
  it("fila 21: dos POST /v1/access/trial a la vez dejan una fila y un evento", async () => {
    const [a, b] = await Promise.all([
      fetch(`${running.baseUrl}/v1/access/trial`, { method: "POST", headers: authorized(token) }),
      fetch(`${running.baseUrl}/v1/access/trial`, { method: "POST", headers: authorized(token) }),
    ]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    await expect(a.json()).resolves.toMatchObject({ allowed: true, status: "trial" });
    await expect(b.json()).resolves.toMatchObject({ allowed: true, status: "trial" });

    // El árbitro es el UNIQUE(email) y el `returning()` vacío del
    // onConflictDoNothing, no el proceso que atiende.
    const rows = await db.select().from(schema.subscriptions);
    expect(rows).toHaveLength(1);

    // El "un evento" solo es afirmable con AnalyticsService inyectable (§7).
    expect(analytics.track).toHaveBeenCalledTimes(1);
    expect(analytics.track).toHaveBeenCalledWith(STUDENT, "trial_started", { trial_days: 7 });
  });

  // -------------------------------------------------------------------------
  // Fila 22 — trial secuencial no reinserta ni reemite
  // -------------------------------------------------------------------------
  it("fila 22: una segunda llamada a /v1/access/trial no reinserta ni reemite", async () => {
    const first = await fetch(`${running.baseUrl}/v1/access/trial`, {
      method: "POST",
      headers: authorized(token),
    });
    expect(first.status).toBe(200);

    const [created] = await db.select().from(schema.subscriptions);
    expect(analytics.track).toHaveBeenCalledTimes(1);

    // Cubre también el reintento del cliente tras un timeout: idempotente en
    // los dos sentidos de §5.2.
    const second = await fetch(`${running.baseUrl}/v1/access/trial`, {
      method: "POST",
      headers: authorized(token),
    });
    expect(second.status).toBe(200);

    const rows = await db.select().from(schema.subscriptions);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(created.id);
    expect(rows[0].createdAt.getTime()).toBe(created.createdAt.getTime());
    expect(rows[0].trialEndsAt?.getTime()).toBe(created.trialEndsAt?.getTime());
    expect(analytics.track).toHaveBeenCalledTimes(1);
  });

  it("un trial vencido deja de dar acceso sin tocar la fila", async () => {
    await db.insert(schema.subscriptions).values({
      email: STUDENT,
      status: "trial",
      trialEndsAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      updatedAt: new Date(),
    });

    const response = await fetch(`${running.baseUrl}/v1/access`, { headers: authorized(token) });
    await expect(response.json()).resolves.toEqual({
      allowed: false,
      status: "trial",
      trialDaysLeft: 0,
    });
  });
});

describe("acceso con Postgres inalcanzable", () => {
  let running: RunningApp;

  beforeAll(async () => {
    // Puerto muerto, no servicio apagado: la conexión se rechaza al instante.
    applyApiEnv({ DATABASE_URL: DEAD_DATABASE_URL });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AnalyticsService)
      .useValue(analytics)
      .compile();

    running = await startApp(moduleRef);
  });

  afterAll(async () => {
    await stopApp(running?.app);
  });

  // -------------------------------------------------------------------------
  // Fila 11 — un 401 no abre conexión a Postgres
  // -------------------------------------------------------------------------
  it("fila 11: sin token responde 401 aunque la base sea inalcanzable", async () => {
    // Goal 3: el guard corre ANTES que el servicio, así que tráfico sin token no
    // genera carga de base. Si el orden se invirtiera, esto sería un 500.
    const response = await fetch(`${running.baseUrl}/v1/access`);
    expect(response.status).toBe(401);

    const trial = await fetch(`${running.baseUrl}/v1/access/trial`, { method: "POST" });
    expect(trial.status).toBe(401);

    // Y el cuerpo que ve el cliente no publica el código de razón: los cuatro
    // códigos de §8 son para los logs, no para el llamante. Aquí se mira el
    // cuerpo REAL del 401 tal como sale por el cable, no la excepción.
    const body = await response.text();
    for (const reason of ["missing_header", "malformed", "decode_failed", "missing_claims"]) {
      expect(body).not.toContain(reason);
    }
  });

  // -------------------------------------------------------------------------
  // Fila 23 — /health responde 200 y no toca Postgres
  // -------------------------------------------------------------------------
  it("fila 23: GET /health responde 200 con la base caída", async () => {
    // §5.2 prohíbe que consulte la base: es el único endpoint sin token ni
    // firma, y hacerle verificar Postgres entregaría a un llamante anónimo un
    // viaje a la base, vaciando el goal 3.
    const response = await fetch(`${running.baseUrl}/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  // -------------------------------------------------------------------------
  // Fila 40 — un fallo de base en GET /v1/access no filtra el correo al log
  // -------------------------------------------------------------------------
  it("fila 40: un fallo de base en GET /v1/access no filtra el correo al log", async () => {
    // Hermana de la fila 31, por el camino que NO captura: `getAccess` deja que
    // el error suba, así que lo atiende el filtro global. Falla si el filtro
    // delega en `BaseExceptionFilter.super.catch()`, que registra `message` y
    // `stack` — y el mensaje de DrizzleQueryError lleva los parámetros ligados,
    // o sea el correo.
    const leaky = "filtracion.acceso@ejemplo.test";
    const token = await sessionToken({ id: "user-2", email: leaky });

    const capture = captureOutput();
    let output: string;
    let status: number;
    try {
      const response = await fetch(`${running.baseUrl}/v1/access`, { headers: authorized(token) });
      status = response.status;
      await response.text();
    } finally {
      output = capture.stop();
    }

    expect(status).toBe(500);
    expect(output).not.toContain(leaky);
    expect(output).not.toContain("@");
    expect(output).not.toContain("params:");
    // Lo que SÍ se registra: nombre del error y código de la causa.
    expect(output).toContain("code=ECONNREFUSED");
  });
});
