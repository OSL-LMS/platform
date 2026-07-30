// El bloque de temario que acompaña al prompt, resuelto contra `curriculum_nodes`
// (PRD-005 §7).
//
// ES LA ÚNICA PIEZA DEL TUTOR QUE SE DUPLICA EN VEZ DE RE-EXPORTARSE, y la razón
// es concreta: `src/lib/curriculum.ts` importa `./db.ts` (`curriculum.ts:11`), y
// una costura hacia él abriría un TERCER pool de Postgres dentro de este
// proceso. Lo que se duplica son las ~15 líneas de la consulta; el ensamblado
// (`buildForest`) y el recorrido (`lessonContextInputs`) siguen viniendo de la
// raíz por costura, porque componen el texto que entra al bloque de system.
//
// DOS INVARIANTES QUE SE CONSERVAN, LAS DOS DE `curriculum.ts`:
//
//  1. **Sin `lesson` declarada no hay consulta** (`curriculum.ts:173-174`). El
//     selector de lección es opcional en la UI, así que un turno sin lección es
//     un camino corriente, no un caso raro: sin este corto circuito cada uno de
//     esos turnos pasaría de cero consultas a un `SELECT` del currículo entero.
//     Fila 27 de §9.
//  2. **Nunca lanza** (`curriculum.ts:169-181`). Un currículo sin cargar, un
//     slug inexistente o un fallo de Postgres devuelven el par vacío, que es la
//     rama "el estudiante no ha declarado lección" — el tutor pregunta. Un 500
//     aquí tumbaría el turno entero por no poder decorarlo. Fila 26 de §9.
//
// SIN CACHÉ, a diferencia de la raíz (`unstable_cache` a 600 s más un `lastKnown`
// por proceso, `curriculum.ts:77-123`). En apps/api no hay `next/cache` y
// replicar ese par es el trabajo de la fase de `packages/shared`. La consulta es
// un `SELECT` por `curriculum` de unas decenas de filas, una vez por turno CON
// lección declarada, sobre un pool ya abierto.
// ponytail: sin caché; si aparece en las consultas lentas —es la más cara de las tres consultas del turno—, el arreglo es un TTL aquí, no un módulo nuevo. Ver PRD-005 §Design Decisions.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { Inject, Injectable, Logger } from "@nestjs/common";
import { eq } from "drizzle-orm";

import { causeCode, errorName } from "../common/error-fields.ts";
import { API_CONFIG, type ApiConfig } from "../config.ts";
import { DRIZZLE, type Database } from "../db/drizzle.module.ts";
import { curriculumNodes } from "../db/schema.ts";
import { buildForest, lessonContextInputs, type CurriculumNode } from "./curriculum-context.ts";

/** Los dos argumentos que `buildLessonContext` necesita. */
export type LessonContextInputs = {
  moduleLessons: CurriculumNode[];
  ancestors: CurriculumNode[];
};

const EMPTY: LessonContextInputs = { moduleLessons: [], ancestors: [] };

@Injectable()
export class CurriculumRepository {
  private readonly logger = new Logger(CurriculumRepository.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(API_CONFIG) private readonly config: ApiConfig
  ) {}

  /** Las lecciones del módulo de `lessonSlug` (no las del currículo entero) y su
   *  cadena de ancestros. Nunca lanza. */
  async lessonContext(lessonSlug?: string): Promise<LessonContextInputs> {
    // El corto circuito va ANTES del `try`: sin lección no hay nada que
    // consultar, y meterlo dentro invitaría a "aprovechar" la consulta.
    if (!lessonSlug) return EMPTY;

    try {
      // El `curriculum` sale de la CONFIGURACIÓN del servidor y nunca del
      // request: no hay aislamiento entre currículos en la tabla, así que
      // derivarlo de la entrada del estudiante sería dejarle elegir temario.
      const rows = await this.db
        .select()
        .from(curriculumNodes)
        .where(eq(curriculumNodes.curriculum, this.config.curriculumSlug));

      return lessonContextInputs(buildForest(rows), lessonSlug);
    } catch (err: unknown) {
      // Reglas de registro de §8 de PRD-003: solo `name` y `cause.code`.
      this.logger.error(
        `No se pudo componer el contexto de la lección: name=${errorName(err)} code=${causeCode(err)}`
      );
      return EMPTY;
    }
  }
}
