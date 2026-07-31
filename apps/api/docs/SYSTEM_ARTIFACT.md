# SYSTEM_ARTIFACT — apps/api

**Documento vivo.** Describe lo que el paquete hace **ahora**. No es historia: para saber por qué está construido así, lee el PRD que lo introdujo, en `../../../specforge/`.

**Alcance.** Este archivo cubre `apps/api` y nada más. Los dominios que cruzan paquetes están **partidos** desde 2026-07-31, cuando el registro de siblings pasó de una fila a tres: cada mitad vive con el código que la implementa y la otra se referencia por nombre. Los tres documentos son:

| Sibling | Documento |
|---|---|
| `apps-web` | `apps/web/docs/SYSTEM_ARTIFACT.md` |
| `apps-api` | `apps/api/docs/SYSTEM_ARTIFACT.md` |
| `shared` | `packages/shared/docs/SYSTEM_ARTIFACT.md` |

## Cómo se mantiene

Se actualiza en el mismo commit que promociona un PRD a `Implemented` (hard rule 8). Si un cambio toca dos paquetes, se actualizan los dos documentos y el `system_artifact_diff` del gate lista los dos.

Lo que va aquí: entidades, capacidades, invariantes y deuda abierta. Lo que **no** va: decisiones y sus alternativas —eso es un ADR— ni el detalle de implementación de un cambio concreto —eso es un PRD—.

## Domain: `acceso`

**Source PRDs**: PRD-003 (fase 1)
**Primary owners**: mantenedores del repo

### Overview

La frontera gratis/pago. Trial de 7 días sin tarjeta que **arranca con el primer mensaje al tutor**, no al hacer login: entrar a curiosear no gasta la prueba. Vencido el trial o cancelada la suscripción, el chat se sustituye por el muro de pago (Paddle).

**Este dominio vive entero en `apps/api`. En la raíz no queda implementación.** PRD-003 lo portó a un servicio NestJS aparte detrás de `ACCESS_VIA_API`, y el paso 5 de esa migración (2026-07-28) retiró el camino viejo: se borró `apps/web/src/app/api/paddle/webhook/route.ts`, `packages/shared/src/access.ts` quedó reducido al tipo `Access`, y el flag desapareció con sus dos ramas muertas. Next conserva **solo** el puente (`apps/web/src/lib/api-client.ts`) y el lado navegador del checkout (`paywall.tsx`, `/checkout`). Quien depure acceso o cobro mira `apps/api`.

**Ya no hay rollback sin desplegar.** Mientras existió el flag, apagarlo devolvía el tráfico al camino en proceso con un reinicio. Ese camino ya no está en el código: revertir hoy es un `git revert` del commit del paso 5.

### Key Entities

#### `subscriptions`

| Column | Type | Notes |
|---|---|---|
| id | uuid | pk, `defaultRandom()` |
| email | text | not null, **unique** — la llave que enlaza con Paddle |
| status | enum `subscription_status` | `trial` \| `active` \| `canceled`, default `trial` |
| trial_ends_at | timestamp | fin del trial de 7 días |
| paddle_subscription_id | text | lo escribe el webhook |
| created_at / updated_at | timestamp | `defaultNow()` |

El estado derivado que consume la app es `Access = { allowed, status: "none" \| "trial" \| "active" \| "canceled", trialDaysLeft }`. `"none"` (sin fila) significa "aún no ha hablado con el tutor" y **permite ver el chat**.

### Main Capabilities

