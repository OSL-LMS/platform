// Guard de tasa que cuenta por CREDENCIAL cuando la hay, y por IP cuando no.
//
// POR QUÉ NO VALE CONTAR POR IP EN `/v1/access*`. El único llamante legítimo de
// esos endpoints es el servidor de Next: `src/lib/api-client.ts` hace `fetch`
// desde el proceso de `apps/web`, no desde el navegador del estudiante. Así que
// todas las peticiones de todos los estudiantes llegan con la MISMA IP de
// origen — la del contenedor de Next por la red privada, o la de su salida a
// internet si el puente va por el dominio público. Un cubo por IP sería
// entonces un cubo único para el producto entero: 120/min repartidos entre
// todos, unas 2 peticiones por segundo, y el primer día con clase llena da 429
// a estudiantes legítimos. El fallo no se ve en local ni en los tests, donde el
// llamante es el propio test.
//
// La credencial sí separa: cada estudiante trae su propio JWT de sesión. Se usa
// el hash de la cabecera y no la cabecera cruda para no dejar tokens de sesión
// como claves en memoria.
//
// El webhook de Paddle no manda `Authorization` y cae al camino de IP, que ahí
// SÍ es el eje correcto: lo llama Paddle desde internet, no Next.
//
// ponytail: quien mande tokens fabricados consigue un cubo nuevo por token, así
// que esto no frena una inundación que rote credenciales — solo le cuesta un
// intento de descifrado de JWE por petición en `SessionGuard`. Si eso llega a
// doler, la subida es un segundo throttler con nombre que cuente por IP con
// techo alto (del orden de 1200/min): no molesta al tráfico real de Next y
// corta la rotación desde una sola procedencia.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { createHash } from "node:crypto";

import { Injectable } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";

@Injectable()
export class BridgeThrottlerGuard extends ThrottlerGuard {
  protected override getTracker(req: Record<string, unknown>): Promise<string> {
    const headers = req.headers as Record<string, string | undefined> | undefined;
    const authorization = headers?.authorization;

    if (authorization) {
      const digest = createHash("sha256").update(authorization).digest("hex").slice(0, 32);
      return Promise.resolve(`tok:${digest}`);
    }

    return Promise.resolve(`ip:${(req.ip as string | undefined) ?? "desconocida"}`);
  }
}
