// Límite de tasa (ver `src/throttle.ts` y `src/common/bridge-throttler.guard.ts`).
//
// Cubre la fila 31 de PRD-005 §9.
//
// DOS BLOQUES CON BASES DISTINTAS, y la diferencia no es pereza. El de
// `/v1/access*` NO toca Postgres —usa `DEAD_DATABASE_URL`, porque sus
// afirmaciones se cumplen en caminos que nunca abren conexión: un 401 no llega
// a la base (goal 3 de PRD-003) y /health tampoco (§5.2)—. El del tutor sí la
// necesita: la fila 31 exige un **200** con la segunda credencial, y un 200 del
// turno pasa por `ensureTrial`, por `conversations` y por el currículo. Con la
// base muerta ese 200 sería un 500 y la fila probaría otra cosa.
//
// Regla de código: identificadores en inglés, comentarios en español.

import type Anthropic from "@anthropic-ai/sdk";
import { Test } from "@nestjs/testing";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AnalyticsService } from "../src/analytics/analytics.service.ts";
import { AppModule } from "../src/app.module.ts";
import * as schema from "../src/db/schema.ts";
import { DEFAULT_THROTTLE, TUTOR_TURNS_PER_MINUTE } from "../src/throttle.ts";
import { ANTHROPIC_CLIENT, type TutorStream } from "../src/tutor/anthropic.client.ts";
import {
  applyApiEnv,
  migrateTestDatabase,
  requireTestDatabaseUrl,
  sessionToken,
  startApp,
  stopApp,
  type RunningApp,
} from "./helpers.ts";

const { limit } = DEFAULT_THROTTLE;

/** Peticiones en serie, devolviendo la lista de códigos. En serie y no en
 *  paralelo a propósito: el contador del throttler es un `Map` en memoria y con
 *  peticiones concurrentes el orden de incremento no está garantizado, así que
 *  "la número N+1 es la que corta" dejaría de ser una afirmación estable. */
async function burst(url: string, times: number, headers?: HeadersInit): Promise<number[]> {
  const codes: number[] = [];
  for (let i = 0; i < times; i++) {
    const res = await fetch(url, headers ? { headers } : undefined);
    codes.push(res.status);
  }
  return codes;
}