| Capability | Surface | Introduced in |
|---|---|---|
| Leer acceso sin efectos secundarios | `GET /v1/access` — `apps/api/src/access/access.service.ts` | PRD-003 |
| Crear el trial y devolver acceso | `POST /v1/access/trial` — llamado **solo** desde `/api/chat` de Next | PRD-003 |
| Escribir el estado que manda Paddle (upsert) | `setSubscriptionStatus` — `apps/api/src/access/subscriptions.repository.ts` | PRD-003 |
| Webhook de Paddle | `POST /v1/webhooks/paddle` — `apps/api`. **Único destino** desde el paso 5 | PRD-003 |
| Muro de pago con checkout de Paddle | `apps/web/src/app/paywall.tsx` | — |
| Payment link por defecto de Paddle (`?_ptxn=`) | `/checkout` (pública) | — |
| Utilidades de dev: consultar / vencer un trial | `scripts/check-sub.mjs`, `scripts/expire-trial.mjs` | — |
| Reconciliación periódica contra Paddle (solo concede acceso; las revocaciones se cuentan y las aplica una persona) | `apps/api/src/reconcile/` — proceso `worker.ts`, ver `Background jobs` | PRD-004 |
| Puente de sesión entre servicios | Next reenvía el JWT de Auth.js como `Bearer`; `SessionGuard` lo verifica con `getToken()` de `@auth/core/jwt` | PRD-003 |
| Alcanzar `apps/api` desde `apps/web` | `API_BASE_URL` = `https://api.contextia.io` — **sobre TLS**, por el dominio público. Ya no usa la red privada de Railway | PRD-003 |
| Límite de tasa | `@nestjs/throttler` como guard global: **120/min por credencial** en `/v1/access*`, **600/min por IP** en el webhook, `/health` exento. `apps/api/src/throttle.ts` | — |
| Alcanzar `apps/api` desde Paddle | `https://api.contextia.io` — dominio propio del servicio `api` (CNAME en Cloudflare, **DNS only**, puerto 8080). Destino de Paddle `ntfset_01kyn17g…`, 7 eventos, secreto propio | PRD-003 |

### Key Invariants

- **`GET /v1/access` solo lee. Desde PRD-005 el creador real de la fila es `POST /v1/tutor/turn`**, que llama `ensureTrial` en proceso. `POST /v1/access/trial` sigue existiendo y **quedó sin llamante** al retirarse el camino local del tutor: se conserva a propósito —no concede nada que el estudiante no consiga escribiéndole al tutor, y retirarlo borraría las filas 21 y 22 del §9 de PRD-003, que está congelado—, con la razón escrita en `apps/api/src/access/access.controller.ts`. Si algún día hay que recortar esa superficie, el trabajo correcto es un PRD que supersede a PRD-003, no un borrado suelto.
- **`POST /v1/access/trial` era el único que creaba la fila.** Renderizar `/chat` nunca arranca la prueba. **Lo que cambió con PRD-003**: antes esa invariante la garantizaba el call site —la función que creaba el trial era privada del módulo y solo la llamaba `POST /api/chat`—; ahora es un endpoint alcanzable, así que la garantía pasa a ser "solo Next lo llama". Cualquiera con sesión válida puede arrancar su propio trial con un `curl` sin escribirle al tutor: el daño es nulo (quema su propia prueba) pero desacopla `trial_started` de `tutor_message_sent`.
- El evento `trial_started` se emite **solo** cuando ese request creó la fila (`returning()` no vacío): un trial, un evento. La carrera de dos primeros mensajes simultáneos se resuelve releyendo la fila tras el `onConflictDoNothing`.
- El webhook **debe leer el body crudo**; parsear a JSON antes rompe la verificación de firma del SDK de Paddle. En `apps/api` es `rawBody: true` más `.toString("utf8")`, porque `req.rawBody` es un `Buffer` y `unmarshal` espera `string`.
- **La identidad en `apps/api` sale del token y de ningún otro sitio.** Los handlers de `/v1/access*` no declaran `@Body()`, `@Query()` ni `@Param()`: ése es el control, y lo sigue siendo. **Lo que cambió con PRD-005**: `turn.dto.ts` es el primer DTO decorado del servicio, así que el `ValidationPipe` global **sí se ejecuta** desde entonces — la conclusión del control estructural no cambia, su premisa sí. `bootstrap.ts` exporta ahora sus opciones para que el spec del DTO ejercite el pipe de producción y no uno construido en el test. Un `email` suministrado por el llamante se ignora — si se leyera, cualquiera con sesión válida leería y escribiría la fila de cualquier otro, siendo `email` la llave única.
- **El puente va sobre TLS, y el precio está medido.** `API_BASE_URL` apunta al dominio público `https://api.contextia.io`, no a la red privada de Railway. Por ese salto viajan el correo del estudiante y **el JWT de sesión** —una credencial portadora de ~30 días sin revocación individual—, y eso es lo que exige PRD-003 § 8 ("solo sobre TLS"). La decisión estuvo un rato del otro lado: la red privada aísla pero no cifra, y se aceptó a sabiendas hasta que se midió el coste real desde dentro del contenedor de Next — **p50 4,5 → 7,2 ms y p95 5,7 → 9,7 ms**, o sea **+4 ms p95** contra el presupuesto de +200 ms de ADR-001 § 6. Un 2% del margen a cambio de quitar una credencial en claro de la red. **Quien piense en volver a `api.railway.internal` por latencia**: el número dice que no hay nada que ganar.
- **El eje del límite de tasa en `/v1/access*` es la credencial, no la IP, y no es una preferencia.** El único llamante legítimo de esos endpoints es el servidor de Next (`apps/web/src/lib/api-client.ts` hace `fetch` desde el proceso de `apps/web`, no desde el navegador), así que **todas** las peticiones de **todos** los estudiantes llegan con la misma IP de origen. Con un contador por IP, los 120/min serían un cubo único para el producto entero —unas 2 peticiones por segundo— y el primer día con clase llena daría 429 a estudiantes legítimos. No se ve ni en local ni en los tests, donde el llamante es el propio test. El webhook sí cuenta por IP, porque ahí quien llama es Paddle desde internet.
- **`app.set("trust proxy", 1)` es lo que hace real el límite de tasa.** Detrás del proxy de Railway todas las peticiones llegan con la misma IP de origen: sin esa línea los 120/min son un cubo único para el mundo entero, y el primer bucle automatizado deja a todos los estudiantes en 429. Falla en silencio y **en local funciona bien**, porque en local no hay proxy. El `1` además lo hace resistente a suplantación —se lee la última entrada de `X-Forwarded-For`, que la añade el borde— y subirlo abriría esa puerta.
- **`AUTH_COOKIE_NAME` es obligatoria y sin defecto** en los dos servicios. El `salt` de Auth.js es el nombre de la cookie, y Auth.js elige el prefijo `__Secure-` según el **protocolo de la petición**, no según `NODE_ENV`; `apps/api` recibe un Bearer y no puede ver ese protocolo, así que no puede adivinarlo. Un desajuste produce 401 para todo el mundo.
- **`apps/web` nunca reenvía la cabecera `Cookie`** a `apps/api`: `getToken()` prefiere la cookie sobre el Bearer, así que reenviarla abriría un segundo canal de credencial no declarado. **PRD-005 lo conserva y por eso eligió el proxy**: el camino directo (navegador contra `apps/api`) habría retirado esta invariante junto con otras tres, y habría dejado abierta una variante de fijación de sesión —sobrescritura de cookie desde cualquier subdominio— que ningún control de servidor cierra. El conjunto de cabeceras salientes del proxy es cerrado: `Authorization` y `Content-Type`.
- **`apps/api` acepta la cookie de sesión si llega, aunque nadie se la mande.** `getToken()` la prefiere sobre el Bearer y `SessionGuard` no la filtra. No es un hueco —esa cookie solo autentica a su propio dueño— pero conviene saberlo antes de "endurecer" el guard con un filtro que ningún PRD ha especificado.
- El webhook responde **200 incluso ante un error propio** (lo registra en consola) para que Paddle no reintente en bucle. Firma inválida o evento ausente sí devuelven 400.
- El correo llega desde Paddle en `customData.email` del checkout y se pasa a minúsculas antes de escribir.
- **El webhook escribe con upsert, nunca con `UPDATE` a secas**: un pago puede llegar sin fila previa (`/checkout` es público y los flujos hospedados de Paddle no pasan por el tutor). `paddle_subscription_id` solo se sobrescribe si el evento trae uno.
- El entorno de Paddle es `sandbox` salvo que valga exactamente `production`: `PADDLE_ENV` en `apps/api` (servidor) y `NEXT_PUBLIC_PADDLE_ENV` en Next (navegador). Desde el paso 5, Next ya no lee `PADDLE_ENV`.

