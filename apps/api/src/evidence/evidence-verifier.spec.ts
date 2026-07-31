// El verificador: el control de destino, el presupuesto y lo que NUNCA sale de
// aquí.
//
// Cubre las filas 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
// 25, 26, 27, 28, 29 y 30 de PRD-007 §9.
//
// SIN LEVANTAR NEST Y SIN TOCAR LA RED. `verifyEvidenceUrl` recibe la
// configuración, el `fetch` y el RESOLUTOR como argumentos (§7.1), así que aquí
// se le dan dobles guionizados POR FAMILIA — que es lo que necesitan las filas
// 16, 17, 18, 26 y 27, y la razón de que el resolutor viaje por la costura en
// vez de leerse de `dns.promises` por dentro.
//
// HOSTS DE DOCUMENTACIÓN (RFC 2606: `example.com`) y URLs sintéticas: ningún
// dato de estudiante entra al repositorio (§8.5).
//
// Regla de código: identificadores en inglés, comentarios en español.

import { ConsoleLogger, Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";

import { captureOutput } from "../../test/helpers.ts";
import {
  verifyEvidenceUrl,
  type EvidenceResolver,
  type EvidenceVerifierConfig,
  type EvidenceVerifierDeps,
} from "./evidence-verifier.ts";

const CONFIG: EvidenceVerifierConfig = { timeoutMs: 3_000, maxRedirects: 3 };

/** Un host público cualquiera y su dirección, los dos de documentación. */
const PUBLIC_HOST = "ana.example.com";
const PUBLIC_URL = `https://${PUBLIC_HOST}/mi-web`;
const PUBLIC_V4 = "93.184.216.34";
const PUBLIC_V6 = "2606:4700::1";

// ---------------------------------------------------------------------------
// Los dobles
// ---------------------------------------------------------------------------

type ResolverScript = {
  /** Direcciones por familia. `Error` = la familia RECHAZA (p. ej. ENODATA). */
  v4?: string[] | Error;
  v6?: string[] | Error;
  /** Ni resuelve ni rechaza: la promesa se queda colgada. Fila 27. */
  hang?: boolean;
};

const cancelSpy = vi.fn();

function resolverDouble(script: ResolverScript): EvidenceResolver {
  const answer = (value: string[] | Error | undefined): Promise<string[]> => {
    if (script.hang) return new Promise<string[]>(() => {});
    if (value instanceof Error) return Promise.reject(value);
    // Sin entrada para la familia, se comporta como c-ares ante un host sin ese
    // registro: RECHAZA con ENODATA. No devuelve una lista vacía.
    if (value === undefined) return Promise.reject(dnsError("ENODATA"));
    return Promise.resolve(value);
  };

  return {
    resolve4: () => answer(script.v4),
    resolve6: () => answer(script.v6),
    cancel: cancelSpy,
  };
}

function dnsError(code: string): Error {
  // La forma real: `getaddrinfo ENOTFOUND ana.example.com` LLEVA EL HOSTNAME en
  // el mensaje. Se reproduce a propósito, para que la fila 30 tenga algo que
  // pueda filtrarse si el verificador registra el objeto de error.
  const err = new Error(`queryA ${code} ${PUBLIC_HOST}`);
  (err as Error & { code: string }).code = code;
  return err;
}

/** Respuesta cuyo CUERPO revienta el test si alguien lo consume. Fila 29. */
function responseDouble(status: number, headers: Record<string, string> = {}): Response {
  const explode = (): never => {
    throw new Error("el verificador ha leído el cuerpo de la respuesta (§8.2 control 7)");
  };

  return {
    status,
    headers: new Headers(headers),
    get body(): never {
      return explode();
    },
    text: explode,
    json: explode,
    arrayBuffer: explode,
    blob: explode,
    formData: explode,
    bytes: explode,
  } as unknown as Response;
}

type FetchCall = { url: string; init: RequestInit | undefined };

/** `fetch` guionizado por URL. Registra cada llamada para poder afirmar sobre
 *  las cabeceras (fila 28) y sobre "no se abrió conexión" (filas 11 y 12). */
function fetchDouble(
  script: Record<string, Response | Error> | ((url: string) => Response | Error)
): { fn: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];

  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const answer = typeof script === "function" ? script(url) : script[url];
    if (answer === undefined) throw new Error(`el doble de fetch no tiene guion para ${url}`);
    if (answer instanceof Error) throw answer;
    return answer;
  }) as typeof globalThis.fetch;

  return { fn, calls };
}

