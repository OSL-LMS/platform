// Pool propio de `pg` contra la misma Postgres que usa Next.
//
// `max` explícito a propósito (PRD-003 §6): `src/lib/db.ts` abría el pool sin
// `max`, o sea el defecto de `pg` (10). Con varios procesos contra la misma base
// hay que repartir — desde PRD-004 §7.2 son 8 para Next, 8 para el servicio
// HTTP, 1 para el worker de reconciliación y 3 de margen para `drizzle-kit
// migrate` y los scripts de `scripts/`, que abren sus propias conexiones.
//
// EL NÚMERO SALE DE LA CONFIGURACIÓN INYECTADA, no de una constante de módulo, y
// esta sigue siendo la ÚNICA fábrica de pool del repositorio. Las dos mitades
// son la misma decisión (PRD-004 §7.2): el worker necesita un `max` distinto, y
// dárselo con una segunda fábrica significaría una segunda oportunidad de
// olvidar el listener `error` de abajo — que no tiene test y cuya ausencia mata
// el proceso en silencio. Una fábrica, un listener.
//
// El Pool de `pg` NO conecta hasta la primera consulta, así que construirlo aquí
// no abre nada: es lo que hace cierto el goal 3 (un 401 no toca Postgres) y lo
// que permite que `/health` responda con la base caída.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { Global, Inject, Logger, Module, type OnModuleDestroy } from "@nestjs/common";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { API_CONFIG, type ApiConfig } from "../config.ts";
import { causeCode, errorName } from "../common/error-fields.ts";
import * as schema from "./schema.ts";

/** A nivel de módulo porque la fábrica del pool no tiene `this`. */
const poolLogger = new Logger("DrizzlePool");

export const DRIZZLE = "DRIZZLE";
export const PG_POOL = "PG_POOL";

export type Database = NodePgDatabase<typeof schema>;

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) => {
        const pool = new Pool({
          connectionString: config.databaseUrl,
          max: config.poolMax,
        });

        // `pg` emite `error` cuando se cae un cliente OCIOSO del pool —un
        // reinicio de la base, un corte del proxy—, fuera de cualquier
        // petición. Sin listener, Node lo trata como excepción no capturada y
        // TUMBA EL PROCESO: es el único camino por el que una excepción esquiva
        // el filtro global, porque no nace dentro del ciclo de una petición.
        // Esto es disponibilidad, no PII (ese error no lleva parámetros
        // ligados), pero se registra igual bajo las reglas de §8.
        pool.on("error", (err: unknown) => {
          poolLogger.error(
            `Cliente ocioso del pool caído: name=${errorName(err)} code=${causeCode(err)}`
          );
        });

        return pool;
      },
    },
    {
      provide: DRIZZLE,
      inject: [PG_POOL],
      useFactory: (pool: Pool): Database => drizzle(pool, { schema }),
    },
  ],
  exports: [DRIZZLE, PG_POOL],
})
export class DrizzleModule implements OnModuleDestroy {
  private readonly logger = new Logger(DrizzleModule.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onModuleDestroy(): Promise<void> {
    try {
      await this.pool.end();
    } catch (err: unknown) {
      // Reglas de registro de §8: solo el nombre del error.
      this.logger.error(`Error cerrando el pool: ${errorName(err)}`);
    }
  }
}
