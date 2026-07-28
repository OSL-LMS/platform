// La allowlist por campo del registro de errores (PRD-003 §8).
//
// No cubre una fila concreta de §9: las filas 31 y 40 prueban la propiedad de
// extremo a extremo (que el correo no sale por el log de una petición real).
// Esto prueba el mecanismo que la sostiene, que es donde se rompería primero si
// alguien lo "generaliza".
//
// Regla de código: identificadores en inglés, comentarios en español.

import { describe, expect, it } from "vitest";

import { causeCode, errorName } from "./error-fields.ts";

describe("errorName", () => {
  it("devuelve el nombre y nunca el mensaje", () => {
    const err = new Error("params: victima@ejemplo.test");
    err.name = "DrizzleQueryError";
    expect(errorName(err)).toBe("DrizzleQueryError");
  });

  it("degrada sin lanzar ante un no-Error", () => {
    expect(errorName("victima@ejemplo.test")).toBe("no-Error(string)");
    expect(errorName(null)).toBe("no-Error(object)");
  });
});

describe("causeCode", () => {
  it("prefiere cause.code, que es donde lo deja DrizzleQueryError", () => {
    expect(causeCode({ cause: { code: "ECONNREFUSED" }, code: "OTRO" })).toBe(
      "ECONNREFUSED"
    );
  });

  it("cae a err.code para un error de pg sin envolver", () => {
    // El del evento `error` del pool: SQLSTATE en la raíz, no en `cause`.
    expect(causeCode({ code: "57P01" })).toBe("57P01");
  });

  it("devuelve `-` cuando no hay código", () => {
    expect(causeCode(new Error("params: victima@ejemplo.test"))).toBe("-");
    expect(causeCode(null)).toBe("-");
    expect(causeCode(undefined)).toBe("-");
  });

  // El motivo de que exista el guarda de forma: `code` es una convención, no un
  // contrato, y el DatabaseError de pg lleva el correo en campos vecinos.
  it("rechaza lo que no tiene forma de código, aunque venga en `code`", () => {
    const conProsa = {
      code: "Key (email)=(victima@ejemplo.test) already exists.",
    };
    expect(causeCode(conProsa)).toBe("-");
    expect(causeCode(conProsa)).not.toContain("@");

    // Un `code` largo tampoco pasa, aunque no lleve `@`.
    expect(causeCode({ code: "x".repeat(33) })).toBe("-");
  });

  it("conserva los códigos reales que el servicio necesita", () => {
    for (const code of ["ECONNREFUSED", "23505", "57P01", "ERR_REQUIRE_ESM"]) {
      expect(causeCode({ code })).toBe(code);
    }
  });
});
