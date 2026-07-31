// Acceso a `lesson_evidence` (PRD-007 §6.1 y §5.5).
//
// Es la costura que permite que las filas 31-38 de §9 sustituyan el repositorio
// por un doble y no toquen Postgres, igual que `subscriptions.repository.ts:1-3`
// para las filas 13-18 de PRD-003.
//
// DOS ESCRITURAS POR ENTREGA, Y LA SEGUNDA ES CONDICIONAL. El upsert garantiza
// UNA fila; no garantiza una COHERENTE. Ver el bloque de `settleIfUrlUnchanged`.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, sql } from "drizzle-orm";

import { DRIZZLE, type Database } from "../db/drizzle.module.ts";
import { lessonEvidence, type LessonEvidenceRow } from "../db/schema.ts";
import type {
  EvidenceFailureReason,
  EvidenceStatus,
} from "../../../../packages/shared/src/evidence.ts";

/** El veredicto que la segunda escritura estampa. `null` en `failureReason`
 *  cuando el estado es `verified`: una URL que verifica no arrastra la razón de
 *  un intento anterior. */
export type EvidenceVerdict = {
  status: Exclude<EvidenceStatus, "declared">;
  failureReason: EvidenceFailureReason | null;
};

@Injectable()
export class EvidenceRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** Primera escritura: la entrega queda registrada en `declared` ANTES de
   *  verificar, para que un fallo de comprobación no pierda la entrega.
   *
   *  UPSERT POR `(user_id, lesson_node_id)`: reenviar ACTUALIZA la fila, nunca
   *  la duplica (goal 1).
   *
   *  EL `set` SE NOMBRA EXPLÍCITAMENTE, como `load-curriculum.ts:335-350` y
   *  `subscriptions.repository.ts:127-131`:
   *
   *   - `created_at` NO aparece: la fila conserva su primera entrega.
   *   - `updated_at` SÍ, porque no hay `$onUpdate` en el esquema y sin nombrarlo
   *     conservaría el valor de inserción. Fila 39 de §9 mira las dos.
   *   - `status`/`checked_at`/`failure_reason` se REINICIAN: una URL nueva no
   *     puede heredar el veredicto de la anterior. */
  async declare(userId: string, lessonNodeId: string, url: string): Promise<LessonEvidenceRow> {
    const [row] = await this.db
      .insert(lessonEvidence)
      .values({ userId, lessonNodeId, url })
      .onConflictDoUpdate({
        target: [lessonEvidence.userId, lessonEvidence.lessonNodeId],
        set: {
          url,
          status: "declared",
          checkedAt: null,
          failureReason: null,
          updatedAt: sql`now()`,
        },
      })
      .returning();

    return row;
  }

  /** Segunda escritura: COMPARE-AND-SET SOBRE LA URL.
   *
   *  POR QUÉ NO BASTA UN `UPDATE` A SECAS. Dos entregas solapadas sobre la misma
   *  lección se intercalan así: A escribe `url=X` → B escribe `url=Y` → vuelve
   *  el verificador de A y estampa su veredicto sobre la fila que ya lleva `Y`.
   *  El resultado es una fila `verified` para una URL que nadie verificó, que es
   *  exactamente lo que el goal 2 prohíbe. No hace falta un segundo usuario:
   *  reenviar durante los 3 s de comprobación lo produce.
   *
   *  `url` ES LA URL TAL COMO SE GUARDÓ, NUNCA EL DESTINO FINAL DE LA CADENA DE
   *  REDIRECCIONES. Al terminar, el verificador tiene dos URLs en la mano; si el
   *  CAS comparase contra la segunda no casaría NINGUNA fila en todo destino que
   *  redirija, el veredicto se descartaría por el camino de abajo y la fila se
   *  quedaría en `declared` para siempre — con 200 y sin error en ningún sitio.
   *  Y `apex→www` de GitHub Pages es la razón de que `EVIDENCE_MAX_REDIRECTS` sea
   *  3, y GitHub Pages es el artefacto de L1: la primera lección del curso nunca
   *  llegaría a `verified`. Fila 52 de §9. El destino final NO se guarda en
   *  ninguna columna.
   *
   *  Es el idiom de `updateStatusIfUnchanged`
   *  (`access/subscriptions.repository.ts:169-181`), que PRD-004 introdujo para
   *  una ventana de lectura-escritura estructuralmente idéntica.
   *
   *  @returns la fila actualizada, o `undefined` si afectó cero filas — o sea si
   *  una entrega posterior ganó y este veredicto hay que descartarlo. */
  async settleIfUrlUnchanged(
    userId: string,
    lessonNodeId: string,
    url: string,
    verdict: EvidenceVerdict
  ): Promise<LessonEvidenceRow | undefined> {
    const [row] = await this.db
      .update(lessonEvidence)
      .set({
        status: verdict.status,
        failureReason: verdict.failureReason,
        checkedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(lessonEvidence.userId, userId),
          eq(lessonEvidence.lessonNodeId, lessonNodeId),
          eq(lessonEvidence.url, url)
        )
      )
      .returning();

    return row;
  }

  /** La relectura del camino de descarte (§5.5). Un `RETURNING` sobre cero filas
   *  no devuelve nada, así que sin este `SELECT` ese camino no tendría qué
   *  responder — y responder con la fila del upsert inicial sería devolver un
   *  estado que ya es obsoleto. */
  async findOne(userId: string, lessonNodeId: string): Promise<LessonEvidenceRow | undefined> {
    const [row] = await this.db
      .select()
      .from(lessonEvidence)
      .where(and(eq(lessonEvidence.userId, userId), eq(lessonEvidence.lessonNodeId, lessonNodeId)))
      .limit(1);

    return row;
  }

  /** Las filas DEL PROPIO ESTUDIANTE. El índice que las sirve es el de la
   *  restricción única `lesson_evidence_user_lesson_key`, cuyo btree lleva
   *  `user_id` de primera columna — por eso no hay un índice adicional por
   *  `user_id`, que sería una escritura más por fila a cambio de nada. */
  async listByUser(userId: string): Promise<LessonEvidenceRow[]> {
    return this.db
      .select()
      .from(lessonEvidence)
      .where(eq(lessonEvidence.userId, userId))
      .orderBy(asc(lessonEvidence.createdAt));
  }
}
