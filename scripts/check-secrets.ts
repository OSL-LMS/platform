// Comprobación del guarda de secretos de la raíz (PRD-005 §8.3). Se ejecuta con:
//   node scripts/check-secrets.ts
//
// Cubre la fila 39 de PRD-005 §9: el proceso Next se niega a arrancar si
// encuentra ANTHROPIC_API_KEY en su entorno, y el mensaje nombra la variable
// sin imprimir su valor.
//
// QUÉ CUBRE HOY Y QUÉ NO, dicho sin adornos. La fila 39 está fechada "tras el
// paso E de §10", y hasta ese paso la raíz sigue ejecutando el tutor en proceso
// (`new Anthropic()` en route.ts), así que la clave es legítima aquí y el guarda
// NO PUEDE estar armado — ver el bloque final de src/lib/tutor-turn.ts, que deja
// escrita la línea exacta que falta. Tampoco sirve condicionarlo a
// TUTOR_VIA_API: §8.3 dice que durante C-D la clave vive en los dos servicios
// precisamente para que el rollback del paso D (quitar la variable, sin
// desplegar) devuelva un camino local que funciona.
//
// Lo que este script sí demuestra hoy, y son las tres mitades que hacen falta
// para que armarlo sea un cambio de una línea sin sorpresas:
//   (1) el guarda falla cerrado ante la PRESENCIA y no filtra el valor;
//   (2) la línea de armado, ejecutada tal cual en un proceso Node real, TUMBA
//       ese proceso — no "lanza una función", mata el arranque;
//   (3) el módulo donde vive lo importa el handler de /api/chat, así que esa
//       línea se carga en el arranque real de Next y en `next build`. Un guarda
//       en un módulo que nadie importa probaría que una función lanza.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const guardModule = path.join(repoRoot, "src", "lib", "tutor-turn.ts");

const { assertNoAnthropicKey } = await import("../src/lib/tutor-turn.ts");

const SECRET = "sk-ant-api03-un-valor-que-no-debe-aparecer-en-ningun-sitio";

// ---------------------------------------------------------------------------
// (1) Falla cerrado ante la PRESENCIA, y el mensaje no lleva el valor.
// ---------------------------------------------------------------------------
{
  let thrown: unknown;
  try {
    assertNoAnthropicKey(SECRET);
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof Error, "una clave presente debía tumbar el arranque");
  assert.match(
    thrown.message,
    /ANTHROPIC_API_KEY/,
    "el mensaje tiene que NOMBRAR la variable: es lo único accionable que el operador tiene"
  );
  assert.ok(
    !thrown.message.includes(SECRET),
    "el mensaje NUNCA imprime el valor de la credencial"
  );

  // Una cadena VACÍA también cuenta como presente. Lo que el operador comprueba
  // es "está o no está"; un segundo criterio invisible ("está pero vacía, y
  // entonces vale") es justo la clase de matiz que este guarda existe para no
  // tener. Mismo criterio que el de PADDLE_API_KEY en apps/api/src/config.ts.
  assert.throws(() => assertNoAnthropicKey(""), /ANTHROPIC_API_KEY/);

  // Ausente: arranca. Sin esto, la aserción de arriba pasaría con un guarda que
  // lanza siempre.
  assert.doesNotThrow(() => assertNoAnthropicKey(undefined));
}

