// Telemetría del embudo, como PROVIDER INYECTABLE (PRD-003 §7).
//
// No se porta `src/lib/analytics.ts` tal cual: hoy construye el cliente en el
// ámbito del módulo y exporta una función suelta, que no se puede inyectar ni
// espiar desde `Test.createTestingModule`. Sin esto, la fila 21 de §9 solo
// podría afirmar "una fila" y no "un evento", que es la mitad interesante.
//
// CONSERVA EL CONTRATO DE HOY: fire-and-forget, nunca lanza, nunca se espera.
// Si el provider perdiera esa envoltura, un fallo de PostHog lanzaría DENTRO de
// la petición — y en POST /v1/access/trial la emisión ocurre después del insert,
// así que el estudiante se quedaría con la fila de trial creada y un 503 en la
// mano.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { Inject, Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import { PostHog } from "posthog-node";

import { API_CONFIG, type ApiConfig } from "../config.ts";
import { errorName } from "../common/error-fields.ts";

// El embudo entero, explícito. Un union en vez de `string` para que un typo no
// invente un evento nuevo y parta el embudo en dos en el panel de PostHog.
//
// ponytail: duplicado de src/lib/analytics.ts durante esta fase; lo cierra la fase de packages/shared, ver ADR-001 §7
export type TutorEvent =
  | "server_pageview"
  | "registered"
  | "trial_started"
  | "tutor_message_sent"
  | "subscription_activated"
  | "subscription_canceled";

@Injectable()
export class AnalyticsService implements OnModuleDestroy {
  private readonly logger = new Logger(AnalyticsService.name);
  private readonly client: PostHog | null;

  constructor(@Inject(API_CONFIG) config: ApiConfig) {
    // Sin clave (local, CI) la telemetría es un no-op silencioso. Nadie debe
    // quedarse sin acceso porque falte una variable de entorno.
    this.client = config.posthogApiKey
      ? new PostHog(config.posthogApiKey, { host: config.posthogHost })
      : null;
  }

  /** Fire-and-forget: PostHog encola en memoria y envía por lotes. NUNCA se
   *  hace `await` en el call site — la telemetría no puede añadir latencia ni
   *  tumbar el flujo del usuario. */
  track(email: string, event: TutorEvent, properties?: Record<string, unknown>): void {
    if (!this.client) return;
    try {
      this.client.capture({ distinctId: email, event, properties });
    } catch (err: unknown) {
      // Solo el nombre: el `distinctId` es el correo (§8).
      this.logger.error(`Error enviando evento a PostHog: ${errorName(err)}`);
    }
  }

  /** Vacía el lote pendiente al apagar. El servidor es de larga vida y no lo
   *  necesita en operación normal; existe para que los tests y un apagado
   *  ordenado no pierdan el lote ni dejen el proceso colgado. */
  async onModuleDestroy(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.shutdown();
    } catch (err: unknown) {
      this.logger.error(`Error vaciando la cola de PostHog: ${errorName(err)}`);
    }
  }
}
