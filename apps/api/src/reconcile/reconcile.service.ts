// El barrido: compara lo que reporta Paddle con lo que guarda `subscriptions` y
// repara la diferencia (PRD-004 §§6.3-6.6).
//
// LA PROPIEDAD MÁS IMPORTANTE DE ESTE FICHERO: SOLO ESCRIBE HACIA `active`.
// Una divergencia en dirección `canceled` se detecta, se cuenta como
// `pendiente_revocacion` y se registra — nunca se aplica. No es cautela
// genérica, es la conclusión de tres rondas de revisión (§1.3), y cada intento
// de escribir revocaciones produjo un fallo distinto y grave:
//
//  1. Crear una fila `canceled` donde no había ninguna es IRREVERSIBLE: sin
//     fila, `getAccess` devuelve `{allowed: true, status: "none"}` y el primer
//     mensaje abre el trial; con fila `canceled`, `evaluate` deniega y
//     `ensureTrial` hace corto circuito, así que ese trial no se crea nunca más.
//  2. `customData.email` lo elige quien inicia el checkout público. Una
//     revocación por correo convertiría un ataque puntual —pagar con el correo
//     de otro y cancelar— en un bloqueo re-aplicado CADA HORA para siempre.
//  3. Exigir que el `paddle_subscription_id` coincidiera no lo cierra: el propio
//     camino de conceder instala ese identificador, así que la revocación
//     quedaría autorizada por el vínculo que el barrido acaba de crear.
//
// Conceder no tiene ninguna de esas propiedades: el peor caso es servir el tutor
// a alguien de más, que es reversible, barato y visible en cada pasada. Quien
// venga a "completar" esto escribiendo revocaciones necesita su propio PRD y
// tiene que resolver antes el punto 3.
//
// SOBRE LOS IDENTIFICADORES EN LOS LOGS: `paddle_subscription_id` sí se registra,
// y es un SEUDÓNIMO RE-IDENTIFICABLE con acceso al panel de Paddle (§8.2) — el
// paso 4 de §10 consiste justo en resolverlo a personas. No es un dato anónimo:
// no se pega en tickets ni en issues de un repositorio público. El correo no se
// registra nunca, ni entero, ni truncado, ni hasheado.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { Inject, Injectable, Logger } from "@nestjs/common";

import { SubscriptionsRepository, type SubscriptionSnapshot } from "../access/subscriptions.repository.ts";
import { AnalyticsService } from "../analytics/analytics.service.ts";
import { reconcilerEmailFromCustomData } from "../billing/paddle-email.ts";
import { mapPaddleStatus } from "../billing/paddle-status.ts";
import { API_CONFIG } from "../config.ts";
import type { WorkerConfig } from "../worker-config.ts";
import { PADDLE_CLIENT, type PaddleReader } from "./paddle.client.ts";

/** Página de la API de Paddle. El SDK resuelve la paginación por debajo del
 *  `for await`; esto solo dice cuántas suscripciones trae cada petición. */
const PAGE_SIZE = 100;

/** El deadline vencido. Tipo propio porque `worker.ts` lo distingue: es el único
 *  camino que sale con `process.exit(1)` INCONDICIONAL (§5.1), porque el
 *  `Collection` del SDK no expone cancelación y un `fetch` en vuelo mantendría
 *  vivo el bucle de eventos. */
export class ReconcileDeadlineError extends Error {
  override readonly name = "ReconcileDeadlineError";
}

/** Las ocho cuentas de la línea de resumen de §8.2. Identificadores en inglés;
 *  las etiquetas de la línea, que las lee un operador, en español. */
