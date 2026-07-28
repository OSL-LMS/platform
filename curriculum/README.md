# El currículo, como dato

**Si has copiado este archivo como plantilla para tu escuela: regenera todos los
`id` antes de cargarlo.** Los UUID son la identidad global del nodo, no una
etiqueta por currículo: cargar una copia con los `id` originales aborta con un
error de propiedad (`el id … pertenece al currículo contextia`). Regenerarlos es
una línea:

```sh
node -e 'for (let i = 0; i < 21; i++) console.log(crypto.randomUUID())'
```

## Qué hay aquí

`<slug>.json` es la **fuente de verdad autoral** del currículo. La tabla
`curriculum_nodes` de Postgres es una proyección suya: se escribe ejecutando
`pnpm curriculum:load --write` y **nada más la escribe** en el entorno
desplegado. Todo cambio de contenido pasa, por construcción, por un pull
request.

El formato es un árbol de profundidad libre. Cada nodo declara:

| Campo | Qué es |
|---|---|
| `id` | UUID. **Es la identidad del nodo** y sobrevive a recargas, reordenamientos, cambios de padre y renombrados de `slug`. Nunca lo cambies para "ordenar" el archivo. |
| `slug` | Etiqueta pública y **mutable** (`"E1"`, `"L3"`, `"primera-semana"`). Única dentro del currículo. Renombrarla es un `UPDATE` normal. |
| `kind` | `stage`, `module` o `lesson`. La aplicación los conoce por nombre. |
| `title` | Nombre visible. **Llega al bloque de system del tutor.** |
| `position` | Implícito: el orden en que aparecen los hermanos en el array. |
| `payload` | Contenido específico del tipo de nodo (tabla abajo). |
| `children` | Hijos. Un array vacío es válido y significa "módulo declarado y sin lecciones todavía". |

## Vocabulario del `payload`

El esquema de la base no conoce estas llaves; la aplicación sí. Cambiarlas o
quitarlas rompe la home o el tutor, y `pnpm curriculum:check` te lo dirá.

| `kind` | Llave | Tipo | ¿Obligatoria? | Quién la lee |
|---|---|---|---|---|
| `stage` | `built` | string | sí | la home |
| `stage` | `aiRole` | string | sí | la home |
| `stage` | `hours` | number | sí | la home |
| `stage` | `milestone` | string | sí | la home |
| `stage` | `status` | string | sí | la home (`en-emision` \| `disenada` \| `en-diseno`) |
| `stage` | `statusLabel` | string | sí | la home |
| `stage` | `hasDetail` | boolean | sí | la home: `false` = "etapa sin detalle todavía", y no se pinta la lista de módulos. Distinto de tener cero hijos. |
| `stage` | `scope` | string | no | consumidores externos del temario (p. ej. el generador de exámenes) |
| `module` | `audience` | string | no | **bloque de system del tutor** |
| `lesson` | `outcome` | string | **sí** | **bloque de system del tutor** |
| `lesson` | `stuck` | string | **sí** | **bloque de system del tutor** |

## REGLA DE CONTENIDO de `stuck`

`stuck` describe el **atasco** y los límites de lo que se enseña, **nunca la
solución del reto sembrado**. Lo que se escriba aquí el tutor puede decirlo — es
su contexto, no su conocimiento secreto.

## Lo que llega al bloque de system

`stuck`, `outcome`, `audience`, `title` y `scope` viajan al modelo dentro del
segundo bloque de system de cada petición al tutor. Eso tiene tres
consecuencias, y las tres las comprueba `pnpm curriculum:check`:

1. **Cota de 4 000 caracteres por valor** — ese bloque no lleva `cache_control`,
   así que un valor gigante se factura como entrada no cacheada en cada petición
   de cada usuario, indefinidamente.
2. **Cota de 24 000 caracteres sobre el bloque compuesto**, por lección.
3. **Sin patrones imperativos hacia el modelo** (`ignora`, `olvida`,
   `instrucciones anteriores`, `system`). Un `stuck` hostil no compite con la
   regla inviolable del prompt: entra por encima de ella.

Por eso un PR que toca estas llaves se revisa con el mismo listón que el prompt
del tutor. Ver `CONTRIBUTING.md`.

## Añadir una lección

1. Genera un `id`: `node -e 'console.log(crypto.randomUUID())'`.
2. Añade el nodo bajo su módulo **y** su fecha en `src/lib/schedule.ts`, en el
   **mismo PR**.
3. Tras el merge: `pnpm curriculum:load` (revisa el diff), luego
   `pnpm curriculum:load --write`. **Primero la carga, después el despliegue** —
   al revés, la home queda con una sesión apuntando a un nodo inexistente.

Corregir una errata en un nodo que ya existe (`title`, `stuck`, `outcome`) no
necesita despliegue: se propaga en ≤ 10 min tras la carga.

## Comprobar antes de abrir el PR

```sh
node scripts/check-curriculum.ts           # esquema + contrato de contenido
node scripts/check-curriculum-identity.ts  # ningún id cambió respecto a HEAD
```
