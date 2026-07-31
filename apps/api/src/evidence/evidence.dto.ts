// El cuerpo de `POST /v1/evidence` (PRD-007 §5.1).
//
// Bajo el `ValidationPipe` global con `whitelist: true` + `forbidNonWhitelisted:
// true` (`bootstrap.ts:27`): un campo de más es 400, no un campo ignorado. Eso
// es la mitad ESTRUCTURAL del control de §8.1 — "un estudiante no puede tocar la
// evidencia de otro" no es una comprobación, es que un `userId` en el cuerpo ni
// siquiera llega al servicio. Filas 2 y 36 de §9.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { isIP } from "node:net";

import {
  IsString,
  Matches,
  MaxLength,
  Validate,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from "class-validator";

import { SLUG_PATTERN } from "../curriculum/curriculum-context.ts";
import { hostnameOf } from "./evidence-verifier.ts";

/** Cota de la URL entregada. Por debajo de la cota de aplicación de 64 kb de
 *  `bootstrap.ts:19`, que acota el cuerpo entero pero no un campo. */
export const MAX_EVIDENCE_URL_CHARS = 2_048;

/**
 * ¿Es una URL que este servicio está dispuesto a comprobar?
 *
 * POR QUÉ UN VALIDADOR PROPIO Y NO `@IsUrl()` A SECAS. Los defectos de
 * `@IsUrl()` incluyen `require_tld: true`, así que `https://localhost/` moriría
 * en el pipe con un 400 y nunca llegaría al control de rango — un comportamiento
 * correcto por accidente y por la razón equivocada. Este comprueba lo que hace
 * falta y lo dice: esquema `https:`, puerto vacío o `"443"`, y un host no vacío
 * CON AL MENOS UN PUNTO salvo que sea un literal IP.
 *
 * LA EXIGENCIA DE FQDN ES UN CONTROL DE SEGURIDAD, NO HIGIENE. Desde que el
 * cribado usa c-ares (§8.2 control 3) y la conexión sigue usando `getaddrinfo`,
 * las dos mitades son pilas DISTINTAS, no solo momentos distintos: difieren en
 * la lista `search` de `resolv.conf`, que `getaddrinfo` aplica a los nombres con
 * menos puntos que `ndots` y c-ares no. En un contenedor con dominio de búsqueda
 * interno —`*.railway.internal`, o cualquier montaje tipo Kubernetes— un host de
 * UNA SOLA ETIQUETA que resuelve públicamente se criba contra la dirección
 * pública y se CONECTA A LA INTERNA. Es fail-open. Ningún estudiante publica en
 * un host sin puntos, así que exigir uno cierra la clase entera sin coste.
 *
 * QUE UN LITERAL IP SEA ACEPTABLE ES DELIBERADO: el control de destino es el
 * RANGO RESUELTO (§8.2), no la forma del host. `https://127.0.0.1/` pasa aquí y
 * muere en el verificador con `blocked_address`, que es donde tiene que morir.
 * Fila 5 de §9 fija las dos mitades.
 *
 * NUNCA LANZA. `new URL(123)` lanza `TypeError` y class-validator no envuelve
 * las restricciones personalizadas síncronas: propagar convertiría un
 * `{"url": 123}` en un 500 donde §5.1 promete 400. Fila 8 de §9.
 */
export function isEvidenceUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol !== "https:") return false;

  // El parser WHATWG borra el puerto por defecto del esquema, así que
  // `new URL("https://x:443/").port` es `""` y la rama del `"443"` literal no se
  // alcanza. Se deja escrita como RED DE SEGURIDAD, no como comparación muerta
  // que alguien deba "arreglar" relajándola.
  if (url.port !== "" && url.port !== "443") return false;

  // El host se deriva EXACTAMENTE como en §8.2 —de ahí que la función se
  // comparta y no se copie—, y los corchetes se quitan ANTES de `isIP()` y de la
  // exigencia del punto. `URL.hostname` los CONSERVA en un literal IPv6, así que
  // sin quitarlos `isIP()` daría 0, el host no tendría ningún punto, y esta regla
  // daría 400 A TODO LITERAL IPv6 — contradiciendo la fila 5 de §9 y el paso 4 de
  // §10. La salida tentadora ante esa fila roja es la mala: relajar la exigencia
  // del punto reabre el fail-open de la lista `search` que esa exigencia existe
  // para cerrar.
  const host = hostnameOf(url);
  if (host === "") return false;
  if (isIP(host) !== 0) return true;

  return host.includes(".");
}

@ValidatorConstraint({ name: "isEvidenceUrl", async: false })
export class IsEvidenceUrlConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isEvidenceUrl(value);
  }

  defaultMessage(): string {
    return "url tiene que ser https, en el puerto 443, y apuntar a un host cualificado o a un literal IP";
  }
}

export class EvidenceDto {
  // `@IsString()` VA PRIMERO en los dos campos, que es el idiom que
  // `turn.dto.ts:37` ya usa. En `url` además importa: class-validator ejecuta
  // TODAS las restricciones de una propiedad y no se detiene en la primera que
  // falla, así que el orden es legibilidad —y lo que de verdad impide el 500 es
  // que `isEvidenceUrl` devuelva `false` en vez de propagar.
  @IsString()
  @Matches(SLUG_PATTERN)
  lessonSlug!: string;

  @IsString()
  @MaxLength(MAX_EVIDENCE_URL_CHARS)
  @Validate(IsEvidenceUrlConstraint)
  url!: string;
}
