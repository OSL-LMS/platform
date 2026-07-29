// El mapa de estados compartido por el webhook y el reconciliador (PRD-004 §6.2).
//
// Cubre las filas 1 y 2 de PRD-004 §9.
//
// Es un módulo puro: sin DI, sin base, sin red. Lo que prueba no es una
// traducción trivial, es que el mapa no COACCIONE — que un estado que no conoce
// sea distinguible por el llamante, porque los dos consumidores toman decisiones
// opuestas con esa información (§6.2, §6.5).
//
// Regla de código: identificadores en inglés, comentarios en español.

import type { SubscriptionStatus } from "@paddle/paddle-node-sdk";
import { describe, expect, it } from "vitest";

import { mapPaddleStatus } from "./paddle-status.ts";

/** Los cinco que declara `@paddle/paddle-node-sdk@3.8.0`, la versión pineada en
 *  el `catalog:`. La lista se escribe a mano a propósito: si el SDK añade un
 *  estado, el `Record` de `paddle-status.ts` deja de compilar Y esta lista deja
 *  de estar completa. Dos señales, no una. */
const SDK_STATUSES: SubscriptionStatus[] = ["active", "canceled", "past_due", "paused", "trialing"];

describe("mapPaddleStatus", () => {
  // -------------------------------------------------------------------------
  // Fila 1 — los cinco estados del SDK mapean según §6.2
  // -------------------------------------------------------------------------
  it("fila 1: los cinco estados del SDK mapean según la tabla de §6.2", () => {
    expect(mapPaddleStatus("active")).toBe("active");
    expect(mapPaddleStatus("canceled")).toBe("canceled");

    // `past_due` y `paused` a `active` es deuda heredada declarada en
    // `docs/SYSTEM_ARTIFACT.md`: se REPRODUCE, no se corrige (§3).
    expect(mapPaddleStatus("past_due")).toBe("active");
    expect(mapPaddleStatus("paused")).toBe("active");

    // El trial DE PADDLE lleva tarjeta: es una conversión.
    expect(mapPaddleStatus("trialing")).toBe("active");
  });

  it("fila 1: ninguno de los cinco se queda sin mapear", () => {
    for (const status of SDK_STATUSES) {
      expect(mapPaddleStatus(status), `${status} debería mapear`).not.toBeNull();
    }
  });

  // -------------------------------------------------------------------------
  // Fila 2 — el mapa nunca produce `trial`
  // -------------------------------------------------------------------------
  it("fila 2: ninguna entrada produce `trial`", () => {
    // `trial` es INALCANZABLE desde Paddle: lo escribe `insertTrial` y nada más.
    // Si el mapa lo produjera, el reconciliador podría devolver a alguien a un
    // trial vencido y quitarle el acceso que está pagando.
    const inputs: unknown[] = [...SDK_STATUSES, "trial", "TRIAL", "", null, undefined, 7, {}];
    for (const input of inputs) {
      expect(mapPaddleStatus(input), `${String(input)} no debería dar trial`).not.toBe("trial");
    }
  });

  // -------------------------------------------------------------------------
  // La propiedad que hace compartible el mapa: no coacciona
  // -------------------------------------------------------------------------
  it("un estado fuera de los cinco devuelve `null`, distinguible por el llamante", () => {
    // El reconciliador lo cuenta como `desconocido` y no escribe (§6.5); el
    // webhook cae a `active` en su call site. Las dos decisiones necesitan poder
    // ver la diferencia, que es lo que un `?? "active"` dentro del mapa borraría.
    expect(mapPaddleStatus("wibble")).toBeNull();
    expect(mapPaddleStatus("ACTIVE")).toBeNull();
    expect(mapPaddleStatus(" active")).toBeNull();
    expect(mapPaddleStatus("active ")).toBeNull();
  });

  it("no resuelve por la cadena de prototipos", () => {
    // Sin `Object.hasOwn`, `STATUS_MAP["toString"]` devolvería la función de
    // `Object.prototype`: truthy, no `null`, y el llamante la trataría como un
    // estado mapeado. `status` y `customData` los controla quien inicia el
    // checkout público (PRD-003 §8), así que la entrada no es de laboratorio.
    for (const key of ["toString", "constructor", "hasOwnProperty", "valueOf", "__proto__"]) {
      expect(mapPaddleStatus(key), `${key} no debería mapear`).toBeNull();
    }
  });

  it("degrada sin lanzar ante lo que no es un string", () => {
    expect(mapPaddleStatus(undefined)).toBeNull();
    expect(mapPaddleStatus(null)).toBeNull();
    expect(mapPaddleStatus(123)).toBeNull();
    expect(mapPaddleStatus({ status: "active" })).toBeNull();
    expect(mapPaddleStatus(["active"])).toBeNull();
  });
});
