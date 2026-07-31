// La entrega y la lectura de evidencia (PRD-007 §5.1 y §5.2).
//
// EL `userId` SALE DEL TOKEN Y DE NINGÚN OTRO SITIO. Este servicio recibe el
// `SessionUser` que puso `SessionGuard` y el DTO por separado, y el DTO no tiene
// forma de cargar identidad: dos campos bajo `forbidNonWhitelisted`. Fila 36.
//
// NADA DE LO QUE PASA POR AQUÍ SE EMITE A ANALÍTICA, y es una decisión (§8.5).
// `AnalyticsService.track(email, event, properties)` manda `distinctId: email` a
// PostHog con una bolsa de propiedades libre y está disponible para cualquier
// módulo: emitir `{lessonSlug, url, status}` es la línea natural que escribiría
// quien siga el precedente de embudo de PRD-003, y exportaría la URL —dato
// personal por construcción, `github.com/nombreapellido` identifica a una
// persona— a un procesador tercero, atada al correo del estudiante y fuera de la
// garantía de `onDelete: "cascade"`. Por eso este módulo NO IMPORTA
// `AnalyticsService`: la ausencia es estructural, no una omisión que un `set`
// descuidado pueda deshacer. Fila 38 de §9.
//
// Regla de código: identificadores en inglés, comentarios en español.

import {
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";

import {
  CurriculumRepository,
  CurriculumUnavailableError,
} from "../curriculum/curriculum.repository.ts";
import type { LessonEvidenceRow } from "../db/schema.ts";
import type { SessionUser } from "../session/session.guard.ts";
import { EvidenceRepository } from "./evidence.repository.ts";
import { EvidenceVerifier } from "./evidence-verifier.ts";
import type { EvidenceDto } from "./evidence.dto.ts";
import {
  isEvidenceKind,
  type EvidenceFailureReason,
  type EvidenceItem,
  type EvidenceStatus,
} from "../../../../packages/shared/src/evidence.ts";

/** La respuesta de `GET /v1/evidence`. */
export type EvidenceList = { items: EvidenceItem[] };

@Injectable()
export class EvidenceService {
  constructor(
    private readonly curriculum: CurriculumRepository,
    private readonly evidence: EvidenceRepository,
    private readonly verifier: EvidenceVerifier
  ) {}

  async submit(user: SessionUser, dto: EvidenceDto): Promise<EvidenceItem> {
    const lesson = await this.resolveLesson(dto.lessonSlug);

    // 404 y 409 son preguntas DISTINTAS y el panel tiene que poder
    // distinguirlas: "esa lección no existe" contra "esta lección no pide
    // evidencia". El filtro por `kind === "lesson"` de `resolveLesson` es lo que
    // manda el slug de una etapa al 404 y no al 409 (§7.1). Filas 32 y 33.
    if (!lesson) throw new NotFoundException({ error: "lesson_not_found" });

    // El `payload` que llega de Postgres es `Record<string, unknown>`: lo
    // escribió el cargador tras validar, pero el tipo no lo sabe. Se ESTRECHA en
    // vez de afirmarlo con `as`, para que un valor fuera del vocabulario se lea
    // como "esta lección no pide evidencia" y no como un tipo que no existe.
    if (!isEvidenceKind(lesson.payload.evidenceKind)) {
      // Y NO SE ESCRIBE FILA: el 409 va antes de la primera escritura. Fila 31.
      throw new ConflictException({ error: "lesson_accepts_no_evidence" });
    }

    // Primera escritura: la entrega queda registrada ANTES de verificar.
    const declared = await this.evidence.declare(user.userId, lesson.id, dto.url);

    // La verificación NUNCA lanza (goal 4): un `failed` es un estado de la fila,
    // no un error de la petición. La entrega quedó registrada, el estudiante
    // puede seguir, mandar mensajes al tutor y reenviar cuando quiera.
    const verdict = await this.verifier.verify(dto.url);

    // Segunda escritura, condicionada a que la URL siga siendo la que se
    // verificó (§5.5).
    const settled = await this.evidence.settleIfUrlUnchanged(user.userId, lesson.id, dto.url, {
      status: verdict.status,
      failureReason: verdict.failureReason,
    });

    if (settled) return toItem(settled, dto.lessonSlug);

    // Cero filas afectadas: una entrega posterior ganó. Se DESCARTA el veredicto
    // y se devuelve la fila RELEÍDA — no la del upsert inicial, que ya es
    // obsoleta. Fila 37 de §9.
    const reread = await this.evidence.findOne(user.userId, lesson.id);

    // `declared` solo se alcanza si la fila desapareció entre las dos lecturas
    // —una baja de usuario a mitad de la petición—, y devolver algo es mejor que
    // un 500 en un camino que el goal 4 promete que nunca falla.
    return toItem(reread ?? declared, dto.lessonSlug);
  }

  async list(user: SessionUser): Promise<EvidenceList> {
    const rows = await this.evidence.listByUser(user.userId);

    let slugs: Map<string, string>;
    try {
      slugs = await this.curriculum.slugsByNodeId(rows.map((row) => row.lessonNodeId));
    } catch (err: unknown) {
      throw toUnavailable(err);
    }

    // Una fila cuyo nodo ya no exista en el currículo se OMITE de la respuesta y
    // NO SE BORRA (§6.3): el trabajo del estudiante existió, el temario cambió.
    // Vuelve sola si el nodo regresa, porque el `id` es identidad estable.
    const items = rows.flatMap((row) => {
      const slug = slugs.get(row.lessonNodeId);
      return slug === undefined ? [] : [toItem(row, slug)];
    });

    return { items };
  }

  /** El 404 y el 503 se separan AQUÍ, que es la razón de que `resolveLesson`
   *  lance en vez de devolver el par vacío como hace `lessonContext()` para el
   *  turno del tutor. Fila 34 de §9. */
  private async resolveLesson(lessonSlug: string) {
    try {
      return await this.curriculum.resolveLesson(lessonSlug);
    } catch (err: unknown) {
      throw toUnavailable(err);
    }
  }
}

/** El 503 de §5.1, y SOLO para el error que el repositorio declara.
 *
 *  Lo que no sea `CurriculumUnavailableError` se REPROPAGA para que salga como
 *  500 por el filtro global: convertir cualquier excepción en un 503 con código
 *  conocido convertiría un fallo de programación en una respuesta que parece
 *  operativa, y nadie miraría.
 *
 *  El cuerpo de error es un OBJETO, no una cadena: `AllExceptionsFilter:84-87`
 *  devuelve `exception.getResponse()` tal cual, y el panel tiene que poder
 *  distinguir un código de otro. El error original NO se encadena: ya se
 *  registró en el repositorio con `name` y `cause.code`, y adjuntarlo lo metería
 *  en el cuerpo de la respuesta. */
function toUnavailable(err: unknown): unknown {
  if (err instanceof CurriculumUnavailableError) {
    return new ServiceUnavailableException({ error: "curriculum_unavailable" });
  }
  return err;
}

/** De fila a lo que viaja por HTTP. `lessonNodeId` NO aparece: al leer se
 *  resuelve a `lessonSlug`, y `checkedAt` es el literal ISO —no un `Date`—
 *  porque es lo que sale por el cable (§5.1). */
function toItem(row: LessonEvidenceRow, lessonSlug: string): EvidenceItem {
  return {
    lessonSlug,
    url: row.url,
    status: row.status as EvidenceStatus,
    checkedAt: row.checkedAt === null ? null : row.checkedAt.toISOString(),
    failureReason: row.failureReason as EvidenceFailureReason | null,
  };
}
