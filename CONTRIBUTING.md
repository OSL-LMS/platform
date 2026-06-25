# Cómo contribuir a OSL

Bienvenida y bienvenido. Este no es un repositorio cualquiera: es la plataforma de una escuela que se construye **en abierto y entre todos**. Si estás aprendiendo aquí, **contribuir es parte de cómo aprendes** — cada contribución que defiendes es evidencia real para tu portafolio.

Esta guía está escrita para principiantes. Si es tu primer pull request en tu vida, estás exactamente en el lugar correcto. No hace falta que lo sepas todo; hace falta que entiendas lo que entregas.

## La regla de oro

> **Nunca entregues código que no entiendes.**

Es la línea roja de toda la escuela, y aquí también. Puedes usar IA para ayudarte (de hecho, aprender a dirigirla es parte del oficio), pero **respondes personalmente por cada línea que abres en un PR**. En esta escuela las contribuciones se defienden en vivo: una PR generada por IA que no sabes explicar no pasa, y no por castigo — porque no demuestra nada.

## La escalera de contribución

Hay sitio para ti aunque acabes de empezar. Contribuye al nivel donde estás; cada peldaño entrena algo distinto.

| Si estás en… | Contribuye con | Lo que entrenas |
|---|---|---|
| **E1 — Fundamentos** | Issues bien reportados, mejoras de documentación, traducciones, fe de erratas | Leer un proyecto real y comunicarte por escrito |
| **E2 — Construcción** | Features pequeñas de UI, fixes acotados | Tocar código ajeno sin romper lo demás |
| **E3 — Auditoría** | **Revisar las PRs de otros estudiantes** (code review) | Juzgar código ajeno con criterio — tu currículo *es* esta revisión |
| **E4 — Síntesis** | Una feature completa, de un issue ambiguo a producción, actuando como PM/dev | Las 6 competencias del perfil a la vez |

¿No sabes por dónde empezar? Busca issues marcados como **`good first issue`**. Si no hay ninguno claro, abrir un buen issue (ver abajo) ya es una contribución de E1.

## Un buen issue

Reportar bien es una habilidad, no un trámite. Un buen issue tiene:

- **Qué esperabas** que pasara y **qué pasó** en su lugar.
- **Pasos para reproducirlo**, en orden.
- Tu entorno si es relevante (navegador, sistema).
- Una captura o el mensaje de error, si lo hay.

"No funciona" no es un issue; "al pulsar *Enviar* en `/chat` con el campo vacío la app se queda cargando y no muestra error" sí lo es.

## Tu primer pull request, paso a paso

1. **Haz fork** del repo a tu cuenta y clónalo.
2. Móntalo en local siguiendo el [README](./README.md) (usa **pnpm**, no npm).
3. Crea una rama con nombre descriptivo en inglés: `git checkout -b fix/empty-chat-input`.
4. Haz tu cambio. Mantenlo **pequeño y enfocado**: un PR resuelve una cosa.
5. Haz **commits atómicos** con mensajes claros (un commit = un cambio que se entiende solo).
6. Abre el Pull Request siguiendo las reglas de abajo.

Si te atascas con git, pregunta en un issue o en el canal de la comunidad. Atascarse y pedir ayuda es parte del aprendizaje, no una falta.

## Qué pedimos en cada Pull Request

El flujo de PR de este repo **es el flujo de trabajo de la escuela**. Por eso pedimos un poco más que un proyecto cualquiera — porque la PR misma es la práctica:

1. **Describe tus decisiones.** No solo *qué* cambiaste, sino *por qué*: qué alternativas viste y por qué elegiste esta.
2. **Registra el uso de IA.** Si delegaste parte del trabajo a un asistente, dilo: qué le pediste y, sobre todo, **cómo validaste lo que te devolvió**. Esto no resta mérito; demuestra criterio.
3. **Mantén el PR pequeño.** Es más fácil de revisar y de defender.
4. Si tu cambio toca **el prompt del tutor** (`src/lib/tutor-prompt.ts`), no se acepta sin pasar el banco de evaluaciones en verde. Toda fuga nueva entra como caso de prueba *antes* del arreglo. Cuéntalo en el PR.

### Cómo se revisa

- Tu PR la revisa primero **otro estudiante** (típicamente de E3) como primer filtro.
- La revisión final y el botón de producción son del **fundador** (o de quien delegue). Nada llega a producción sin esa aprobación.

No te desanimes si te piden cambios: recibir y dar review *es* el contenido del curso, no un obstáculo hacia él.

## Convenciones de código

- **El código habla inglés.** Identificadores —variables, funciones, tipos, tablas y columnas, nombres de archivos, ramas— van en inglés. Es el estándar de la industria.
- **Lo que lee un humano va en español.** Los **comentarios** y docstrings (son enseñanza) y el **texto que ve el usuario final** (UI, mensajes) van en español.
- En resumen: *identificadores en inglés, lo que un humano lee en español.*
- Sigue el estilo del código que ya existe alrededor de tu cambio.

## Convivencia

Tratamos a todo el mundo con respeto: aquí hay gente dando sus primeros pasos y eso es justo lo que celebramos. Preguntas "obvias", bienvenidas. Comentarios despectivos, no. Una review critica el código, nunca a la persona.

## Licencia

Al contribuir aceptas que tu aportación se publique bajo la licencia del proyecto, [AGPL-3.0](./LICENSE).