export type SweepCounters = {
  /** Suscripciones que Paddle reportó y esta pasada miró. */
  reviewed: number;
  /** Filas efectivamente escritas hacia `active`. */
  repaired: number;
  /** Toda diferencia detectada, EN LAS DOS DIRECCIONES (goal 1). Incluye las de
   *  dirección `canceled`, que nunca se reparan: `divergencias` mide cuánta
   *  deriva hay, `reparadas` cuánta se arregló y `pendiente_revocacion` cuánta
   *  no se arregla por diseño. */
  divergences: number;
  /** Divergencias en dirección `canceled`. NO es un número de diagnóstico: es
   *  cola de trabajo humano (§10 paso 4), las cuentas a las que se sirve de más. */
  pendingRevocation: number;
  /** Reportes descartados por `reconcilerEmailFromCustomData` (§6.2). */
  missingEmail: number;
  /** Escrituras que afectaron cero filas: alguien escribió entre la carga y la
   *  escritura (§6.6). */
  outOfSync: number;
  /** Correos con MÁS DE UNA fila local, contados una vez por correo — mide
   *  cuántas cuentas duplicadas ha producido la asimetría de mayúsculas (§6.4). */
  ambiguous: number;
  /** Estados que el SDK pineado no declara (§6.2). No se escribe: adivinar hacia
   *  dónde caen es cómo se escribe una denegación por accidente. */
  unknownStatus: number;
};

/** La fila local tal y como se cargó, más una marca de esta pasada. */
type LocalRow = {
  readonly id: string;
  /** El estado OBSERVADO en la carga. Es el `$observado` del compare-and-set y
   *  NO se muta al escribir: mantenerlo fijo es lo que hace que la pasada dé el
   *  mismo resultado sea cual sea el orden en que Paddle liste las suscripciones
   *  de un mismo correo (§6.4). */
  readonly observedStatus: SubscriptionSnapshot["status"];
  readonly paddleSubscriptionId: string | null;
  /** Ya procesada hacia `active` en esta pasada. Lo que impide que dos reportes
   *  `active` del mismo correo —normales: quien cancela y se resuscribe tiene
   *  dos— cuenten dos divergencias y produzcan un `desincronizado` falso, porque
   *  la segunda escritura fallaría el compare-and-set contra lo que acaba de
   *  escribir la primera. */
  settled: boolean;
};

function zeroCounters(): SweepCounters {
  return {
    reviewed: 0,
    repaired: 0,
    divergences: 0,
    pendingRevocation: 0,
    missingEmail: 0,
    outOfSync: 0,
    ambiguous: 0,
    unknownStatus: 0,
  };
}

/** La línea de §8.2, cuya FORMA ES CONTRATO: el paso 4 de §10 depende de leerla
 *  y la fila 15 de §9 la verifica. Nueve campos, este orden, sin correos. */
export function formatSummary(counters: SweepCounters, apply: boolean): string {
  return (
    `revisadas=${counters.reviewed} ` +
    `reparadas=${counters.repaired} ` +
    `divergencias=${counters.divergences} ` +
    `pendiente_revocacion=${counters.pendingRevocation} ` +
    `sin_correo=${counters.missingEmail} ` +
    `desincronizado=${counters.outOfSync} ` +
    `ambiguo=${counters.ambiguous} ` +
    `desconocido=${counters.unknownStatus} ` +
    `aplicar=${apply}`
  );
}

@Injectable()
export class ReconcileService {
  private readonly logger = new Logger(ReconcileService.name);

  constructor(
    @Inject(API_CONFIG) private readonly config: WorkerConfig,
    @Inject(PADDLE_CLIENT) private readonly paddle: PaddleReader,
    private readonly subscriptions: SubscriptionsRepository,
    private readonly analytics: AnalyticsService
  ) {}

