// El cliente de Anthropic del tutor, como PROVIDER INYECTABLE (PRD-005 §7).
//
// POR QUÉ NO SE COPIA `route.ts:21`. La raíz hace `new Anthropic()` en el ámbito
// del módulo, y copiar ese patrón dejaría sin doble a todas las filas de §9 que
// necesitan sustituirlo: la 1 (el cuerpo llega en más de un chunk), la 2 (qué
// hilo recibe el modelo), la 8 (fallo a mitad de stream), la 9 y la 10
// (`abort()` llamado o no). El precedente exacto es de este repositorio:
// PRD-004 inyectó `PADDLE_CLIENT` por la misma razón y sus e2e lo sustituyen con
// `.overrideProvider(PADDLE_CLIENT)`.
//
// Y COMO ALLÍ, EL TIPO ES DELIBERADAMENTE MÁS ESTRECHO QUE `Anthropic`. El
// servicio consume exactamente dos cosas —abrir un stream e iterar sus eventos,
// y abortarlo— así que por `TutorStreamer` no existen `messages.create()`, ni
// `batches`, ni `models`, ni `files`. No es abstracción del SDK: es que ampliar
// la superficie sea una línea visible en un diff. La cota de `max_tokens: 1024`
// y el modelo los fija el servicio; nada de eso se puede rodear desde aquí.
//
// La clave sale de `config.anthropicApiKey`, que es OBLIGATORIA Y SIN DEFECTO
// (§5.1, goal 6): sin ella el proceso no arranca. Pasarla explícitamente y no
// dejar que el SDK la lea de `process.env` por su cuenta es lo que hace que ese
// guarda signifique algo.
//
// Regla de código: identificadores en inglés, comentarios en español.

import Anthropic from "@anthropic-ai/sdk";
import type { Provider } from "@nestjs/common";

import { API_CONFIG, type ApiConfig } from "../config.ts";

export const ANTHROPIC_CLIENT = "ANTHROPIC_CLIENT";

/** El stream tal como lo consume el servicio: se itera y se aborta. Es la
 *  superficie mínima de `MessageStream`, y `abort()` está en ella porque el
 *  goal 8 depende de él — sin esa llamada el turno abandonado se sigue
 *  facturando en Anthropic hasta terminar, y el único síntoma es la factura. */
export type TutorStream = AsyncIterable<Anthropic.MessageStreamEvent> & {
  abort(): void;
};

/** Lo único que el tutor consume del SDK. `Anthropic` encaja estructuralmente;
 *  lo que no encaja es cualquier otra llamada a la API. */
export type TutorStreamer = {
  messages: {
    stream(params: Anthropic.MessageStreamParams): TutorStream;
  };
};

export const anthropicClientProvider: Provider = {
  provide: ANTHROPIC_CLIENT,
  inject: [API_CONFIG],
  useFactory: (config: ApiConfig): TutorStreamer =>
    new Anthropic({ apiKey: config.anthropicApiKey }),
};