/** El doble que FALLA el test si se le llama: es lo que convierte "devuelve
 *  blocked_address" en "devuelve blocked_address SIN ABRIR LA CONEXIÓN". */
function forbiddenFetch(): { fn: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fn = (async (input: RequestInfo | URL) => {
    calls.push({ url: String(input), init: undefined });
    throw new Error(`se abrió una conexión hacia ${String(input)} y no debía abrirse`);
  }) as typeof globalThis.fetch;
  return { fn, calls };
}

function deps(
  fetchFn: typeof globalThis.fetch,
  script: ResolverScript = { v4: [PUBLIC_V4] }
): EvidenceVerifierDeps {
  return { createResolver: () => resolverDouble(script), fetch: fetchFn };
}

/** Error de red de undici, con la IP INTERNA resuelta en `cause.message`. Es
 *  literalmente lo que §8.5 dice que no puede llegar a un log. */
function networkError(message = "connect ECONNREFUSED 10.0.0.5:443"): Error {
  const cause = new Error(message);
  (cause as Error & { code: string }).code = "ECONNREFUSED";
  const err = new TypeError("fetch failed");
  (err as TypeError & { cause: Error }).cause = cause;
  return err;
}

afterEach(() => {
  cancelSpy.mockClear();
});

// ---------------------------------------------------------------------------
// Filas 9 y 10 — el status manda
// ---------------------------------------------------------------------------

