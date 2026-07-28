// Pool propio de `pg` contra la misma Postgres que usa Next.
//
// `max` explícito a propósito (PRD-003 §6): `src/lib/db.ts` abría el pool sin
// `max`, o sea el defecto de `pg` (10). Con dos servicios contra la misma base
// hay que repartir — 8 para Next, 8 aquí, y 4 de margen para `drizzle-kit
// migrate` y los scripts de `scripts/`, que abren sus propias conexiones.
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
import { errorName } from "../common/error-fields.ts";
import * as schema from "./schema.ts";

/** Conexiones reservadas a este servicio. Ver la tabla de §6. */
export const MAX_POOL_CONNECTIONS = 8;

export const DRIZZLE = "DRIZZLE";
export const PG_POOL = "PG_POOL";

export type Database = NodePgDatabase<typeof schema>;

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) =>
        new Pool({ connectionString: config.databaseUrl, max: MAX_POOL_CONNECTIONS }),
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