### Open Debt

- ~~No hay reconciliación periódica contra la API de Paddle~~ — **cerrada a medias por PRD-004** (ver `Background jobs`). El barrido repara la dirección que duele: quien paga y está bloqueado. La contraria —Paddle dice `canceled`, nosotros `active`— se detecta y se cuenta, pero **no se escribe**, así que a quien canceló y cuyo webhook se perdió se le sigue sirviendo el tutor hasta que una persona actúe sobre el contador `pendiente_revocacion`. Es fuga de ingresos acotada y visible en cada pasada, aceptada a cambio de no tener ninguna escritura destructiva automática.
- `EventName.SubscriptionUpdated` deriva `canceled` de `data.status`; el resto de estados de Paddle (`paused`, `past_due`) caen a `active`.
- **`apps/api` registra un listener `error` en el pool de `pg`** (`apps/api/src/db/drizzle.module.ts`). Sin él, un cliente **ocioso** caído —reinicio de la base, corte del proxy— es una excepción no capturada que tumba el proceso: es el único camino por el que una excepción no pasa por el filtro global, porque no nace dentro de una petición. **Desde PRD-004 sí hay test** (`apps/api/src/db/drizzle.module.spec.ts`): el `max` del pool pasó a salir de la configuración inyectada, y esa fábrica quedó cubierta junto con el listener, así que un refactor que lo borre ahora se pone rojo. `packages/shared/src/db.ts` sigue sin listener, de antes de PRD-003.
- **Tres comprobaciones del rollout de PRD-003 no son repetibles.** Que `/chat` renderice con historial y selector durante una degradación, que el 503 del tutor no emita `tutor_message_sent`, y que un 401 de `apps/api` no redirija a `/signin` se verifican **a mano** en el paso 3, porque afirman sobre render de Server Components y `next/headers`, que el runner de `scripts/` no puede ejecutar. Quien toque `apps/web/src/app/chat/page.tsx` o `apps/web/src/app/api/chat/route.ts` después de esta fase tiene que re-verificarlas a mano.
- **`apps/web/src/lib/pixel.ts` existe por una restricción de Next**, no por diseño: `shouldEmitPageview()` no puede exportarse desde `apps/web/src/app/api/t/route.ts` porque un Route Handler solo admite exports de métodos HTTP y claves de configuración. PRD-003 no lo nombra.
- **Hay un tercer destino de Paddle apuntando a la raíz del sitio.** `ntfset_01kvzvre…` ("Tutor") manda **56 tipos de evento** —incluidos `api_key.created` y `address.imported`— a `https://contextia.io`, que no es una ruta de webhook: no hay handler ahí y nunca lo hubo. No rompe nada porque nadie lo lee, pero es superficie de entrega fallida permanente en el panel de Paddle y ruido que enmascara un fallo real. Candidato a borrar.
- **El límite de tasa no frena una inundación que rote credenciales.** En `/v1/access*` el cubo es por token, así que quien fabrique tokens distintos consigue uno nuevo cada vez; le cuesta un intento de descifrado de JWE por petición en `SessionGuard` y nada más. Si llega a doler, la subida es un segundo throttler con nombre que cuente por IP con techo alto (del orden de 1200/min): no molesta al tráfico real de Next —que llega todo desde una sola IP— y corta la rotación desde una sola procedencia. Anotado en `apps/api/src/common/bridge-throttler.guard.ts`.

