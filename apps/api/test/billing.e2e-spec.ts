// El webhook de Paddle bajo NestJS.
//
// Cubre las filas 24, 25, 26, 27, 28, 29, 30, 31, 32 y 33 de PRD-003 §9, y las
// filas 5 y 6 de PRD-004 §9.
//
// El webhook NO lleva sesión: se autentica por firma sobre el body crudo, y por
// eso puede mudarse sin depender del puente de auth. Lo que sí introduce el
// cambio de framework es que `req.rawBody` es un Buffer y `unmarshal` recibe un
// string — la fila 26 es la regresión de ese `.toString("utf8")`.
//
// PRD-004 saca de este controlador el mapa de estados y el extractor de correo
// (`paddle-status.ts`, `paddle-email.ts`) para compartirlos con el
// reconciliador. Las filas 5 y 6 son la regresión de esa extracción: 5 fija que
// los cinco estados del SDK escriban lo mismo que antes por la rama
// `Created/Activated/Updated`, y 6 fija que la rama `SubscriptionCanceled` siga
// SIN mirar `data.status` — es dirigida por evento, y PRD-004 §3 la declara
// fuera de alcance.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { EventName, Webhooks } from "@paddle/paddle-node-sdk";
import { Test } from "@nestjs/testing";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AccessService } from "../src/access/access.service.ts";
import { AnalyticsService } from "../src/analytics/analytics.service.ts";
import { AppModule } from "../src/app.module.ts";
import * as schema from "../src/db/schema.ts";
import {
  DEAD_DATABASE_URL,
  applyApiEnv,
  captureOutput,
  migrateTestDatabase,
  paddleBody,
  paddleSignature,
  postWebhook,
  requireTestDatabaseUrl,
  startApp,
  stopApp,
  type RunningApp,
} from "./helpers.ts";

/** El correo llega mezclado desde `customData` y el webhook lo NORMALIZA. */
const MIXED_CASE_EMAIL = "Estudiante@Ejemplo.test";
const NORMALIZED_EMAIL = "estudiante@ejemplo.test";

const analytics = { track: vi.fn() };

