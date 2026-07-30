// El cuerpo de `POST /v1/tutor/turn` (PRD-005 §5.1).
//
// ES EL PRIMER DTO DECORADO DEL SERVICIO, y eso retira una invariante escrita
// (§8.4): hasta hoy el `ValidationPipe` global de `bootstrap.ts:45` NO se
// ejecutaba, porque el pipe solo actúa sobre parámetros decorados y tipados
// contra un DTO y ningún handler declaraba uno. Desde aquí sí corre.
//
// LO QUE ESO **NO** CAMBIA: el control de identidad de `/v1/access*` sigue
// siendo estructural —esos handlers no declaran `@Body()`, `@Query()` ni
// `@Param()`—, con independencia de que el pipe ya esté vivo. El aviso de
// `access.controller.ts:17-21` conserva su conclusión y pierde su premisa.
//
// `whitelist: true` + `forbidNonWhitelisted: true` ya están activos, así que un
// cuerpo con `messages`, `email` o cualquier campo extra es **400**, no un campo
// ignorado en silencio. Es deliberado y es la mitad de seguridad del goal 2: el
// cliente manda UN mensaje —el suyo— y el hilo sale de `conversations`. Un
// `messages: [...]` fabricado ni siquiera llega al servicio. Filas 3 y 20-21 de
// §9.
//
// Regla de código: identificadores en inglés, comentarios en español.

import { IsOptional, IsString, Length, Matches } from "class-validator";

/** El patrón de `src/app/api/chat/route.ts:29`, movido tal cual. `lesson` es
 *  entrada NO CONFIABLE: solo se usa como clave de búsqueda contra
 *  `curriculum_nodes` y nunca se interpola en el prompt. Se valida ANTES de
 *  tocar la base porque desde PRD-002 usarlo como clave puede costar un viaje a
 *  Postgres. */
export const LESSON_SLUG_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Cota del turno del estudiante. Con el hilo fuera del cuerpo (§5.2), la cota
 *  de aplicación de 64 kb (`bootstrap.ts:19`) deja de ser alcanzable por uso
 *  normal: lo que viaja es un mensaje, no una conversación. */
export const MAX_MESSAGE_CHARS = 4_000;

export class TurnDto {
  @IsString()
  @Length(1, MAX_MESSAGE_CHARS)
  message!: string;

  @IsOptional()
  @IsString()
  @Matches(LESSON_SLUG_PATTERN)
  lesson?: string;
}