describe("verificador: el status del destino", () => {
  it("fila 9: un 2xx es verified", async () => {
    for (const status of [200, 204]) {
      const { fn } = fetchDouble({ [PUBLIC_URL]: responseDouble(status) });
      await expect(verifyEvidenceUrl(PUBLIC_URL, CONFIG, deps(fn))).resolves.toEqual({
        status: "verified",
        failureReason: null,
      });
    }
  });

  it("fila 10: un 4xx o un 5xx es failed con http_<código>, nunca el cuerpo del destino", async () => {
    for (const status of [404, 403, 500, 502]) {
      const { fn } = fetchDouble({ [PUBLIC_URL]: responseDouble(status) });
      await expect(verifyEvidenceUrl(PUBLIC_URL, CONFIG, deps(fn))).resolves.toEqual({
        status: "failed",
        failureReason: `http_${status}`,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Filas 11 a 15 — la allowlist de rango
// ---------------------------------------------------------------------------

describe("verificador: la allowlist de unicast global", () => {
  it("fila 11: cada rango IPv4 excluido es blocked_address, sin abrir conexión", async () => {
    // La tabla de §8.2 punto 2, rango por rango. Una allowlist y no una
    // enumeración de rangos malos porque el goal 7 es una propiedad CERRADA.
    const blocked = [
      "0.0.0.0", // 0/8, por debajo del límite inferior
      "10.1.2.3", // 10/8
      "100.64.0.1", // 100.64/10 CGNAT
      "127.0.0.1", // 127/8
      "169.254.169.254", // 169.254/16 — el objetivo de más valor
      "172.16.0.1", // 172.16/12
      "172.31.255.255", // 172.16/12, el borde de arriba
      "192.0.0.1", // 192.0.0/24
      "192.0.2.1", // 192.0.2/24
      "192.88.99.1", // 192.88.99/24
      "192.168.1.1", // 192.168/16
      "198.18.0.1", // 198.18/15
      "198.19.255.255", // 198.18/15, el borde de arriba
      "198.51.100.1", // 198.51.100/24
      "203.0.113.1", // 203.0.113/24
      "224.0.0.1", // multicast, por encima del límite superior
      "255.255.255.255", // difusión
    ];

    for (const address of blocked) {
      const { fn, calls } = forbiddenFetch();
      await expect(
        verifyEvidenceUrl(PUBLIC_URL, CONFIG, deps(fn, { v4: [address] })),
        `${address} debería ser blocked_address`
      ).resolves.toEqual({ status: "failed", failureReason: "blocked_address" });
      // Goal 7: se rechaza ANTES de abrir la conexión.
      expect(calls, `${address} no debía abrir conexión`).toHaveLength(0);
    }

    // Y los que SÍ son unicast global pasan, o la fila de arriba sería cierta
    // por bloquearlo todo.
    for (const address of ["1.1.1.1", "93.184.216.34", "172.15.0.1", "172.32.0.1", "223.255.255.255"]) {
      const { fn } = fetchDouble({ [PUBLIC_URL]: responseDouble(200) });
      await expect(
        verifyEvidenceUrl(PUBLIC_URL, CONFIG, deps(fn, { v4: [address] })),
        `${address} debería pasar`
      ).resolves.toEqual({ status: "verified", failureReason: null });
    }
  });

  it("fila 12: cada rango IPv6 excluido es blocked_address, y tampoco abre conexión", async () => {
    const blocked = [
      "::1", // loopback
      "fc00::1", // fc00::/7 ULA
      "fd12:3456::1", // fc00::/7 ULA
      "fe80::1", // fe80::/10 link-local
      "ff00::1", // ff00::/8 multicast
      "64:ff9b::7f00:1", // NAT64 hacia 127.0.0.1
      "100::1", // 100::/64 descarte
      "2002:5db8::1", // 2002::/16 6to4
      "2001:20::1", // 2001::/23 ORCHIDv2
      "2001::1", // 2001::/23 Teredo
      "2001:2::1", // 2001::/23 BMWG
      "2001:db8::1", // 2001:db8::/32 documentación
      "3ffe::1", // 3ffe::/16 — dentro de 2000::/3 y NO excluido: ver abajo
    ];

    for (const address of blocked.slice(0, -1)) {
      const { fn, calls } = forbiddenFetch();
      await expect(
        verifyEvidenceUrl(PUBLIC_URL, CONFIG, deps(fn, { v6: [address] })),
        `${address} debería ser blocked_address`
      ).resolves.toEqual({ status: "failed", failureReason: "blocked_address" });
      expect(calls, `${address} no debía abrir conexión`).toHaveLength(0);
    }

    // `3ffe::/16` (6bone, devuelto al pool) está DENTRO de 2000::/3 y no lo
    // excluye ninguna regla: pasa, y eso es correcto. La allowlist acepta el
    // unicast global entero, no una lista de bloques que nos gusten.
    {
      const { fn } = fetchDouble({ [PUBLIC_URL]: responseDouble(200) });
      await expect(
        verifyEvidenceUrl(PUBLIC_URL, CONFIG, deps(fn, { v6: ["3ffe::1"] }))
      ).resolves.toEqual({ status: "verified", failureReason: null });
    }

    // Y un 2000::/3 legítimo pasa.
    {
      const { fn } = fetchDouble({ [PUBLIC_URL]: responseDouble(200) });
      await expect(
        verifyEvidenceUrl(PUBLIC_URL, CONFIG, deps(fn, { v6: [PUBLIC_V6] }))
      ).resolves.toEqual({ status: "verified", failureReason: null });
    }
  });

  it("fila 13: https://[::]/ es blocked_address, no dns", async () => {
    // EL CASO QUE LA VERSIÓN ENUMERADA DE ESTE CONTROL DEJABA PASAR: en Linux,
    // `::` conecta al propio contenedor. Es un literal, así que no se resuelve —
    // si devolviera `dns` sería porque `isIP()` no está cortocircuitando y se
    // lanzó una consulta por el NOMBRE `"::"`.
    const { fn, calls } = forbiddenFetch();

    await expect(verifyEvidenceUrl("https://[::]/", CONFIG, deps(fn))).resolves.toEqual({
      status: "failed",
      failureReason: "blocked_address",
    });
    expect(calls).toHaveLength(0);

    // Y `0.0.0.0`, su equivalente IPv4, por lo mismo.
    await expect(verifyEvidenceUrl("https://0.0.0.0/", CONFIG, deps(fn))).resolves.toEqual({
      status: "failed",
      failureReason: "blocked_address",
    });
  });

  it("fila 14: una IPv4 mapeada en IPv6 es blocked_address", async () => {
    const { fn, calls } = forbiddenFetch();

    for (const url of ["https://[::ffff:127.0.0.1]/", "https://[::ffff:7f00:1]/"]) {
      await expect(verifyEvidenceUrl(url, CONFIG, deps(fn)), url).resolves.toEqual({
        status: "failed",
        failureReason: "blocked_address",
      });
    }
    expect(calls).toHaveLength(0);

    // Y una mapeada de una dirección PÚBLICA también se bloquea, que es lo
    // correcto: `::ffff:0:0/96` no es unicast global v6.
    await expect(
      verifyEvidenceUrl("https://[::ffff:93.184.216.34]/", CONFIG, deps(fn))
    ).resolves.toEqual({ status: "failed", failureReason: "blocked_address" });
  });

  it("fila 15: el host sale de URL.hostname y de ningún otro sitio", async () => {
    // Los tres casos que el parser WHATWG cierra sin escribir nada. Derivar el
    // host de un regex, de un `split("/")` o de lo que dejó el validador reabre
    // los tres.
    const urls = [
      "https://2130706433/", // normaliza a 127.0.0.1
      "https://0x7f.0.0.1/", // normaliza a 127.0.0.1
      "https://evil.example.com@127.0.0.1/", // el userinfo se descarta
      "https://evil.example.com@169.254.169.254/",
      "https://[::1]/",
    ];

    for (const url of urls) {
      const { fn, calls } = forbiddenFetch();
      await expect(verifyEvidenceUrl(url, CONFIG, deps(fn)), url).resolves.toEqual({
        status: "failed",
        failureReason: "blocked_address",
      });
      expect(calls, `${url} no debía abrir conexión`).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Filas 16, 17 y 18 — las dos familias
// ---------------------------------------------------------------------------

describe("verificador: las dos familias de DNS", () => {
  it("fila 16: una sola familia basta, y el rechazo de la otra no es un fallo", async () => {
    // SIN ESTA FILA, la lectura natural de `Resolver` —llamar a las dos y fallar
    // ante cualquier rechazo— convierte TODO destino IPv4 en failed/dns, que es
    // el camino feliz de la función entera. `resolve6()` rechaza con ENODATA en
    // un host que solo tiene registro A.
    const soloV4 = fetchDouble({ [PUBLIC_URL]: responseDouble(200) });
    await expect(
      verifyEvidenceUrl(PUBLIC_URL, CONFIG, deps(soloV4.fn, { v4: [PUBLIC_V4] }))
    ).resolves.toEqual({ status: "verified", failureReason: null });

    const soloV6 = fetchDouble({ [PUBLIC_URL]: responseDouble(200) });
    await expect(
      verifyEvidenceUrl(PUBLIC_URL, CONFIG, deps(soloV6.fn, { v6: [PUBLIC_V6] }))
    ).resolves.toEqual({ status: "verified", failureReason: null });

    // Y con ENOTFOUND explícito en una familia, no solo con la ausencia.
    const conRechazo = fetchDouble({ [PUBLIC_URL]: responseDouble(200) });
    await expect(
      verifyEvidenceUrl(
        PUBLIC_URL,
        CONFIG,
        deps(conRechazo.fn, { v4: [PUBLIC_V4], v6: dnsError("ENOTFOUND") })
      )
    ).resolves.toEqual({ status: "verified", failureReason: null });
  });

  it("fila 17: la familia no comprobada — A pública y AAAA privada es blocked_address", async () => {
    // ES LA ÚNICA FILA QUE OBLIGA A QUE `resolve6()` ESTÉ CABLEADO: todas las de
    // literal IPv6 se resuelven sin consultar DNS, así que la suite podría estar
    // verde entera sin haberlo llamado nunca. Y con `autoSelectFamily` de Node
    // 22, `fetch` corre Happy Eyeballs y puede conectar justo por ahí.
    const { fn, calls } = forbiddenFetch();

    await expect(
      verifyEvidenceUrl(PUBLIC_URL, CONFIG, deps(fn, { v4: [PUBLIC_V4], v6: ["::1"] }))
    ).resolves.toEqual({ status: "failed", failureReason: "blocked_address" });
    expect(calls).toHaveLength(0);

    // Y al revés: AAAA pública con A privada.
    await expect(
      verifyEvidenceUrl(PUBLIC_URL, CONFIG, deps(fn, { v4: ["10.0.0.5"], v6: [PUBLIC_V6] }))
    ).resolves.toEqual({ status: "failed", failureReason: "blocked_address" });
  });

  it("fila 18: un registro doble dentro de la misma familia se criba entero", async () => {
    // Mirar solo la PRIMERA dirección lo dejaría pasar.
    const { fn, calls } = forbiddenFetch();

    await expect(
      verifyEvidenceUrl(PUBLIC_URL, CONFIG, deps(fn, { v4: [PUBLIC_V4, "10.0.0.5"] }))
    ).resolves.toEqual({ status: "failed", failureReason: "blocked_address" });

    // Y con la privada la primera, por si alguien comprobara solo la última.
    await expect(
      verifyEvidenceUrl(PUBLIC_URL, CONFIG, deps(fn, { v4: ["169.254.169.254", PUBLIC_V4] }))
    ).resolves.toEqual({ status: "failed", failureReason: "blocked_address" });

    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Filas 19 a 24 — las redirecciones, a mano
// ---------------------------------------------------------------------------

describe("verificador: las redirecciones", () => {
  it("fila 19: una redirección a una dirección privada es blocked_address", async () => {
    // Justifica `redirect: "manual"`: seguirlas automáticamente es el bypass
    // clásico, con el primer host público y el `Location` apuntando adentro.
    const { fn, calls } = fetchDouble({
      [PUBLIC_URL]: responseDouble(302, { location: "https://metadatos.example.com/" }),
    });

    const resolvers: Record<string, ResolverScript> = {
      [PUBLIC_HOST]: { v4: [PUBLIC_V4] },
      "metadatos.example.com": { v4: ["169.254.169.254"] },
    };
    let host = PUBLIC_HOST;

    await expect(
      verifyEvidenceUrl(PUBLIC_URL, CONFIG, {
        fetch: fn,
        createResolver: () => {
          const script = resolvers[host];
          host = "metadatos.example.com";
          return resolverDouble(script);
        },
      })
    ).resolves.toEqual({ status: "failed", failureReason: "blocked_address" });

    // Se abrió la primera conexión (la pública) y NO la segunda.
    expect(calls.map((call) => call.url)).toEqual([PUBLIC_URL]);
  });

  it("fila 20: una redirección que cambia de puerto es insecure_redirect", async () => {
    // Es el bypass de un control que solo viviera en el DTO.
    const { fn } = fetchDouble({
      [PUBLIC_URL]: responseDouble(302, { location: `https://${PUBLIC_HOST}:8443/` }),
    });

    await expect(verifyEvidenceUrl(PUBLIC_URL, CONFIG, deps(fn))).resolves.toEqual({
      status: "failed",
      failureReason: "insecure_redirect",
    });
  });

  it("fila 21: una redirección a http es insecure_redirect", async () => {
    const { fn } = fetchDouble({
      [PUBLIC_URL]: responseDouble(301, { location: `http://${PUBLIC_HOST}/` }),
    });

    await expect(verifyEvidenceUrl(PUBLIC_URL, CONFIG, deps(fn))).resolves.toEqual({
      status: "failed",
      failureReason: "insecure_redirect",
    });
  });

  it("fila 22: un Location relativo se resuelve contra el salto actual", async () => {
    // `Location: /login` es el caso común de un repositorio tras autenticación.
    // Resolverlo contra la URL ORIGINAL daría otra ruta en un destino distinto.
    const { fn, calls } = fetchDouble({
      [`https://${PUBLIC_HOST}/proyecto/`]: responseDouble(302, { location: "/login" }),
      [`https://${PUBLIC_HOST}/login`]: responseDouble(200),
    });

    await expect(
      verifyEvidenceUrl(`https://${PUBLIC_HOST}/proyecto/`, CONFIG, deps(fn))
    ).resolves.toEqual({ status: "verified", failureReason: null });

    expect(calls.map((call) => call.url)).toEqual([
      `https://${PUBLIC_HOST}/proyecto/`,
      `https://${PUBLIC_HOST}/login`,
    ]);
  });

  it("fila 23: un 3xx sin Location es malformed_redirect, no una excepción", async () => {
    // Sin esta rama es un `TypeError` y un 500, contra el goal 4.
    const { fn } = fetchDouble({ [PUBLIC_URL]: responseDouble(302) });

    await expect(verifyEvidenceUrl(PUBLIC_URL, CONFIG, deps(fn))).resolves.toEqual({
      status: "failed",
      failureReason: "malformed_redirect",
    });

    // Y un `Location` que no parsea contra el salto actual, por lo mismo.
    const roto = fetchDouble({
      [PUBLIC_URL]: responseDouble(302, { location: "http://[sin-cerrar" }),
    });
    await expect(verifyEvidenceUrl(PUBLIC_URL, CONFIG, deps(roto.fn))).resolves.toEqual({
      status: "failed",
      failureReason: "malformed_redirect",
    });
  });

  it("fila 24: tres saltos verifican, cuatro son too_many_redirects, y un 3xx terminal nunca es verified", async () => {
    const chain = (length: number) =>
      fetchDouble((url) => {
        const hop = Number(url.slice(url.lastIndexOf("/") + 1) || "0");
        if (hop >= length) return responseDouble(200);
        return responseDouble(302, { location: `https://${PUBLIC_HOST}/${hop + 1}` });
      });

    // `EVIDENCE_MAX_REDIRECTS` es 3 porque `http→https`, `apex→www` y un dominio
    // propio encadenan hasta tres en GitHub Pages, que es el artefacto de L1.
    const tres = chain(3);
    await expect(
      verifyEvidenceUrl(`https://${PUBLIC_HOST}/0`, CONFIG, deps(tres.fn))
    ).resolves.toEqual({ status: "verified", failureReason: null });
    expect(tres.calls).toHaveLength(4);

    const cuatro = chain(4);
    await expect(
      verifyEvidenceUrl(`https://${PUBLIC_HOST}/0`, CONFIG, deps(cuatro.fn))
    ).resolves.toEqual({ status: "failed", failureReason: "too_many_redirects" });
    // El cuarto salto NO se sigue: se pidieron 4 URLs y la última contestó 302.
    expect(cuatro.calls).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Filas 25, 26 y 27 — la red que no contesta
// ---------------------------------------------------------------------------

describe("verificador: los fallos de red", () => {
  it("fila 25: conexión rechazada o TLS fallido es network", async () => {
    // ES EL RESULTADO MÁS PROBABLE de pegar la URL de algo aún sin desplegar.
    const casos = [
      networkError("connect ECONNREFUSED 93.184.216.34:443"),
      networkError("write EPROTO ... alert handshake failure"),
    ];

    for (const err of casos) {
      const { fn } = fetchDouble({ [PUBLIC_URL]: err });
      await expect(verifyEvidenceUrl(PUBLIC_URL, CONFIG, deps(fn))).resolves.toEqual({
        status: "failed",
        failureReason: "network",
      });
    }
  });

  it("fila 26: ninguna familia devuelve direcciones es dns", async () => {
    const { fn, calls } = forbiddenFetch();

    await expect(
      verifyEvidenceUrl(
        PUBLIC_URL,
        CONFIG,
        deps(fn, { v4: dnsError("ENOTFOUND"), v6: dnsError("ENOTFOUND") })
      )
    ).resolves.toEqual({ status: "failed", failureReason: "dns" });

    // Y una unión vacía sin rechazo tampoco es "ok con cero direcciones".
    await expect(
      verifyEvidenceUrl(PUBLIC_URL, CONFIG, deps(fn, { v4: [], v6: [] }))
    ).resolves.toEqual({ status: "failed", failureReason: "dns" });

    expect(calls).toHaveLength(0);
  });

  it("fila 27: un DNS que no contesta agota el presupuesto TOTAL y devuelve timeout", async () => {
    // Exige que cada operación reciba el tiempo RESTANTE como tope, no solo una
    // comprobación antes de empezar: una resolución lanzada a un milisegundo del
    // límite correría después su duración entera y se comería el margen de
    // `EVIDENCE_BRIDGE_TIMEOUT_MS`, que es el fallo que ese margen evita.
    const budget = 250;
    const { fn, calls } = forbiddenFetch();
    const started = Date.now();

    await expect(
      verifyEvidenceUrl(PUBLIC_URL, { timeoutMs: budget, maxRedirects: 3 }, deps(fn, { hang: true }))
    ).resolves.toEqual({ status: "failed", failureReason: "timeout" });

    const elapsed = Date.now() - started;
    // Bajo el presupuesto más el margen del planificador. Sin la carrera de
    // `withDeadline` esto no termina nunca: el doble no resuelve ni rechaza.
    expect(elapsed, `tardó ${elapsed} ms con un presupuesto de ${budget} ms`).toBeLessThan(
      budget * 3
    );
    // Y se llamó a `cancel()`, que es lo que libera la consulta de c-ares en vez
    // de dejarla corriendo detrás de una respuesta ya devuelta.
    expect(cancelSpy).toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Filas 28, 29 y 30 — lo que sale y lo que no
// ---------------------------------------------------------------------------

describe("verificador: lo que no sale de aquí", () => {
  it("fila 28: la petición saliente no lleva credenciales", async () => {
    const { fn, calls } = fetchDouble({ [PUBLIC_URL]: responseDouble(200) });

    await verifyEvidenceUrl(PUBLIC_URL, CONFIG, deps(fn));

    expect(calls).toHaveLength(1);
    const headers = new Headers(calls[0].init?.headers ?? {});
    // Sin `Authorization`, sin cookies, sin cabecera propia: no hay nada que
    // filtrar a un destino hostil (§8.2 control 6).
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("cookie")).toBeNull();
    expect([...headers.keys()]).toEqual([]);
    // Y la afirmación positiva que impide que las de arriba pasen por vacuidad.
    expect(calls[0].init?.redirect).toBe("manual");
    expect(calls[0].init?.method).toBe("GET");
  });

  it("fila 29: el cuerpo de la respuesta no se consume", async () => {
    // El doble revienta si alguien toca `body`, `text()`, `json()` o
    // `arrayBuffer()`. Sin lectura no hay exfiltración de contenido, no hay
    // bomba de descompresión, y los redirects por HTML son irrelevantes.
    const { fn } = fetchDouble({
      [PUBLIC_URL]: responseDouble(302, { location: `https://${PUBLIC_HOST}/final` }),
      [`https://${PUBLIC_HOST}/final`]: responseDouble(200),
    });

    await expect(verifyEvidenceUrl(PUBLIC_URL, CONFIG, deps(fn))).resolves.toEqual({
      status: "verified",
      failureReason: null,
    });
  });

  it("fila 30: ni el host ni la IP resuelta llegan a los logs", async () => {
    // `Test.createTestingModule().compile()` instala un logger que anula `log` y
    // `warn` (`apps/api/CLAUDE.md:24`), y estos ficheros comparten worker con
    // los que lo compilan. Se restaura uno de verdad para que la captura no esté
    // vacía por accidente y la NEGACIÓN de abajo no pase por vacuidad.
    Logger.overrideLogger(new ConsoleLogger());

    const interno = "10.0.0.5";
    const { fn } = fetchDouble({
      [PUBLIC_URL]: networkError(`connect ECONNREFUSED ${interno}:443`),
    });

    const captured = captureOutput();
    let output: string;
    try {
      await expect(verifyEvidenceUrl(PUBLIC_URL, CONFIG, deps(fn))).resolves.toEqual({
        status: "failed",
        failureReason: "network",
      });
    } finally {
      output = captured.stop();
    }

    // AFIRMACIÓN POSITIVA PRIMERO: sin ella, las tres negaciones de abajo son
    // trivialmente ciertas sobre una salida vacía.
    expect(output).not.toBe("");
    expect(output).toContain("EvidenceVerifier");
    expect(output).toContain("reason=network");
    // Solo `name` y `cause.code` (§8.5, `common/error-fields.ts`).
    expect(output).toContain("name=TypeError");
    expect(output).toContain("code=ECONNREFUSED");

    // Y NADA de lo que §8.5 prohíbe: ni el host, ni la IP interna que undici
    // trae en `cause.message`, ni el mensaje entero, ni la URL.
    expect(output).not.toContain(PUBLIC_HOST);
    expect(output).not.toContain(interno);
    expect(output).not.toContain("fetch failed");
    expect(output).not.toContain(PUBLIC_URL);
    expect(output).not.toContain("/mi-web");
  });

  it("fila 30 (hermana): tampoco los registra un fallo de DNS, que trae el hostname en el mensaje", async () => {
    // `getaddrinfo ENOTFOUND ana.example.com` LLEVA EL HOSTNAME. Es el otro
    // camino por el que §8.5 dice que se fuga, y el verificador no registra nada
    // en él porque el `dns` se decide sin mirar el error.
    Logger.overrideLogger(new ConsoleLogger());

    const { fn } = forbiddenFetch();
    const captured = captureOutput();
    let output: string;
    try {
      await verifyEvidenceUrl(
        PUBLIC_URL,
        CONFIG,
        deps(fn, { v4: dnsError("ENOTFOUND"), v6: dnsError("ENOTFOUND") })
      );
    } finally {
      output = captured.stop();
    }

    expect(output).not.toContain(PUBLIC_HOST);
    expect(output).not.toContain("queryA");
  });
});