---

---

## Domain: `tutor`

**Source PRDs**: — (anterior a la adopción de specforge)
**Primary owners**: mantenedores del repo

### Overview

El chat socrático sobre Claude Sonnet 4.6 (`claude-sonnet-4-6`) con streaming. El system prompt está certificado por un banco de evals y es invariante; el temario del curso viaja como bloque de contexto aparte, así que una clase nueva no obliga a recertificar el tutor.

### Key Entities

#### `conversations`

| Column | Type | Notes |
|---|---|---|
| id | uuid | pk, `defaultRandom()` |
| user_id | text | fk → `user.id`, `onDelete: cascade` |
| messages | jsonb | `{role, content}[]`, default `[]` |
| created_at / updated_at | timestamp | `defaultNow()` |

### Main Capabilities

| Capability | Surface | Introduced in |
|---|---|---|
| Turno del tutor en streaming (`text/plain`, `no-store`) | `POST /v1/tutor/turn` — `apps/api/src/tutor/` | PRD-005 |
| Proxy del turno: cookie → Bearer, cuerpo y respuesta sin bufferizar | `POST /api/chat` — `apps/web/src/app/api/chat/route.ts` + `streamTutorTurn()` en `apps/web/src/lib/api-client.ts` | PRD-005 |
| Prompt certificado v0.6 | `TUTOR_SYSTEM_PROMPT` — `packages/shared/src/tutor-prompt.ts`, re-exportado por `apps/api/src/tutor/tutor-prompt.ts` | — |
| Bloque de contexto de la lección | `buildLessonContext(moduleLessons, ancestors, lessonSlug?)` — `packages/shared/src/curriculum-context.ts`, re-exportado por `apps/api/src/tutor/` | PRD-002 |
| Memoria de la conversación (escritura) | `getOrCreate`, `append` — `apps/api/src/tutor/conversations.repository.ts` | PRD-005 |
| Memoria de la conversación (lectura para el render) | `loadConversation` — `apps/web/src/lib/conversations.ts` | PRD-005 |
| Ventana de contexto enviada al modelo | `trimWindow()`, `MAX_WINDOW_MESSAGES = 30` — `packages/shared/src/window.ts`, re-exportado por `apps/api/src/tutor/window.ts` | — |
| Render de código y énfasis del tutor | `formatMessage()` — `apps/web/src/lib/format-message.ts` | — |
| Pantalla del tutor (Server Component protegido) | `/chat` | — |