// ---------------------------------------------------------------------------
// (2) La línea de armado mata un proceso de verdad.
//
// Es la diferencia entre "una función lanza" y "el arranque falla": se importa
// el módulo en un Node aparte, se ejecuta la línea tal como quedará escrita en
// el ámbito del módulo, y se afirma sobre el CÓDIGO DE SALIDA.
// ---------------------------------------------------------------------------
{
  const armed =
    `import { assertNoAnthropicKey } from ${JSON.stringify(pathToFileURL(guardModule).href)};\n` +
    "assertNoAnthropicKey(process.env.ANTHROPIC_API_KEY);\n";

  let exitCode = 0;
  let stderr = "";
  try {
    execFileSync(process.execPath, ["--input-type=module", "-e", armed], {
      env: { ...process.env, ANTHROPIC_API_KEY: SECRET },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    exitCode = e.status ?? -1;
    stderr = e.stderr ?? "";
  }

  assert.notEqual(
    exitCode,
    0,
    "con ANTHROPIC_API_KEY presente el proceso tenía que morir, no arrancar"
  );
  assert.match(stderr, /ANTHROPIC_API_KEY/, "el fallo de arranque nombra la variable");
  assert.ok(!stderr.includes(SECRET), "y no imprime su valor ni en el volcado del error");

  // Contraste: sin la variable, el mismo proceso levanta y sale con 0. Sin este
  // caso, la aserción de arriba pasaría con un módulo que no compila.
  const { ANTHROPIC_API_KEY: _omitted, ...cleanEnv } = process.env;
  execFileSync(process.execPath, ["--input-type=module", "-e", armed], {
    env: cleanEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// ---------------------------------------------------------------------------
// (3) El guarda vive en un módulo que el proxy importa.
//
// §8.3: el módulo se carga en el arranque real de Next y en `next build` porque
// lo importa el handler de /api/chat, igual que resolveClientConfig() se valida
// al cargar api-client.ts. Si un refactor futuro deja de importarlo, armar la
// línea del paso E no protegería nada y esta aserción lo dice.
// ---------------------------------------------------------------------------
{
  const handler = readFileSync(
    path.join(repoRoot, "src", "app", "api", "chat", "route.ts"),
    "utf8"
  );
  assert.match(
    handler,
    /from "@\/lib\/tutor-turn"/,
    "src/app/api/chat/route.ts tiene que importar src/lib/tutor-turn.ts: es lo " +
      "que hace que el guarda del paso E se cargue en el arranque de Next y no " +
      "sea una función que nadie ejecuta"
  );

  // Y el módulo no puede arrastrar servidor al bundle del navegador: lo importa
  // también un Client Component (chat-client.tsx). Sin imports no hay riesgo.
  const guard = readFileSync(guardModule, "utf8");
  const imports = guard.match(/^\s*import\s.+$/gm) ?? [];
  assert.deepEqual(
    imports,
    [],
    "src/lib/tutor-turn.ts no debe importar nada: lo comparten un Route Handler " +
      "y un Client Component, y cualquier import de servidor viajaría al bundle"
  );
}

// ---------------------------------------------------------------------------
// (4) TRIPWIRE DEL PASO E, que es la mitad que faltaba.
//
// Las tres de arriba demuestran que el guarda FUNCIONA. Ninguna demostraba que
// esté ARMADO, y los dos estados —paso E con la línea puesta y paso E sin
// ponerla— dejaban este script en verde: la única defensa era que alguien se
// acordara.
//
// Se autoactiva por el mismo hecho que hace legal armarlo. Mientras exista el
// camino local (`new Anthropic(` en el handler), la clave es legítima en la raíz
// durante los pasos B-D y el guarda TIENE que seguir desarmado. En cuanto el
// paso E retira ese camino, la clave se queda sin lector y el guarda pasa a ser
// obligatorio — y esta aserción se pone roja si no está.
{
  const handler = readFileSync(
    path.join(repoRoot, "src", "app", "api", "chat", "route.ts"),
    "utf8"
  );

  if (!/new Anthropic\(/.test(handler)) {
    const guard = readFileSync(guardModule, "utf8");
    assert.match(
      guard,
      /^\s*assertNoAnthropicKey\(process\.env\.ANTHROPIC_API_KEY\);\s*$/m,
      "El paso E de PRD-005 §10 retiró la implementación local de " +
        "src/app/api/chat/route.ts, así que ANTHROPIC_API_KEY ya no tiene lector " +
        "en la raíz y el guarda tiene que estar ARMADO: descomenta " +
        "`assertNoAnthropicKey(process.env.ANTHROPIC_API_KEY);` en " +
        "src/lib/tutor-turn.ts (§8.3, fila 39)."
    );
  }
}

console.log(
  "check-secrets: OK — fila 39 de PRD-005 §9 cubierta " +
    "(guarda + armado + camino de carga + tripwire del paso E)."
);
