// El bloque de temario que acompaña al prompt, resuelto contra `curriculum_nodes`
// (PRD-005 §7). Desde PRD-007 §7.1 vive en `src/curriculum/` y no en `src/tutor/`
// —lo consumen dos módulos— y gana dos métodos que SÍ LANZAN, documentados abajo.
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
import { and, eq, inArray } from "drizzle-orm";

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

/** No se pudo LEER el currículo. Es el 503 `curriculum_unavailable` de PRD-007
 *  §5.1, y existe para poder distinguirlo del 404: `lessonContext()` colapsa las
 *  dos cosas en el par vacío a propósito, y ese contrato se queda atado al turno
 *  del tutor.
 *
 *  ERROR PROPIO DE apps/api, y NO se reutiliza `CurriculumNotLoadedError`
 *  (`packages/shared/src/curriculum.ts:27`): el ámbito de módulo de ese fichero
 *  importa `./db.ts` y construye un `Pool` al cargar — el shim
 *  `curriculum-context.ts` existe precisamente porque importarlo abriría un
 *  TERCER pool de Postgres dentro de este proceso. */
export class CurriculumUnavailableError extends Error {
  override readonly name = "CurriculumUnavailableError";
}

/** Lo que `EvidenceService` necesita de una lección: su identidad estable y el
 *  `payload` donde vive `evidenceKind`. El `slug` no vuelve porque el llamante
 *  ya lo tiene, y guardarlo sería el error que D1 descarta: el `slug` es
 *  mutable por contrato, el `id` es la identidad. */
export type ResolvedLesson = {
  id: string;
  payload: Record<string, unknown>;
};

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

  // -------------------------------------------------------------------------
  // Los dos métodos de PRD-007 §7.1. LANZAN, y esa es su diferencia con el de
  // arriba: §5.1 tiene que distinguir un 404 (la lección no existe) de un 503
  // (el currículo no se pudo leer), y `lessonContext()` colapsa las dos cosas en
  // el par vacío por una invariante que sigue siendo correcta PARA EL TUTOR — un
  // 500 allí tumbaría el turno por no poder decorarlo. El contrato no se hereda.
  // -------------------------------------------------------------------------

  /** El nodo `lesson` de ese `slug`, o `null` si no existe.
   *
   *  CASA SÓLO `kind === "lesson"`, Y NO ES COSMÉTICO. `PAYLOAD_VOCABULARY` está
   *  indexado por `kind` y `checkPayload` sólo recorre el vocabulario de ese
   *  kind (`curriculum-file.ts:349`), así que un `evidenceKind` colgado de un
   *  nodo `stage` o `module` NUNCA pasa por el control de enum:
   *  `{"kind":"stage","payload":{"evidenceKind":"repo"}}` parsea limpio. Un
   *  filtro sólo por slug aceptaría ese nodo y guardaría el id de una etapa en
   *  `lesson_node_id`, para un tipo de evidencia que este PRD no implementa —
   *  y contestaría 409 "esta lección no pide evidencia" donde toca un 404.
   *  Fila 33 de §9.
   *
   *  @throws {CurriculumUnavailableError} si la consulta falla. */
  async resolveLesson(lessonSlug: string): Promise<ResolvedLesson | null> {
    try {
      // El `curriculum` sale de la CONFIGURACIÓN del servidor, igual que arriba
      // y por lo mismo: no hay aislamiento entre currículos en la tabla.
      const rows = await this.db
        .select({ id: curriculumNodes.id, payload: curriculumNodes.payload })
        .from(curriculumNodes)
        .where(
          and(
            eq(curriculumNodes.curriculum, this.config.curriculumSlug),
            eq(curriculumNodes.slug, lessonSlug),
            eq(curriculumNodes.kind, "lesson")
          )
        )
        .limit(1);

      return rows[0] ?? null;
    } catch (err: unknown) {
      throw this.unavailable("resolver la lección", err);
    }
  }

  /** El `slug` de cada id que siga existiendo. Un id AUSENTE del mapa es un nodo
   *  retirado del temario: `GET /v1/evidence` omite esa fila y NO la borra
   *  (§6.3), y vuelve sola si el nodo regresa, porque el `id` es identidad
   *  estable.
   *
   *  @throws {CurriculumUnavailableError} si la consulta falla. */
  async slugsByNodeId(ids: string[]): Promise<Map<string, string>> {
    // Sin ids no hay consulta. `inArray` con una lista vacía genera SQL que
    // Drizzle rechaza, y además un estudiante sin ninguna entrega es el caso
    // corriente del primer `GET`, no uno raro.
    if (ids.length === 0) return new Map();

    try {
      const rows = await this.db
        .select({ id: curriculumNodes.id, slug: curriculumNodes.slug })
        .from(curriculumNodes)
        .where(
          and(
            eq(curriculumNodes.curriculum, this.config.curriculumSlug),
            inArray(curriculumNodes.id, ids)
          )
        );

      return new Map(rows.map((row) => [row.id, row.slug]));
    } catch (err: unknown) {
      throw this.unavailable("resolver los slugs de la evidencia", err);
    }
  }

  /** Registra con las reglas de §8 de PRD-003 —solo `name` y `cause.code`— y
   *  devuelve el error que el llamante lanza. El error original NO se encadena
   *  como `cause`: `DrizzleQueryError` embebe los parámetros ligados dentro de
   *  `message`, y el filtro global devuelve `exception.getResponse()` tal cual. */
  private unavailable(what: string, err: unknown): CurriculumUnavailableError {
    this.logger.error(`No se pudo ${what}: name=${errorName(err)} code=${causeCode(err)}`);
    return new CurriculumUnavailableError(`no se pudo leer el currículo`);
  }
}
