// El cuerpo de `POST /v1/evidence`: qué acepta y qué es 400.
//
// Cubre las filas 1, 2, 3, 4, 5, 6, 7 y 8 de PRD-007 §9.
//
// CON `VALIDATION_OPTIONS` DE PRODUCCIÓN, importadas de `bootstrap.ts`, y NO con
// un pipe construido aquí. Si el spec construyera el suyo,
// `forbidNonWhitelisted` podría desaparecer de producción sin que nada se
// pusiera rojo — y ese flag es la mitad estructural del control de §8.1: es lo
// que convierte un `userId` en el cuerpo en un 400 en vez de un campo ignorado
// en silencio.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { ValidationPipe } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import { VALIDATION_OPTIONS } from "../bootstrap.ts";
import { EvidenceDto, MAX_EVIDENCE_URL_CHARS } from "./evidence.dto.ts";

const pipe = new ValidationPipe(VALIDATION_OPTIONS);
const METADATA = { type: "body", metatype: EvidenceDto } as const;

const VALID_URL = "https://ana.example.com/mi-web";

/** El código que el pipe pondría, o 200 si el cuerpo pasa. Se afirma sobre el
 *  CÓDIGO y no sobre el mensaje: el mensaje es de class-validator y cambiaría
 *  con una actualización de la librería. */
async function statusOf(body: unknown): Promise<number> {
  try {
    await pipe.transform(body, METADATA);
    return 200;
  } catch (err: unknown) {
    return (err as { getStatus?: () => number }).getStatus?.() ?? 500;
  }
}