  /** Una pasada, con su deadline. Rechaza con `ReconcileDeadlineError` si el
   *  barrido no ha terminado a tiempo.
   *
   *  EL BARRIDO NO SE CANCELA, SE ABANDONA: `Collection` del SDK no expone
   *  cancelación (§5.2), así que perder la carrera no detiene la iteración en
   *  curso. Por eso el camino del deadline en `worker.ts` termina en un
   *  `process.exit(1)` incondicional y no en un `return`. */
  async run(): Promise<SweepCounters> {
    const limitMs = this.config.reconcileDeadlineMs;
    let timer: NodeJS.Timeout | undefined;

    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new ReconcileDeadlineError(`La pasada superó RECONCILE_DEADLINE_MS (${limitMs} ms)`)),
        limitMs
      );
    });

    try {
      return await Promise.race([this.sweep(), deadline]);
    } finally {
      // Sin esto, una pasada que termina en 2 s dejaría el proceso vivo los 300 s
      // del deadline esperando a un temporizador que ya no le importa a nadie.
      clearTimeout(timer);
    }
  }

  private async sweep(): Promise<SweepCounters> {
    // Se lee UNA vez por pasada y no en cada rama: el modo es una propiedad de la
    // pasada, y leerlo dos veces abriría la puerta a una pasada que escribe a
    // medias si alguien mutara la configuración.
    const apply = this.config.reconcileApply;

    const groups = index(await this.subscriptions.listAll());
    // Correos dados de alta EN ESTA pasada. Va aparte de `groups` porque
    // significa otra cosa: "no había fila y ya se decidió crearla", no "esta es
    // la fila". Un alta no deja un `id` que sirva de objetivo a un
    // compare-and-set, y nunca hará falta.
    const inserted = new Set<string>();
    const ambiguousEmails = new Set<string>();
    const counters = zeroCounters();

    for await (const reported of this.paddle.subscriptions.list({ perPage: PAGE_SIZE })) {
      counters.reviewed++;

      // Un reporte suma a un solo contador de descarte. El correo se mira
      // primero porque sin correo no hay con qué comparar, ni siquiera sabiendo
      // el estado.
      const email = reconcilerEmailFromCustomData(reported);
      if (email === null) {
        counters.missingEmail++;
        continue;
      }

      const mapped = mapPaddleStatus(reported.status);
      if (mapped === null) {
        // NO SE ESCRIBE, y aquí está la asimetría deliberada con el webhook
        // (§6.2): él cae a `active` porque es lo que hacía antes de la
        // extracción; el barrido salta, porque un estado que el SDK pineado no
        // declara solo puede venir de una versión más nueva de la API y adivinar
        // hacia dónde cae es cómo se escribe una denegación por accidente.
        counters.unknownStatus++;
        this.logger.warn(
          `reconcile: estado no mapeado paddle_subscription_id=${reported.id} (se ignora)`
        );
        continue;
      }

      const rows = groups.get(email) ?? [];
      if (rows.length > 1) ambiguousEmails.add(email);

      if (mapped === "canceled") {
        this.countPendingRevocation(reported, rows, counters);
        continue;
      }

      if (rows.length === 0) {
        await this.grantMissingRow(email, reported, inserted, counters, apply);
        continue;
      }

      // LA REGLA SE APLICA A TODAS LAS FILAS QUE CASEN, no a una elegida (§6.4).
      // Son la misma persona, y cuál de ellas lee el tutor depende de las
      // mayúsculas del token, que no son observables desde aquí.
      for (const row of rows) {
        await this.grantExistingRow(email, reported, row, counters, apply);
      }
    }

    counters.ambiguous = ambiguousEmails.size;
    this.logger.log(formatSummary(counters, apply));
    return counters;
  }

  /** Dirección `canceled`: se detecta, se cuenta y se registra. NUNCA se escribe
   *  (§1.3, §6.5). Sin fila local tampoco se crea nada. */
  private countPendingRevocation(
    reported: { id: string },
    rows: LocalRow[],
    counters: SweepCounters
  ): void {
    // Comparado contra el estado OBSERVADO, no contra `settled`: una hermana
    // `active` reparada antes en esta misma pasada no borra el hecho de que
    // Paddle reporte una cancelación para este correo.
    const diverging = rows.length === 0 ? 1 : rows.filter((row) => row.observedStatus !== "canceled").length;
    if (diverging === 0) return;

    counters.divergences += diverging;
    counters.pendingRevocation += diverging;
    this.logger.warn(
      `reconcile: pendiente de revocación paddle_subscription_id=${reported.id} filas=${diverging} ` +
        "(no se escribe, §1.3)"
    );
  }

  /** Paddle reporta `active` y no hay fila para ese correo: se crea (§6.5). */
  private async grantMissingRow(
    email: string,
    reported: { id: string },
    inserted: Set<string>,
    counters: SweepCounters,
    apply: boolean
  ): Promise<void> {
    // Un hermano ya la dio de alta en esta pasada: varias suscripciones de Paddle
    // para un mismo correo son normales (§6.4).
    if (inserted.has(email)) return;
    inserted.add(email);
    counters.divergences++;

    if (!apply) return;

    // `upsertStatus` y no un INSERT pelado, CON el predicado de §6.5: que el
    // `Map` no tuviera el correo significa que no había fila en ninguna
    // capitalización, pero el webhook puede crearla a mitad de pasada y
    // `subscriptions.email` es `.unique()`. El `onConflictDoUpdate` degrada a
    // UPDATE en vez de lanzar, y el predicado impide que ese UPDATE pise un
    // `canceled` recién escrito por el webhook — que, al no revocar nunca el
    // barrido, se quedaría `active` para siempre.
    const written = await this.subscriptions.upsertStatus(
      email,
      { status: "active", updatedAt: new Date(), paddleSubscriptionId: reported.id },
      { preserveCanceled: true }
    );

    if (!written) {
      counters.outOfSync++;
      return;
    }

    counters.repaired++;
    this.track(email, "none", reported.id);
  }

  /** Paddle reporta `active` y la fila local dice otra cosa: se escribe (§6.5). */
  private async grantExistingRow(
    email: string,
    reported: { id: string },
    row: LocalRow,
    counters: SweepCounters,
    apply: boolean
  ): Promise<void> {
    if (row.settled || row.observedStatus === "active") return;

    counters.divergences++;
    // Se marca ANTES de escribir y también en modo sin escritura. Antes, porque
    // un segundo reporte `active` del mismo correo fallaría el compare-and-set
    // contra lo que acaba de escribir el primero y contaría un `desincronizado`
    // que no ocurrió. En modo sin escritura, porque si no las dos modalidades
    // reportarían `divergencias` distintas para la misma realidad, y el paso 5
    // de §10 consiste en comparar la semana de observación con la primera pasada
    // que escribe.
    row.settled = true;

    if (!apply) return;

    const written = await this.subscriptions.updateStatusIfUnchanged(row.id, row.observedStatus, {
      status: "active",
      updatedAt: new Date(),
      // Se rellena solo si la fila no lo tenía. NO AUTORIZA NADA (§1.3 punto 3):
      // es este mismo camino el que lo instala, así que usarlo más adelante como
      // prueba de vínculo para revocar sería circular.
      ...(row.paddleSubscriptionId === null ? { paddleSubscriptionId: reported.id } : {}),
    });

    if (!written) {
      counters.outOfSync++;
      return;
    }

    counters.repaired++;
    this.track(email, row.observedStatus, reported.id);
  }

  /** Rastro duradero y atribuible de cada escritura aplicada (goal 14, §8.2).
   *
   *  El `distinctId` es el correo, como en todos los eventos del sistema: no es
   *  un sumidero de PII nuevo. El lote lo vacía `onModuleDestroy` al cerrar el
   *  contexto — por eso el camino del deadline, que sale con `process.exit(1)`,
   *  lo pierde (§5.1). */
  private track(email: string, from: string, paddleSubscriptionId: string): void {
    this.analytics.track(email, "subscription_reconciled", {
      from,
      to: "active",
      paddle_subscription_id: paddleSubscriptionId,
    });
  }
}

/** Indexa la tabla por correo EN MINÚSCULAS, con una lista por llave.
 *
 *  Un `Map<string, LocalRow[]>` y no `Map<string, LocalRow>` porque una llave
 *  puede tener más de una fila y hacerlo visible es el punto: `billing` pasa el
 *  correo de Paddle a minúsculas y el camino del tutor no transforma el del
 *  token, así que `Estudiante@Ejemplo.test` y `estudiante@ejemplo.test` conviven
 *  en una columna `text` con unique (§6.4). El tutor lee una; el webhook escribe
 *  la otra. */
function index(rows: SubscriptionSnapshot[]): Map<string, LocalRow[]> {
  const groups = new Map<string, LocalRow[]>();

  for (const row of rows) {
    const key = row.email.toLowerCase();
    const group = groups.get(key);
    const local: LocalRow = {
      id: row.id,
      observedStatus: row.status,
      paddleSubscriptionId: row.paddleSubscriptionId,
      settled: false,
    };

    if (group === undefined) groups.set(key, [local]);
    else group.push(local);
  }

  return groups;
}