### Key Invariants

- `POST /api/chat` exige `session.user.id` **y** `session.user.email`; sin ambos → 401. Sin acceso permitido → 403.
- **El prompt no sabe nada del curso.** Módulo, lecciones y atascos son dato en `curriculum_nodes` y viajan como segundo bloque de system. Cambiar `TUTOR_SYSTEM_PROMPT` exige pasar el banco de 35 evals antes de desplegar — y desde PRD-002 la misma exigencia cubre las **cuatro** llaves de `curriculum/<slug>.json` que alcanzan ese bloque (`stuck`, `outcome`, `audience`, `title`), porque la regla se indexa por destino del contenido, no por ruta de archivo. (`scope` **no** llega al tutor; lleva los mismos guardas por otra vía — ver dominio `contenido`.)
- El primer bloque de system lleva `cache_control: ephemeral`; el bloque de temario no — de ahí la cota de 4 000 caracteres por valor: lo que entre ahí se factura como entrada no cacheada en cada petición de cada usuario.
- **`body.lesson` es entrada no confiable**: se valida contra `/^[A-Za-z0-9_-]{1,64}$/` antes de tocar la base y solo se usa como clave de búsqueda, nunca se interpola en el prompt. Si no coincide, el tutor pregunta en vez de adivinar.
- **Un currículo sin cargar no tumba el tutor**: `getLessonContextInputs()` nunca lanza y devuelve el par vacío, que es la rama "el estudiante no ha declarado lección". `CurriculumNotLoadedError` sí alcanza a la home, `/chat` y `/registro`.
- La regla pedagógica inviolable del prompt: nunca entrega la solución de un ejercicio, ni nombra ni transcribe parcialmente la pieza que la resuelve. Explicar conceptos sí; resolver ejercicios no.
- **Una conversación por usuario en v0**: siempre la más reciente por `updated_at`.
- `append` concatena en SQL (`messages || $payload::jsonb`) para no pisar escrituras concurrentes.
- La persistencia ocurre **después** de cerrar el stream y en su propio `try/catch`: no añade latencia y su fallo no rompe la respuesta ya entregada. Desde PRD-005 ese fallo es **amnesia**, no solo un guardado perdido: el hilo que ve el modelo sale de la base, así que la UI muestra un intercambio que el turno siguiente ya no ve. Se registra con `name=`/`code=`.
- **El hilo que viaja al modelo sale de `conversations`, no del cliente** (PRD-005 goal 2). El navegador manda un solo mensaje: el suyo. Se valida al leer —`role` exactamente `user`/`assistant` y `content` string— y se recorta el prefijo hasta el primer `user`, porque `trimWindow` **no** da esa garantía por debajo de 30 mensajes: solo la aplica en la rama de recorte.
- **Al modelo solo viaja la ventana reciente** (últimos 30 mensajes), y siempre empezando por un turno `user` — la API lo exige. El recorte no borra nada: `conversations.messages` conserva el hilo completo y la UI lo pinta entero.
- `max_tokens: 1024`, `thinking: { type: "adaptive" }`.
- **La `ANTHROPIC_API_KEY` vive SOLO en el servicio `api`.** El proceso Next se niega a arrancar si la encuentra (`assertNoAnthropicKey` en `apps/web/src/lib/tutor-turn.ts`, armado en el ámbito del módulo e importado por el handler del proxy). Muerde en `next build`, no solo en arranque, así que la clave presente bloquea el despliegue.
- **El turno abandonado no se persiste y deja de facturarse.** `res.on("close")` —no `req`, que desde Node 16 dispara al completarse la petición, o sea a los ~2 ms porque `body-parser` consume el cuerpo al entrar— aborta el stream de Anthropic. La bandera de "ya cerré" distingue el abandono del cierre normal, porque `close` dispara igual en los dos.
- **El handler de `apps/api` NO llama a `flushHeaders()`.** Las cabeceras salen con el primer `text_delta`, y es deliberado: `flushHeaders()` pondría `headersSent` en `true` antes de `ensureTrial`, y entonces un 403 saldría como conexión cortada sobre un 200 que el cliente ya leyó — el muro de pago mostrando una respuesta vacía.
- **El proxy no bufferiza y no copia cabeceras.** Devuelve `upstream.body` por identidad; el conjunto saliente es exactamente `Authorization` y `Content-Type` (la cookie **no** se reenvía, § dominio `acceso`), y el entrante se construye. `redirect: "manual"`: cualquier 3xx es fallo de upstream → 503.