describe("EvidenceDto", () => {
  // -------------------------------------------------------------------------
  // Fila 1 — el cuerpo mínimo
  // -------------------------------------------------------------------------
  it("fila 1: acepta el cuerpo mínimo y lo devuelve intacto", async () => {
    const body = { lessonSlug: "L1", url: VALID_URL };

    // `VALIDATION_OPTIONS` de producción NO lleva `transform: true`, así que lo
    // que llega al handler es el objeto plano y no una instancia de la clase —
    // igual que ya le pasa a `TurnDto`. Se afirma sobre lo que de verdad pasa,
    // no sobre lo que un `transform: true` haría.
    await expect(pipe.transform(body, METADATA)).resolves.toEqual(body);
  });

  // -------------------------------------------------------------------------
  // Fila 2 — un campo de más es 400, no un campo ignorado
  // -------------------------------------------------------------------------
  it("fila 2: `userId` en el cuerpo es 400 por forbidNonWhitelisted", async () => {
    // Control de §8.1. El `userId` de toda escritura sale de `request.user`, y
    // lo que impide que uno del cuerpo llegue al servicio no es una comprobación
    // dentro del servicio: es que el pipe rechaza el cuerpo entero.
    expect(await statusOf({ lessonSlug: "L1", url: VALID_URL, userId: "otro" })).toBe(400);

    // Y cualquier otro campo de más, no solo el que carga identidad.
    expect(await statusOf({ lessonSlug: "L1", url: VALID_URL, status: "verified" })).toBe(400);
  });

  // -------------------------------------------------------------------------
  // Fila 3 — solo https
  // -------------------------------------------------------------------------
  it("fila 3: rechaza todo esquema que no sea https", async () => {
    const schemes = [
      "http://ana.example.com/",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "ftp://ana.example.com/",
      // Relativo-a-protocolo: no parsea como URL absoluta.
      "//ana.example.com/",
      "no-es-una-url",
    ];

    for (const url of schemes) {
      expect(await statusOf({ lessonSlug: "L1", url }), `${url} debería ser 400`).toBe(400);
    }
  });

  // -------------------------------------------------------------------------
  // Fila 4 — solo el puerto 443
  // -------------------------------------------------------------------------
  it("fila 4: rechaza un puerto distinto de 443, y acepta el 443 explícito y la ausencia", async () => {
    expect(await statusOf({ lessonSlug: "L1", url: "https://x.example.com:8443/" })).toBe(400);
    expect(await statusOf({ lessonSlug: "L1", url: "https://x.example.com:9200/" })).toBe(400);
    expect(await statusOf({ lessonSlug: "L1", url: "https://x.example.com:80/" })).toBe(400);

    // El parser WHATWG borra el puerto por defecto del esquema, así que este
    // `:443` no llega siquiera a la rama del literal — se comprueba que pasa,
    // que es lo que el producto necesita.
    expect(await statusOf({ lessonSlug: "L1", url: "https://x.example.com:443/" })).toBe(200);
    expect(await statusOf({ lessonSlug: "L1", url: "https://x.example.com/" })).toBe(200);
  });

  // -------------------------------------------------------------------------
  // Fila 5 — la forma del host: literal sí, etiqueta única no
  // -------------------------------------------------------------------------
  it("fila 5: un literal IP pasa el DTO y un host de una sola etiqueta es 400", async () => {
    // LA PRIMERA MITAD fija la desviación DELIBERADA respecto a `@IsUrl()`, cuyo
    // `require_tld: true` mataría estas dos en el pipe: el control de destino es
    // el RANGO RESUELTO (§8.2), no la forma del host. Que `127.0.0.1` sea 400 o
    // no lo decide el verificador, no esta capa.
    expect(await statusOf({ lessonSlug: "L1", url: "https://93.184.216.34/" })).toBe(200);
    expect(await statusOf({ lessonSlug: "L1", url: "https://[2606:4700::1]/" })).toBe(200);
    // Y los literales que el verificador bloqueará también PASAN el DTO: si
    // murieran aquí, el paso 4 de §10 no podría comprobar `blocked_address`.
    expect(await statusOf({ lessonSlug: "L1", url: "https://127.0.0.1/" })).toBe(200);
    expect(await statusOf({ lessonSlug: "L1", url: "https://[::1]/" })).toBe(200);
    expect(await statusOf({ lessonSlug: "L1", url: "https://[::]/" })).toBe(200);

    // LA SEGUNDA MITAD es un control de seguridad, no higiene: un host de una
    // sola etiqueta que resuelve públicamente se cribaría con c-ares y se
    // conectaría con `getaddrinfo`, que aplica la lista `search` de
    // `resolv.conf` — o sea a una dirección interna (§5.1). Fail-open.
    expect(await statusOf({ lessonSlug: "L1", url: "https://uz/" })).toBe(400);
    expect(await statusOf({ lessonSlug: "L1", url: "https://localhost/" })).toBe(400);
    expect(await statusOf({ lessonSlug: "L1", url: "https://api-interna/salud" })).toBe(400);

    // Las dos mitades son la MISMA condición `isIP()`: el literal la satisface,
    // la etiqueta única no y necesita el punto.
    expect(await statusOf({ lessonSlug: "L1", url: "https://uz.example/" })).toBe(200);
  });

  // -------------------------------------------------------------------------
  // Fila 6 — el slug va contra SLUG_PATTERN
  // -------------------------------------------------------------------------
  it("fila 6: rechaza un lessonSlug fuera de patrón", async () => {
    const slugs = ["../", "a b", "L1/../L2", "", "a".repeat(65), "L1;DROP"];

    for (const lessonSlug of slugs) {
      expect(
        await statusOf({ lessonSlug, url: VALID_URL }),
        `${JSON.stringify(lessonSlug)} debería ser 400`
      ).toBe(400);
    }

    // Y el borde de arriba sí pasa: 64 caracteres es el máximo, no el primero
    // rechazado.
    expect(await statusOf({ lessonSlug: "a".repeat(64), url: VALID_URL })).toBe(200);
  });

  // -------------------------------------------------------------------------
  // Fila 7 — la cota de la URL
  // -------------------------------------------------------------------------
  it("fila 7: rechaza una url de más de 2048 caracteres", async () => {
    const prefix = "https://ana.example.com/";
    const tooLong = prefix + "a".repeat(MAX_EVIDENCE_URL_CHARS - prefix.length + 1);
    const atLimit = prefix + "a".repeat(MAX_EVIDENCE_URL_CHARS - prefix.length);

    expect(tooLong.length).toBe(MAX_EVIDENCE_URL_CHARS + 1);
    expect(await statusOf({ lessonSlug: "L1", url: tooLong })).toBe(400);
    expect(await statusOf({ lessonSlug: "L1", url: atLimit })).toBe(200);
  });

  // -------------------------------------------------------------------------
  // Fila 8 — una `url` no textual es 400, NO 500
  // -------------------------------------------------------------------------
  it("fila 8: `url` no textual es 400 y no un 500", async () => {
    // `new URL(123)` LANZA, y class-validator NO envuelve las restricciones
    // personalizadas síncronas: un validador que propagase convertiría este
    // cuerpo en un 500 donde §5.1 promete 400. Lo que lo impide es que
    // `isEvidenceUrl` devuelva `false` ante lo que no parsea.
    const values: unknown[] = [123, null, true, { toString: () => VALID_URL }, ["https://x.example.com/"]];

    for (const url of values) {
      const status = await statusOf({ lessonSlug: "L1", url });
      expect(status, `url=${JSON.stringify(url)} debería ser 400`).toBe(400);
      // La afirmación positiva que impide que la de arriba pase por un 500
      // disfrazado: el pipe tiene que estar decidiendo, no reventando.
      expect(status).not.toBe(500);
    }

    // Y `lessonSlug` no textual, por lo mismo: `@Matches` sobre un número.
    expect(await statusOf({ lessonSlug: 1, url: VALID_URL })).toBe(400);
    expect(await statusOf({ url: VALID_URL })).toBe(400);
  });
});