describe("límite de tasa", () => {
  let running: RunningApp;
  let accessUrl: string;

  beforeAll(async () => {
    applyApiEnv();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    running = await startApp(moduleRef);
    accessUrl = `${running.baseUrl}/v1/access`;
  });

  afterAll(async () => {
    await stopApp(running?.app);
  });

  it("sin credencial cuenta por IP y corta ANTES de autenticar", async () => {
    // Cada una respondería 401. Que la que sobra devuelva 429 y no 401 es lo
    // que demuestra que el guard de tasa corre por delante del de sesión — si
    // se invirtieran, un flujo anónimo pagaría la verificación del token en
    // cada petición antes de ser rechazado, que es justo el trabajo que este
    // límite existe para no hacer.
    const codes = await burst(accessUrl, limit + 1);

    expect(codes.slice(0, limit).every((c) => c === 401)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });

  it("cuenta por credencial: agotar el cubo de un token no toca el de otro", async () => {
    // La afirmación que sostiene todo el diseño. El único llamante de
    // /v1/access* es el servidor de Next, así que todos los estudiantes
    // comparten IP de origen; si el contador fuera por IP, la última línea
    // vería un 429 y en producción un estudiante agotaría la cuota de todos.
    // Los tokens son basura a propósito: lo que se prueba es la CLAVE del
    // contador, no la sesión.
    const exhausted = await burst(accessUrl, limit + 1, { authorization: "Bearer estudiante-a" });
    expect(exhausted.at(-1)).toBe(429);

    const otherStudent = await burst(accessUrl, 1, { authorization: "Bearer estudiante-b" });
    expect(otherStudent).toEqual([401]);
  });

  it("no corta /health, que es lo que sondea Railway", async () => {
    const codes = await burst(`${running.baseUrl}/health`, limit + 20);

    expect(codes.every((c) => c === 200)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fila 31 de PRD-005 — la cota propia del tutor
// ---------------------------------------------------------------------------

/** Doble mínimo de Anthropic: un delta y a cerrar. Aquí no se mide el stream,
 *  se mide el contador — pero el turno tiene que llegar a 200 de verdad. */
const anthropicDouble = {
  messages: {
    stream(): TutorStream {
      return {
        abort() {},
        async *[Symbol.asyncIterator]() {
          yield {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "ok" },
          } as Anthropic.MessageStreamEvent;
        },
      };
    },
  },
};

describe("límite de tasa del tutor", () => {
  let running: RunningApp;
  let turnUrl: string;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let token: string;
  let otherToken: string;

  const STUDENT = "tasa-uno@ejemplo.test";
  const OTHER = "tasa-dos@ejemplo.test";

  beforeAll(async () => {
    const databaseUrl = requireTestDatabaseUrl();
    migrateTestDatabase(databaseUrl);
    applyApiEnv({ DATABASE_URL: databaseUrl });

    pool = new Pool({ connectionString: databaseUrl });
    db = drizzle(pool, { schema });

    await db.delete(schema.conversations);
    await db.delete(schema.subscriptions);
    await db.delete(schema.users);
    await db.insert(schema.users).values([
      { id: "tasa-1", email: STUDENT },
      { id: "tasa-2", email: OTHER },
    ]);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ANTHROPIC_CLIENT)
      .useValue(anthropicDouble)
      .overrideProvider(AnalyticsService)
      .useValue({ track: () => {} })
      .compile();

    running = await startApp(moduleRef);
    turnUrl = `${running.baseUrl}/v1/tutor/turn`;

    token = await sessionToken({ id: "tasa-1", email: STUDENT });
    otherToken = await sessionToken({ id: "tasa-2", email: OTHER });
  });

  afterAll(async () => {
    await stopApp(running?.app);
    await pool?.end();
  });

  /** Un turno completo, leyendo el cuerpo: sin consumirlo, la conexión queda
   *  abierta y el siguiente `fetch` puede reordenarse contra el contador. */
  async function turn(bearer: string): Promise<number> {
    const response = await fetch(turnUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "hola" }),
    });
    await response.text();
    return response.status;
  }

  it("fila 31: el turno 11 en un minuto con el mismo Bearer es 429; con otro Bearer es 200", async () => {
    // La cota del tutor es la MÁS BAJA del servicio (10/min contra 120/min del
    // resto) y por una razón que no comparte con nadie: cada petición aquí cuesta
    // una llamada FACTURADA a Anthropic. El decorador tiene que ser
    // `@Throttle({ default: … })` — el throttler está registrado sin nombre, así
    // que `@Throttle(TUTOR_THROTTLE)` a secas no sobrescribiría nada y el
    // endpoint se quedaría con los 120/min globales sin que nada se pusiera rojo.
    const codes: number[] = [];
    for (let i = 0; i < TUTOR_TURNS_PER_MINUTE; i++) codes.push(await turn(token));

    expect(codes.every((c) => c === 200), `los primeros 10 deberían ser 200: ${codes}`).toBe(true);
    expect(await turn(token)).toBe(429);

    // Y el cubo es POR CREDENCIAL: el estudiante de al lado no paga la cuota del
    // primero. Si el contador fuera por IP, esto sería 429 — y en producción un
    // solo estudiante dejaría a la clase entera sin tutor, porque todas las
    // peticiones llegan desde el servidor de Next con la misma IP de origen.
    expect(await turn(otherToken)).toBe(200);
  }, 60_000);

  it("fila 31: y la cota del tutor NO es la de /v1/access*", async () => {
    // El contraste que hace significativa la fila de arriba: con el mismo Bearer
    // ya agotado en `/v1/tutor/turn`, `/v1/access` sigue respondiendo. Son dos
    // cubos distintos, que es lo que `@Throttle` por controlador compra.
    const response = await fetch(`${running.baseUrl}/v1/access`, {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    await response.text();

    // Y el turno sigue cortado para esa credencial: no se ha reiniciado nada.
    expect(await turn(token)).toBe(429);
  }, 60_000);

  it("los 10 turnos concedidos dejaron su rastro en `conversations`", async () => {
    // Sin esto, un endpoint que devolviera 200 sin hacer nada pasaría la fila 31
    // igual — y "10 turnos concedidos" es justo lo que la cota mide.
    // `vi.waitFor`: §5.2 persiste DESPUÉS de cerrar el stream, así que el último
    // turno concedido puede no haber confirmado su `UPDATE` cuando el cliente ya
    // leyó el cuerpo entero.
    await vi.waitFor(async () => {
      const [row] = await db
        .select({ messages: schema.conversations.messages })
        .from(schema.conversations)
        .where(eq(schema.conversations.userId, "tasa-1"));

      expect(row.messages).toHaveLength(TUTOR_TURNS_PER_MINUTE * 2);
    });
  });
});