### Open Debt

- No hay forma de empezar una conversación nueva ni de listar el historial: la UI siempre continúa la última.
- La ventana se mide en número de mensajes, no en tokens (marcado `ponytail:` en `window.ts`): 30 mensajes muy largos siguen siendo caros. El upgrade es un presupuesto de caracteres en el mismo módulo.
- **`TUTOR_TIMEOUT_MS = 10 000` está sin calibrar, y mide más de lo que su nombre sugiere.** El proxy lo aplica solo hasta la primera cabecera, pero como `apps/api` no hace `flushHeaders()` las cabeceras salen con el primer `text_delta` — y `thinking: adaptive` no escribe deltas. O sea que ese reloj cubre la fase de razonamiento entera: en la práctica es "hasta el primer token". Un turno que piense más de 10 s se convierte en un 503 que dice "reintenta" cuando el tutor estaba trabajando. Tres muestras de producción dan 2.966, 3.204 y 3.447 ms, así que hoy sobra — pero son tres muestras, no un p99. **Pendiente**: tomar el p99 de `first_token_ms` de una clase completa y fijar la variable en un múltiplo, anotado con la fecha de la medida. Quien lo baje creyendo que acorta el presupuesto del transporte estaría acortando el de Anthropic.
- `format-message.ts` implementa un subconjunto de markdown a propósito (código, negrita, énfasis) — sin listas, enlaces ni encabezados.

---

---

## Cross-cutting concerns

---

### Background jobs

**Uno**: la reconciliación con Paddle (`apps/api/src/worker.ts`, PRD-004). Es el segundo punto de entrada de `apps/api` — `createApplicationContext`, sin servidor HTTP —, arranca por cron de Railway, hace una pasada y termina. No es un demonio y no lleva `setInterval`: la exclusión mutua entre pasadas la da que el proceso ya no existe.

El resto sigue en el ciclo de petición, y el aviso de clase se sigue lanzando a mano desde `scripts/`.

**Lo que hace y lo que deliberadamente no hace**: compara `subscriptions` contra la API de Paddle y **solo escribe hacia `active`**. Una divergencia en dirección `canceled` se cuenta como `pendiente_revocacion` y se registra para que la resuelva una persona. La asimetría es la propiedad central del diseño, no una fase pendiente: crear una fila `canceled` es una denegación de acceso irreversible —`ensureTrial` hace corto circuito ante cualquier fila existente—, y revocar por correo volvería permanente y auto-reparable el ataque del checkout con correo ajeno que este documento ya declara como riesgo heredado. Desde la re-revisión post-implementación **el invariante está tipado**: `updateStatusIfUnchanged` y la rama de alta de `upsertStatus` toman `ReconcilerChanges`, que es `status: "active"` y nada más, así que escribir `canceled` desde el barrido no compila.

**Su credencial no está en el servicio HTTP, y eso lo enforza el código**: `resolveApiConfig()` lanza `ConfigError` si `PADDLE_API_KEY` está **presente** en el entorno del servicio `api`. No es una instrucción de despliegue porque los dos caminos por los que se incumple —una sobrescritura de arranque ignorada por Railway, y un `.env` único en auto-hospedaje— fallan aparentando éxito.

**El worker no comparte el grafo de módulos del servicio HTTP**: no importa `ConfigModule` (que exigiría `AUTH_SECRET`, `AUTH_COOKIE_NAME` y `PADDLE_WEBHOOK_SECRET`, metiendo dos secretos vivos en un tercer servicio) ni `AccessModule` (que arrastraría `AccessController` y su guard). `WorkerConfigModule` es `@Global()` **y exporta `API_CONFIG`**: las dos mitades hacen falta, porque en Nest un módulo global aporta lo que exporta, y `DrizzleModule` y `AnalyticsService` no importan nada.

**Su registro de errores es de proceso, no de `catch`** — `createApplicationContext` devuelve un `INestApplicationContext`, que no admite `useGlobalFilters`, así que el `AllExceptionsFilter` que protege al servicio HTTP no existe aquí. Lo sustituyen `unhandledRejection`, `uncaughtException`, un `.catch()` de nivel superior y un logger de construcción que **descarta sus argumentos**. Esto último no es sinónimo de `abortOnError: false`: `ExceptionsZone` de Nest registra el error crudo antes de ceder el control pase lo que pase, así que un logger que solo evite formatear un `Error` no basta.