describe("webhook de Paddle contra base real", () => {
  let running: RunningApp;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let access: AccessService;

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

    access = moduleRef.get(AccessService);
    running = await startApp(moduleRef);
  });

  afterAll(async () => {
    await stopApp(running?.app);
    await pool?.end();
  });

  beforeEach(async () => {
    analytics.track.mockClear();
    await db.delete(schema.subscriptions);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Fila 24 — firma inválida
  // -------------------------------------------------------------------------
  it("fila 24: una firma inválida da 400 y no toca la base", async () => {
    const body = paddleBody(EventName.SubscriptionActivated);
    const response = await postWebhook(running.baseUrl, body, "ts=1;h1=deadbeef");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ message: "firma inválida" });
    expect(await db.select().from(schema.subscriptions)).toHaveLength(0);
  });

  it("fila 24: una firma con el secreto equivocado da 400", async () => {
    const body = paddleBody(EventName.SubscriptionActivated);
    const signature = paddleSignature(body, { secret: "otro-secreto-de-notificaciones" });
    const response = await postWebhook(running.baseUrl, body, signature);

    expect(response.status).toBe(400);
    expect(await db.select().from(schema.subscriptions)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Fila 25 — sin evento (guarda DEFENSIVA)
  // -------------------------------------------------------------------------
  it("fila 25: con unmarshal devolviendo nada, la guarda defensiva da 400", async () => {
    // Con @paddle/paddle-node-sdk@3.8.0 pineado esta rama es INALCANZABLE con un
    // cuerpo real firmado: `unmarshal` está tipada `Promise<EventEntity>` sin
    // `| null`, o lanza o devuelve `Webhooks.fromJson(...)`, cuyo `default`
    // devuelve un `GenericEvent`. Por eso se mockea, y por eso esto prueba que
    // la guarda existe — no un comportamiento observable.
    vi.spyOn(Webhooks.prototype, "unmarshal").mockResolvedValue(
      undefined as unknown as Awaited<ReturnType<Webhooks["unmarshal"]>>
    );

    const body = paddleBody(EventName.SubscriptionActivated);
    const response = await postWebhook(running.baseUrl, body, paddleSignature(body));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ message: "sin evento" });
  });

  // -------------------------------------------------------------------------
  // Fila 26 — body crudo preservado bajo NestJS
  // -------------------------------------------------------------------------
  it("fila 26: la firma de un cuerpo real con multibyte verifica", async () => {
    // `req.rawBody` es un Buffer y `unmarshal` recibe un string. Sin el
    // `.toString("utf8")` explícito la firma NO verifica nunca; con caracteres
    // multibyte, además, longitud en bytes ≠ longitud en caracteres, que es
    // donde una conversión descuidada se rompe.
    const body = paddleBody(
      EventName.SubscriptionActivated,
      { id: "sub_ñandú_✓" },
      { email: MIXED_CASE_EMAIL, nombre: "Ángel Kurtén" }
    );

    const response = await postWebhook(running.baseUrl, body, paddleSignature(body));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  // -------------------------------------------------------------------------
  // Fila 27 — SubscriptionActivated sin fila previa hace UPSERT
  // -------------------------------------------------------------------------
  it("fila 27: SubscriptionActivated sin fila previa crea la fila", async () => {
    // El caso que motivó el upsert: checkout público, sin paso previo por el
    // tutor. Un UPDATE a secas afectaría 0 filas en silencio y dejaría a alguien
    // pagando sin acceso.
    const body = paddleBody(EventName.SubscriptionActivated, { id: "sub_activada" });
    const response = await postWebhook(running.baseUrl, body, paddleSignature(body));

    expect(response.status).toBe(200);

    const rows = await db.select().from(schema.subscriptions);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("active");
    expect(rows[0].paddleSubscriptionId).toBe("sub_activada");
    expect(analytics.track).toHaveBeenCalledWith(NORMALIZED_EMAIL, "subscription_activated", {
      paddle_event: EventName.SubscriptionActivated,
    });
  });

  // -------------------------------------------------------------------------
  // Fila 28 — SubscriptionCanceled no pisa el paddle_subscription_id
  // -------------------------------------------------------------------------
  it("fila 28: SubscriptionCanceled cancela sin pisar el paddle_subscription_id", async () => {
    await db.insert(schema.subscriptions).values({
      email: NORMALIZED_EMAIL,
      status: "active",
      paddleSubscriptionId: "sub_original",
      updatedAt: new Date(),
    });

    const body = paddleBody(EventName.SubscriptionCanceled, {
      id: "sub_otro",
      status: "canceled",
    });
    const response = await postWebhook(running.baseUrl, body, paddleSignature(body));

    expect(response.status).toBe(200);

    const rows = await db.select().from(schema.subscriptions);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("canceled");
    // Un evento de cancelación no siempre trae el id: si no se envía, no se pisa.
    expect(rows[0].paddleSubscriptionId).toBe("sub_original");
    expect(analytics.track).toHaveBeenCalledWith(NORMALIZED_EMAIL, "subscription_canceled", {
      paddle_event: EventName.SubscriptionCanceled,
    });
  });

  it("un SubscriptionUpdated con status canceled también cancela", async () => {
    const body = paddleBody(EventName.SubscriptionUpdated, {
      id: "sub_actualizada",
      status: "canceled",
    });
    const response = await postWebhook(running.baseUrl, body, paddleSignature(body));

    expect(response.status).toBe(200);
    const rows = await db.select().from(schema.subscriptions);
    expect(rows[0].status).toBe("canceled");
  });

  // -------------------------------------------------------------------------
  // Fila 29 — error posterior a la firma devuelve 200
  // -------------------------------------------------------------------------
  it("fila 29: un error posterior a la firma devuelve 200 para que Paddle no reintente", async () => {
    // El `catch` del webhook SE CONSERVA a propósito: el 200 que evita el bucle
    // de reintentos de Paddle depende de él. Quitarlo para "dejar que lo maneje
    // el filtro global" haría que Paddle recibiera 500 y reintentara en bucle.
    vi.spyOn(access, "setSubscriptionStatus").mockRejectedValue(new Error("fallo nuestro"));

    const body = paddleBody(EventName.SubscriptionActivated);
    const response = await postWebhook(running.baseUrl, body, paddleSignature(body));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  // -------------------------------------------------------------------------
  // Fila 30 — ventana de frescura de 5 s
  // -------------------------------------------------------------------------
  it("fila 30: una firma con ts 10 s en el pasado da 400", async () => {
    // Fija la ventana de frescura del SDK y hace explícito el modo de fallo por
    // desfase de reloj: un contenedor con el reloj adelantado hace fallar TODOS
    // los webhooks con un 400 indistinguible de un secreto equivocado (§10 paso 4).
    const body = paddleBody(EventName.SubscriptionActivated);
    const response = await postWebhook(
      running.baseUrl,
      body,
      paddleSignature(body, { offsetSeconds: -10 })
    );

    expect(response.status).toBe(400);
    expect(await db.select().from(schema.subscriptions)).toHaveLength(0);
  });

  it("fila 30: dentro de la ventana de 5 s la misma firma verifica", async () => {
    const body = paddleBody(EventName.SubscriptionActivated);
    const response = await postWebhook(
      running.baseUrl,
      body,
      paddleSignature(body, { offsetSeconds: -2 })
    );

    expect(response.status).toBe(200);
  });

  // -------------------------------------------------------------------------
  // Fila 32 — cota de tamaño de cuerpo
  // -------------------------------------------------------------------------
  it("fila 32: un cuerpo por encima de 64kb da 413 antes de verificar firma", async () => {
    // `rawBody: true` almacena el cuerpo ENTERO antes de verificar la firma, en
    // un endpoint que cualquiera alcanza. La cota es de aplicación y no de ruta
    // a propósito (§5.2).
    const oversized = JSON.stringify({ relleno: "x".repeat(70 * 1024) });
    const response = await postWebhook(running.baseUrl, oversized, paddleSignature(oversized));

    expect(response.status).toBe(413);
    expect(await db.select().from(schema.subscriptions)).toHaveLength(0);
  });

  it("fila 32: justo por debajo de la cota el cuerpo sí se procesa", async () => {
    const body = paddleBody(EventName.SubscriptionActivated, {
      relleno: "x".repeat(50 * 1024),
    });
    expect(Buffer.byteLength(body)).toBeLessThan(64 * 1024);

    const response = await postWebhook(running.baseUrl, body, paddleSignature(body));
    expect(response.status).toBe(200);
  });

  // -------------------------------------------------------------------------
  // Fila 33 — el email del webhook SÍ se normaliza
  // -------------------------------------------------------------------------
  it("fila 33: el email del webhook se pasa a minúsculas", async () => {
    // La asimetría con la fila 18 —el camino de acceso NO transforma— es
    // deliberada y preexistente en producción (§6).
    const body = paddleBody(EventName.SubscriptionActivated, {}, { email: MIXED_CASE_EMAIL });
    const response = await postWebhook(running.baseUrl, body, paddleSignature(body));

    expect(response.status).toBe(200);

    const rows = await db
      .select()
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.email, NORMALIZED_EMAIL));
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe(NORMALIZED_EMAIL);
    expect(MIXED_CASE_EMAIL).not.toBe(NORMALIZED_EMAIL);
  });

  it("un evento sin email en customData no escribe nada y sigue devolviendo 200", async () => {
    const body = paddleBody(EventName.SubscriptionActivated, {}, null);
    const response = await postWebhook(running.baseUrl, body, paddleSignature(body));

    expect(response.status).toBe(200);
    expect(await db.select().from(schema.subscriptions)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Fila 5 de PRD-004 — el webhook conserva su comportamiento tras la extracción
  // -------------------------------------------------------------------------
  it("fila 5 (PRD-004): los cinco estados del SDK escriben por Created/Activated/Updated lo mismo que antes", async () => {
    // Antes de la extracción esta rama era `data.status === "canceled"`. Lo que
    // se fija aquí es la tabla de §6.2 EN PRODUCCIÓN, no en el módulo puro: si
    // el mapa y el controlador se desalinean —por ejemplo si alguien decide que
    // un estado sin mapear deje de escribir—, esto es lo que lo ve.
    const expected: Array<[string, "active" | "canceled", string]> = [
      ["active", "active", "subscription_activated"],
      ["trialing", "active", "subscription_activated"],
      // Deuda heredada, declarada en docs/SYSTEM_ARTIFACT.md: se reproduce.
      ["past_due", "active", "subscription_activated"],
      ["paused", "active", "subscription_activated"],
      ["canceled", "canceled", "subscription_canceled"],
    ];

    for (const [paddleStatus, stored, event] of expected) {
      await db.delete(schema.subscriptions);
      analytics.track.mockClear();

      const body = paddleBody(EventName.SubscriptionUpdated, {
        id: "sub_estado",
        status: paddleStatus,
      });
      const response = await postWebhook(running.baseUrl, body, paddleSignature(body));
      expect(response.status, `${paddleStatus} debería procesarse`).toBe(200);

      const rows = await db.select().from(schema.subscriptions);
      expect(rows, `${paddleStatus} debería escribir una fila`).toHaveLength(1);
      expect(rows[0].status, `${paddleStatus} debería quedar como ${stored}`).toBe(stored);
      expect(analytics.track).toHaveBeenCalledWith(NORMALIZED_EMAIL, event, {
        paddle_event: EventName.SubscriptionUpdated,
      });
    }
  });

  it("fila 5 (PRD-004): un estado desconocido sigue cayendo a `active` en el webhook", async () => {
    // El reconciliador toma la decisión CONTRARIA con la misma entrada —no
    // escribe y cuenta `desconocido` (§6.5)—, y esa divergencia es deliberada:
    // el webhook procesa un evento confirmado una vez, el barrido reintenta cada
    // hora. Fijarlo aquí es lo que impide que un refactor "unifique" las dos
    // decisiones creyendo que arregla una inconsistencia.
    const body = paddleBody(EventName.SubscriptionUpdated, {
      id: "sub_desconocida",
      status: "wibble",
    });
    const response = await postWebhook(running.baseUrl, body, paddleSignature(body));

    expect(response.status).toBe(200);
    const rows = await db.select().from(schema.subscriptions);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("active");
  });

  // -------------------------------------------------------------------------
  // Fila 6 de PRD-004 — SubscriptionCanceled ignora el estado
  // -------------------------------------------------------------------------
  it("fila 6 (PRD-004): un subscription.canceled con status active sigue escribiendo canceled", async () => {
    // La rama es dirigida por EVENTO, no por estado: no lee `data.status` y no
    // pasa por el mapa. Es la discriminante que la fila 28 no cubre, porque
    // aquélla manda `status: "canceled"` y pasaría igual si alguien enchufara el
    // mapa aquí por simetría.
    await db.insert(schema.subscriptions).values({
      email: NORMALIZED_EMAIL,
      status: "active",
      updatedAt: new Date(),
    });

    const body = paddleBody(EventName.SubscriptionCanceled, {
      id: "sub_cancelada",
      status: "active",
    });
    const response = await postWebhook(running.baseUrl, body, paddleSignature(body));

    expect(response.status).toBe(200);

    const rows = await db.select().from(schema.subscriptions);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("canceled");
    expect(analytics.track).toHaveBeenCalledWith(NORMALIZED_EMAIL, "subscription_canceled", {
      paddle_event: EventName.SubscriptionCanceled,
    });
  });
});

describe("webhook con Postgres inalcanzable", () => {
  let running: RunningApp;

  beforeAll(async () => {
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
  // Fila 31 — un fallo de base no filtra el correo al log
  // -------------------------------------------------------------------------
  it("fila 31: un fallo de base no filtra el correo al log", async () => {
    // `DrizzleQueryError` embebe los parámetros ligados dentro del mensaje
    // (`Failed query: … params: …`), y ahí va el correo. El `console.error(err)`
    // de la ruta de Next sí lo filtraba a los logs de Railway: la propiedad que
    // este PRD "conserva" nunca existió, se crea aquí.
    const leaky = "filtracion.webhook@ejemplo.test";
    const body = paddleBody(EventName.SubscriptionActivated, {}, { email: leaky });

    const capture = captureOutput();
    let output: string;
    let status: number;
    try {
      const response = await postWebhook(running.baseUrl, body, paddleSignature(body));
      status = response.status;
      await response.text();
    } finally {
      output = capture.stop();
    }

    // 200 igual: el `catch` del webhook evita el bucle de reintentos de Paddle.
    expect(status).toBe(200);
    expect(output).not.toContain(leaky);
    expect(output).not.toContain("@");
    expect(output).not.toContain("params:");
    expect(output).not.toContain("Failed query");
    // Lo que SÍ se registra: nombre del error y código de la causa.
    expect(output).toContain("code=ECONNREFUSED");
  });
});
