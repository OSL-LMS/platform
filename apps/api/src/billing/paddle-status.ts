// Mapa de estados de Paddle → `subscriptions.status`. UNO SOLO, compartido por
// el webhook y el reconciliador (PRD-004 §6.2).
//
// Vivía inline en `billing.controller.ts:129` como `data.status === "canceled"`.
// Se extrae porque desde PRD-004 hay un SEGUNDO escritor de esa columna que
// corre cada hora: con dos copias del criterio, un `past_due` haría que cada
// escritor pisara al otro y la fila oscilaría sin que ningún test que mire a un
// solo lado lo detectara.
//
// LA RAMA `SubscriptionCanceled` DEL WEBHOOK NO PASA POR AQUÍ, y no es un
// descuido: es dirigida por evento y escribe `"canceled"` sin leer
// `data.status` (§3, §6.2). La fila 6 de §9 la vigila.
//
// UN ESTADO NO MAPEADO DEVUELVE `null` Y NO SE COACCIONA AQUÍ. Los dos
// consumidores toman decisiones opuestas y las dos son correctas para su lado:
// el reconciliador no escribe y lo cuenta como `desconocido` (§6.5) porque
// reintenta cada hora; el webhook cae a `active` en su call site —visible, no
// escondido en el mapa— porque es lo que hacía antes de la extracción y las
// filas 5 y 6 de §9 sostienen que no cambie.
//
// Regla de código: identificadores en inglés, comentarios en español.

import type { SubscriptionStatus } from "@paddle/paddle-node-sdk";

/** Lo que un estado de Paddle puede llegar a escribir en `subscriptions.status`.
 *  `trial` es INALCANZABLE desde aquí: lo escribe `insertTrial` y nada más
 *  (§6.2). La fila 2 de §9 lo fija. */
export type MappedStatus = "active" | "canceled";

/** Los cinco estados que declara `@paddle/paddle-node-sdk@3.8.0`, la versión
 *  pineada en el `catalog:` de `pnpm-workspace.yaml`.
 *
 *  El `Record` es EXHAUSTIVO a propósito: si una versión futura del SDK añade un
 *  estado, esto deja de compilar. Es la señal que se quiere — la alternativa es
 *  que el estado nuevo caiga en silencio a `desconocido` y que el reconciliador
 *  deje de reparar a gente que sí está pagando, sin que nada se ponga rojo. */
const STATUS_MAP: Record<SubscriptionStatus, MappedStatus> = {
  active: "active",
  canceled: "canceled",

  // `past_due` y `paused` caen a `active`. Es deuda heredada del webhook,
  // declarada en `docs/SYSTEM_ARTIFACT.md` (dominio `acceso`, Open Debt) y
  // REPRODUCIDA a propósito: corregirla es otro PRD (§3).
  past_due: "active",
  paused: "active",

  // El trial DE PADDLE lleva tarjeta: es una conversión, no nuestro trial de 7
  // días sin tarjeta.
  trialing: "active",
};

/** `status` llega como `unknown` porque nace en `customData`/`data.status` de un
 *  payload que el SDK deserializa sin validar el enum. */
export function mapPaddleStatus(status: unknown): MappedStatus | null {
  // `Object.hasOwn` y no `STATUS_MAP[status] ?? null`: un literal de objeto
  // hereda de `Object.prototype`, así que un `status` de `"toString"` o
  // `"constructor"` devolvería una FUNCIÓN —truthy, no `null`— y el llamante la
  // trataría como un estado mapeado. El campo lo controla quien inicia el
  // checkout público (PRD-003 §8), así que no es una hipótesis de laboratorio.
  if (typeof status !== "string" || !Object.hasOwn(STATUS_MAP, status)) return null;
  return STATUS_MAP[status as SubscriptionStatus];
}