**Primera pasada real contra producción** (2026-07-29, a mano desde la máquina del operador, `RECONCILE_APPLY` ausente): `revisadas=1 reparadas=0 divergencias=0 pendiente_revocacion=0 sin_correo=0 desincronizado=0 ambiguo=0 desconocido=0`. Tres cosas que ese número dice y que conviene no perder:

1. **La deriva que PRD-004 existe para reparar no estaba ocurriendo.** El PRD se escribió sobre un fallo real y documentado, pero su § 1 admitía que el sistema no podía responder si estaba pasando *en ese momento*. La respuesta, medida, es que no. El barrido queda como red de seguridad, no como reparación de un problema activo.
2. **Hay una suscripción en toda la cuenta de Paddle.** El barrido completo sin filtro de fecha, que § 5.2 justifica como "una o dos páginas de 100", está sobredimensionado por tres órdenes de magnitud. El techo anotado en `ponytail:` (10⁴ filas) queda muy lejos.
3. **El proceso corre desde la máquina del operador**, igual que `scripts/load-curriculum.ts`, y eso es un modo de uso legítimo y no un apaño: una pasada en seco a mano es la forma barata de contestar "¿cuánta deriva hay?" sin montar el cron.

**El servicio de cron (`api-reconcile`) está en producción desde el 2026-07-29**, con `0 * * * *` (cada hora, UTC) y **sin dominio expuesto**. Variables: `DATABASE_URL` y `POSTHOG_API_KEY` por referencia a los servicios `Postgres` y `api`, `PADDLE_ENV=production`, `PADDLE_API_KEY` (clave propia acotada a lectura de suscripciones — no es la del resto del sistema), y `RAILWAY_DOCKERFILE_PATH=apps/api/Dockerfile.worker`. **`RECONCILE_APPLY` no está puesta**, así que el barrido corre en modo sin escritura: es el paso 4 de PRD-004 § 10, la semana de observación previa a encender la escritura.

Primera ejecución programada, verificada en los logs del servicio:

```
[reconcile] reconcile: config resuelta env=production
[ReconcileService] revisadas=1 reparadas=0 divergencias=0 pendiente_revocacion=0
                   sin_correo=0 desincronizado=0 ambiguo=0 desconocido=0 aplicar=false
```

**Cómo verificar que el servicio ejecuta el worker y no el servidor HTTP**: la línea `config resuelta env=…` solo la emite `worker.ts`. Si en los logs apareciera `apps/api escuchando en el puerto`, el servicio estaría corriendo `main.js` —una API pública con la credencial de Paddle— y eso es el fallo que aparenta éxito descrito arriba. Es la primera cosa que hay que mirar si alguien recrea o reconfigura este servicio.

**Deriva declarada de PRD-004** (re-revisión post-implementación, ronda 1): el PRD dice dos veces que el camino del deadline pierde el lote pendiente de PostHog. **No lo pierde.** `worker.ts` enruta todo fallo por un único `catch` que cierra el contexto con una gracia de 5 s (`CLOSE_GRACE_MS`), lo que dispara `onModuleDestroy` y con él el `shutdown()` de `AnalyticsService`. La cláusula normativa del PRD —`process.exit(1)` incondicional tras intentar cerrar— sí se cumple; lo que quedó desactualizado es la consecuencia. Se dejó así a propósito: saltarse el cierre para hacer cierto el texto sería estrictamente peor.

---

## Dominios que viven en otro paquete

- **`contenido`** → `packages/shared/docs/SYSTEM_ARTIFACT.md`. Este servicio lee el currículo con `src/tutor/curriculum.repository.ts`, **sin caché** a diferencia del lado web: aquí no hay `next/cache` y replicar el par caché-más-`lastKnown` quedó fuera de alcance en PRD-006. La consulta es un `SELECT` de unas decenas de filas, una vez por turno con lección declarada, sobre un pool ya abierto.
- La mitad de `acceso` y `tutor` que corre en el navegador —el puente, el proxy, la UI del chat, el checkout— está en `apps/web/docs/SYSTEM_ARTIFACT.md`.

---

## Comprobaciones

**Vitest, no el estilo de asserts de la raíz.** `*.spec.ts` junto al código y `test/*.e2e-spec.ts` con `Test.createTestingModule`. **`unplugin-swc` no es opcional**: el transformador por defecto de Vitest no emite metadatos de decorador y sin ellos la DI de NestJS no resuelve ningún provider.

