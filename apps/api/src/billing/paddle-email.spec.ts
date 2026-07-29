// El extractor de correo compartido por el webhook y el reconciliador
// (PRD-004 §6.2).
//
// Cubre la fila 3 de PRD-004 §9.
//
// Lo que se prueba en pareja, y no por separado, es la ASIMETRÍA: las dos cotas
// del reconciliador no pueden filtrarse al webhook, porque eso cambiaría
// comportamiento observable de una rama que PRD-004 §3 deja fuera de alcance.
// Un futuro "unificamos las dos funciones" rompe estos tests a la vez.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { describe, expect, it } from "vitest";

import {
  MAX_EMAIL_LENGTH,
  emailFromCustomData,
  reconcilerEmailFromCustomData,
} from "./paddle-email.ts";

/** La forma con la que Paddle entrega lo que el navegador puso en el checkout. */
function custom(email: unknown): unknown {
  return { customData: { email } };
}

/** Un correo de exactamente `length` caracteres, con `@` y dominio válidos. */
function emailOfLength(length: number): string {
  const suffix = "@ejemplo.test";
  return "e".repeat(length - suffix.length) + suffix;
}

describe("emailFromCustomData (el del webhook)", () => {
  it("fila 3: lo que no es un string se rechaza", () => {
    expect(emailFromCustomData(custom(undefined))).toBeNull();
    expect(emailFromCustomData(custom(null))).toBeNull();
    expect(emailFromCustomData(custom(42))).toBeNull();
    expect(emailFromCustomData(custom({ email: "anidado@ejemplo.test" }))).toBeNull();
    expect(emailFromCustomData(custom(["estudiante@ejemplo.test"]))).toBeNull();
  });

  it("fila 3: sin `customData` degrada a null sin lanzar", () => {
    expect(emailFromCustomData(null)).toBeNull();
    expect(emailFromCustomData(undefined)).toBeNull();
    expect(emailFromCustomData({})).toBeNull();
    expect(emailFromCustomData({ customData: null })).toBeNull();
  });

  it("normaliza a minúsculas, que es la llave que enlaza con `subscriptions`", () => {
    expect(emailFromCustomData(custom("Estudiante@Ejemplo.test"))).toBe("estudiante@ejemplo.test");
  });

  it("NO aplica las cotas del reconciliador: su comportamiento no se movió", () => {
    // Ésta es la propiedad que sostiene las filas 5 y 6 de §9. Si alguien mete
    // las cotas en la función compartida, esto falla — y tiene que fallar: sería
    // un cambio de comportamiento del webhook disfrazado de refactor.
    expect(emailFromCustomData(custom("nope"))).toBe("nope");
    expect(emailFromCustomData(custom(""))).toBe("");
    expect(emailFromCustomData(custom(emailOfLength(300)))).toHaveLength(300);
  });
});

describe("reconcilerEmailFromCustomData (el del barrido)", () => {
  it("fila 3: hereda el rechazo de lo que no es un string", () => {
    expect(reconcilerEmailFromCustomData(custom(undefined))).toBeNull();
    expect(reconcilerEmailFromCustomData(custom(null))).toBeNull();
    expect(reconcilerEmailFromCustomData(custom(42))).toBeNull();
    expect(reconcilerEmailFromCustomData(null)).toBeNull();
  });

  it("fila 3: lo que no lleva `@` se rechaza", () => {
    // Sin `@` no hay nada con lo que emparejar una fila, y el barrido lo
    // reintentaría cada hora: suma a `sin_correo` y se acabó (§8.2).
    expect(reconcilerEmailFromCustomData(custom("nope"))).toBeNull();
    expect(reconcilerEmailFromCustomData(custom(""))).toBeNull();
    expect(reconcilerEmailFromCustomData(custom("   "))).toBeNull();
  });

  it("fila 3: lo que pasa de 254 caracteres se rechaza", () => {
    expect(MAX_EMAIL_LENGTH).toBe(254);
    expect(reconcilerEmailFromCustomData(custom(emailOfLength(255)))).toBeNull();
    expect(reconcilerEmailFromCustomData(custom(emailOfLength(1000)))).toBeNull();
  });

  it("fila 3: justo en la cota sí pasa", () => {
    const exact = emailOfLength(MAX_EMAIL_LENGTH);
    expect(exact).toHaveLength(MAX_EMAIL_LENGTH);
    expect(reconcilerEmailFromCustomData(custom(exact))).toBe(exact);
  });

  it("la cota se mide sobre el correo YA normalizado", () => {
    // `toLowerCase()` no conserva la longitud para todo Unicode, y lo que
    // importa es lo que acabaría en la columna, no lo que llegó.
    const upper = "ESTUDIANTE@EJEMPLO.TEST";
    expect(reconcilerEmailFromCustomData(custom(upper))).toBe("estudiante@ejemplo.test");
  });
});