Los e2e exigen `API_TEST_DATABASE_URL`, abortan si falta y se niegan a correr si coincide con `DATABASE_URL` — comparación sobre la URL **parseada**, no sobre la cadena: la misma base con `?sslmode=require` añadido no es igual como cadena y sí es la misma base. Por eso quedan fuera de CI y las corre el operador.

Cada fichero declara en su cabecera qué filas del §9 de su PRD cubre, y cada `it()` lleva el número de fila en el nombre.

**Trampa: `Test.createTestingModule().compile()` instala un `TestingLogger` que anula `log` y `warn` y reenvía solo `error`.** Un test que capture la salida y afirme sobre un `log` está afirmando **sobre una cadena vacía**, y pasa por vacuidad. Apareció con la fila 34 de PRD-004 §9, que pasaba sin ejercitar nada. La contención es doble y las dos mitades hacen falta: restaurar un `ConsoleLogger` real justo después de `compile()`, y acompañar la aserción negativa con una positiva que falle si la captura está vacía.

**`@posthog/core` y el SDK de Paddle escriben en `console.*` por su cuenta**, fuera de la allowlist por campo. Revisado en las versiones pineadas y **no hay fuga**: el error de `posthog-node` lleva solo `response` y `reqByteLength`, nunca el lote —que sí contiene el correo—, y el logger de Paddle no registra cuerpos en ningún nivel. Es una propiedad de esas versiones y no un contrato: **quien las suba tiene que volver a comprobarlo**, y están pineadas exactas en el `catalog:` para que esa subida sea deliberada.

---

## Entorno y despliegue

**Dos servicios en Railway desde el mismo árbol, cada uno con su Dockerfile.** `api` corre el servicio HTTP (`Dockerfile`) y `api-reconcile` la pasada del reconciliador (`Dockerfile.worker`). Se seleccionan con `RAILWAY_DOCKERFILE_PATH`.

**La duplicación entre los dos Dockerfiles es deliberada.** Son idénticos salvo el `CMD`, y se paga un segundo build completo a propósito: el modo de fallo de la alternativa es que una sobrescritura de comando que Railway no aplicara dejaría el servicio de cron **sirviendo una API pública sana con `PADDLE_API_KEY` en el entorno**, sin que nada se ponga rojo. Con Dockerfile propio, `main.js` no es alcanzable desde el arranque de ese servicio.

**El build corre desde la raíz del repositorio, no desde aquí**: las dependencias del workspace se resuelven arriba y este paquete importa de `packages/shared`. El entrypoint emitido es `dist/apps/api/src/main.js` y **no** `dist/main.js`, porque el `tsconfig` no declara `rootDir` a propósito.

**La programación del cron no es opcional**: el proceso hace una pasada y sale, así que un servicio sin cron lo reiniciaría en bucle.

**Dos lecciones de despliegue, aprendidas rompiendo producción:**

- **No uses referencias cruzadas de Railway (`${{servicio.VARIABLE}}`) para un secreto compartido.** Parecen limpias y crean una dependencia invisible: al borrar la variable del otro servicio, la referencia queda resolviendo a cadena vacía y este servicio entra en bucle de arranque. Duplicar el valor es más tosco y no se rompe por un borrado ajeno.
- **El fallo cerrado de `ANTHROPIC_API_KEY` arrastra acceso y cobro con él.** Que el tutor no arranque sin su clave es correcto; la consecuencia que no estaba escrita es que ese mismo arranque sirve `/v1/access` y el webhook de Paddle, así que una clave del tutor ausente deja el muro de pago degradando abierto y los pagos sin registrar. Paddle reintenta durante días, así que se recupera — pero el radio de una variable del tutor es mayor que el tutor.

**Orden al desplegar cambios de variables**: las que un servicio exige para arrancar se ponen **antes** de mergear el código que las exige; las que un guarda prohíbe se quitan **antes** de mergear el código que las prohíbe. Las dos direcciones fallan cerrado.

---

## Change log

| Date | PRD | Summary |
|---|---|---|
| 2026-07-31 | — | **El documento vivo se parte en tres**, uno por sibling, al pasar `SIBLINGS.md` de una fila a tres. El anterior vivía en `platform/docs/SYSTEM_ARTIFACT.md` y sigue disponible en el historial de git: los `system_artifact_diff` de PRD-002 a PRD-006 lo citan por ruta **y commit**, así que resuelven ahí y no en disco. Los dominios que cruzaban paquetes quedaron partidos, con la mitad de cada uno referenciando a la otra por nombre. |
