// Fronteras entre paquetes, CODEOWNERS en las dos direcciones, el tipo
// `Access` sin duplicar, ningún Client Component importando `@shared/*` por
// valor, y los agregados de `package.json` resolviendo. Se ejecuta con:
//   node scripts/check-boundaries.ts
// Node 22+ ejecuta TypeScript directamente. Sin framework: si algo se rompe,
// el assert lo dice.
//
// Cubre las filas 1, 2, 3, 4 y 15 de PRD-006 §9. Solo tiene sentido DESPUÉS
// de la mudanza de PRD-006: si `apps/web`, `apps/api` o `packages/shared` no
// existen todavía, falla explícitamente en vez de pasar verde examinando cero
// archivos — el mismo modo de fallo que PRD-006 §8.1 dedica una página a
// evitar en otros escaneos por prefijo de ruta.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

// ---------------------------------------------------------------------------
// Raíces del layout objetivo (PRD-006 §7.1). Configurables aquí: si la
// mudanza cambia un nombre de directorio, se corrige en un solo sitio.
// ---------------------------------------------------------------------------
const API_SRC = "apps/api/src";
const WEB_SRC = "apps/web/src";
const SHARED_SRC = "packages/shared/src";
const APPS_API_DIR = "apps/api";
const APPS_WEB_DIR = "apps/web";
const APPS_DIR = "apps";

const ROOT_PACKAGE_JSON = "package.json";
const WEB_PACKAGE_JSON = "apps/web/package.json";
const CODEOWNERS_PATH = ".github/CODEOWNERS";

// Lista declarada de rutas protegidas (PRD-006 §8.1). Fila 2(b) exige que
// cada una esté cubierta por ≥1 regla de CODEOWNERS.
const PROTECTED_PATHS = [
  `${SHARED_SRC}/tutor-prompt.ts`,
  `${SHARED_SRC}/curriculum-context.ts`,
  `${SHARED_SRC}/curriculum-file.ts`,
  "curriculum/**",
  ".github/workflows/**",
  "pnpm-workspace.yaml",
];

// Scripts de `curriculum:check` que exigen base de datos y por tanto no
// pueden vivir en la cadena que corre CI (§7.4).
const DB_REQUIRING_SCRIPTS = ["check-curriculum-load.ts"];

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", ".turbo", "coverage"]);

// ---------------------------------------------------------------------------
// Utilidades de árbol de archivos
// ---------------------------------------------------------------------------

/** Lista, recursiva, todas las rutas (relativas a ROOT, con "/") bajo `dir`. */
function walk(dir: string): string[] {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const rel = dir === "." ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(rel));
    else out.push(rel);
  }
  return out;
}

function sourceFiles(root: string): string[] {
  return walk(root).filter((p) => /\.(ts|tsx)$/.test(p));
}

// A diferencia del `stripComments` de check-curriculum.ts, este preserva los
// saltos de línea dentro de comentarios de bloque: los números de línea
// tienen que seguir siendo correctos para poder señalar archivo:línea (fila 1
// exige "falla nombrando archivo y línea").
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// ---------------------------------------------------------------------------
// Fila 1 — fronteras entre paquetes
// ---------------------------------------------------------------------------

interface ImportRef {
  specifier: string;
  line: number;
}

// "from"/"import"/"require" seguido de un especificador entre comillas. Cubre
// `import ... from "x"`, `export ... from "x"`, `import "x"` (efecto),
// `import("x")` (dinámico) y `require("x")`.
const IMPORT_RE = /(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g;

function extractImports(text: string): ImportRef[] {
  const refs: ImportRef[] = [];
  text.split("\n").forEach((lineText, i) => {
    for (const match of lineText.matchAll(IMPORT_RE)) {
      refs.push({ specifier: match[1], line: i + 1 });
    }
  });
  return refs;
}

/**
 * Resuelve un especificador relativo a un archivo real bajo ROOT, o `null` si
 * no es relativo o no resuelve a nada (un import roto ya lo caza `tsc`/`next
 * build` con TS2307; no es asunto de esta comprobación).
 */
function resolveRelativeImport(fromRelFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const fromDir = dirname(fromRelFile);
  const joined = join(fromDir, specifier).split("\\").join("/");
  const hasExt = /\.(ts|tsx|js|mjs|cjs)$/.test(joined);
  // El repo importa con extensión `.ts` (§5.3); si alguien importa con `.js`
  // (lo que emitiría `rewriteRelativeImportExtensions`), el origen sigue
  // siendo el `.ts`.
  const candidates = hasExt
    ? [joined.replace(/\.(js|mjs|cjs)$/, ".ts"), joined]
    : [`${joined}.ts`, `${joined}.tsx`, `${joined}/index.ts`, `${joined}/index.tsx`];
  for (const candidate of candidates) {
    if (existsSync(join(ROOT, candidate))) return candidate;
  }
  return null;
}

function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function checkBoundaries(): string[] {
  const violations: string[] = [];
  const groups: Array<[string, string, string]> = [
    [API_SRC, APPS_WEB_DIR, "apps/web"],
    [WEB_SRC, APPS_API_DIR, "apps/api"],
    [SHARED_SRC, APPS_DIR, "apps/"],
  ];
  for (const [scanRoot, forbiddenRoot, label] of groups) {
    for (const file of sourceFiles(scanRoot)) {
      const text = stripComments(readFileSync(join(ROOT, file), "utf8"));
      for (const ref of extractImports(text)) {
        const resolved = resolveRelativeImport(file, ref.specifier);
        if (resolved && isUnder(resolved, forbiddenRoot)) {
          violations.push(
            `${file}:${ref.line} — importa "${ref.specifier}" (resuelve a ${resolved}, dentro de ${label})`
          );
        }
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Fila 2 — CODEOWNERS, las dos direcciones
// ---------------------------------------------------------------------------

interface CodeownersRule {
  pattern: string;
  line: number;
}

function parseCodeowners(text: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  text.split("\n").forEach((raw, i) => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const [pattern] = trimmed.split(/\s+/);
    rules.push({ pattern, line: i + 1 });
  });
  return rules;
}

function segmentsOf(p: string): string[] {
  return p.split("/").filter(Boolean);
}

// Un solo segmento de ruta: "*" no cruza "/" porque aquí nunca hay "/" que
// cruzar — cada segmento se compara aislado del resto de la ruta. "?" es un
// carácter cualquiera.
function segmentToRegExp(segment: string): RegExp {
  const escaped = segment
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

/**
 * Semántica de globs de CODEOWNERS (no de un globber genérico, PRD-006 §8.1):
 * "*" no cruza "/", "**" sí y consume cero o más segmentos, y un patrón sin
 * "/" (como `pnpm-workspace.yaml`) casa por nombre final a cualquier
 * profundidad en vez de anclarse a la raíz.
 */
function matchesCodeownersPattern(pattern: string, filePath: string): boolean {
  const patternSegs = segmentsOf(pattern);
  const fileSegs = segmentsOf(filePath);
  const anchored = patternSegs.length > 1 || pattern.startsWith("/");

  function matchFrom(pi: number, fi: number): boolean {
    if (pi === patternSegs.length) return fi === fileSegs.length;
    const seg = patternSegs[pi];
    if (seg === "**") {
      for (let k = fi; k <= fileSegs.length; k++) {
        if (matchFrom(pi + 1, k)) return true;
      }
      return false;
    }
    if (fi >= fileSegs.length) return false;
    if (!segmentToRegExp(seg).test(fileSegs[fi])) return false;
    return matchFrom(pi + 1, fi + 1);
  }

  if (anchored) return matchFrom(0, 0);
  return fileSegs.some((seg) => segmentToRegExp(patternSegs[0]).test(seg));
}

function checkCodeowners(): string[] {
  const violations: string[] = [];
  const text = readFileSync(join(ROOT, CODEOWNERS_PATH), "utf8");
  const rules = parseCodeowners(text);
  const allFiles = walk(".");

  // (a) regla → archivo: toda regla resuelve a ≥1 archivo existente.
  for (const rule of rules) {
    if (!allFiles.some((f) => matchesCodeownersPattern(rule.pattern, f))) {
      violations.push(
        `${CODEOWNERS_PATH}:${rule.line} — la regla "${rule.pattern}" no casa ningún archivo del árbol`
      );
    }
  }

  // (b) archivo → regla: toda ruta protegida (§8.1) está cubierta por ≥1
  // regla. CONTRIBUTING.md §"Cómo se revisa" es explícito en que la regla se
  // indexa por destino del contenido, no por ruta de archivo — así que esto
  // corre sobre la lista declarada, no sobre lo que CODEOWNERS ya cubre.
  for (const entry of PROTECTED_PATHS) {
    if (entry.includes("*")) {
      const matched = allFiles.filter((f) => matchesCodeownersPattern(entry, f));
      if (matched.length === 0) {
        violations.push(`§8.1 — la ruta protegida "${entry}" no casa ningún archivo real`);
        continue;
      }
      for (const f of matched) {
        if (!rules.some((r) => matchesCodeownersPattern(r.pattern, f))) {
          violations.push(
            `§8.1 — "${f}" (bajo la ruta protegida "${entry}") no está cubierto por ninguna regla de CODEOWNERS`
          );
        }
      }
    } else {
      if (!existsSync(join(ROOT, entry))) {
        violations.push(`§8.1 — la ruta protegida "${entry}" no existe en el árbol`);
        continue;
      }
      if (!rules.some((r) => matchesCodeownersPattern(r.pattern, entry))) {
        violations.push(`§8.1 — "${entry}" no está cubierto por ninguna regla de CODEOWNERS`);
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Auto-test del emparejador de patrones, ANTES de usarlo sobre el árbol real.
// Fixtures negativas en las dos direcciones que exige la fila 2, más el caso
// de "*" contra "**" que motiva no usar un globber genérico.
// ---------------------------------------------------------------------------
{
  assert.ok(matchesCodeownersPattern("curriculum/*", "curriculum/a.json"));
  assert.ok(
    !matchesCodeownersPattern("curriculum/*", "curriculum/sub/a.json"),
    '"*" no debe cruzar "/"'
  );
  assert.ok(
    matchesCodeownersPattern("curriculum/**", "curriculum/sub/deep/a.json"),
    '"**" sí debe cruzar "/"'
  );

  // Fixture negativa, dirección (a) regla → archivo: una regla que no casa
  // ningún archivo real debe quedar huérfana.
  const fakeFiles = ["curriculum/contextia.json", "packages/shared/src/access.ts"];
  assert.ok(!fakeFiles.some((f) => matchesCodeownersPattern("does/not/exist.ts", f)));

  // Fixture negativa, dirección (b) archivo → regla: una ruta protegida que
  // ninguna regla cubre debe quedar descubierta.
  const fakeRules = ["curriculum/**"];
  assert.ok(
    !fakeRules.some((r) => matchesCodeownersPattern(r, "packages/shared/src/tutor-prompt.ts"))
  );
  assert.ok(fakeRules.some((r) => matchesCodeownersPattern(r, "curriculum/contextia.json")));

  // Patrón de un solo segmento (sin "/"): casa por nombre final a cualquier
  // profundidad, que es el caso real de `pnpm-workspace.yaml`.
  assert.ok(matchesCodeownersPattern("pnpm-workspace.yaml", "pnpm-workspace.yaml"));
  assert.ok(!matchesCodeownersPattern("pnpm-workspace.yaml", "apps/api/package.json"));
}

// ---------------------------------------------------------------------------
// Fila 3 — `export type Access` sin duplicar
// ---------------------------------------------------------------------------

function checkAccessTypeUnique(): void {
  const ACCESS_TYPE_RE = /\bexport\s+type\s+Access\b/g;
  const hits: string[] = [];
  for (const root of [API_SRC, WEB_SRC, SHARED_SRC]) {
    for (const file of sourceFiles(root)) {
      const text = stripComments(readFileSync(join(ROOT, file), "utf8"));
      const count = text.match(ACCESS_TYPE_RE)?.length ?? 0;
      for (let i = 0; i < count; i++) hits.push(file);
    }
  }
  assert.equal(
    hits.length,
    1,
    `"export type Access" debe aparecer exactamente una vez en el árbol; apareció en: ${
      hits.join(", ") || "(ninguno)"
    }`
  );
  assert.equal(
    hits[0],
    `${SHARED_SRC}/access.ts`,
    `"export type Access" debe vivir en ${SHARED_SRC}/access.ts, no en ${hits[0]}`
  );
}

// ---------------------------------------------------------------------------
// Fila 4 — ningún Client Component importa `@shared/*` por valor
// ---------------------------------------------------------------------------

const USE_CLIENT_RE = /^\s*["']use client["'];?\s*$/m;
// Anclada a principio de línea y SIN cruzar `;`. Las dos cosas hacen falta: con
// `[\s\S]*?` el match arranca en un `import` ANTERIOR de la misma región y se
// lleva su cláusula, de modo que el `type` de la sentencia real queda fuera de
// la captura y un `import type` legítimo se reporta como import por valor. Pasó
// de verdad con chat-client.tsx y registro-form.tsx, donde hay un
// `import ... from "./actions";` justo encima. `[^;]` corta en el punto y coma
// de la sentencia previa y el ancla `^` con `m` impide empezar a mitad de línea;
// un import multilínea sigue casando porque no lleva `;` dentro.
const SHARED_IMPORT_RE = /^(?:import|export)\s+([^;]*?)\s+from\s+["']@shared\/[^"']+["']/gm;

/** `true` si la cláusula trae al menos un binding de VALOR (no solo tipos). */
function clauseIsValueImport(clause: string): boolean {
  const trimmed = clause.trim();
  if (/^type\s/.test(trimmed)) return false; // `import type {...}` / `export type {...}`
  if (trimmed.startsWith("*")) return true; // `import * as ns` / `export * as ns`
  if (!trimmed.startsWith("{")) return true; // import por defecto: siempre de valor
  const inner = trimmed.slice(trimmed.indexOf("{") + 1, trimmed.lastIndexOf("}"));
  const specifiers = inner
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // De valor si ALGÚN nombrado no lleva su propio modificador `type`.
  return specifiers.some((s) => !/^type\s/.test(s));
}

function checkNoClientValueImportsFromShared(): string[] {
  const violations: string[] = [];
  for (const file of sourceFiles(WEB_SRC)) {
    const raw = readFileSync(join(ROOT, file), "utf8");
    if (!USE_CLIENT_RE.test(raw)) continue;
    const text = stripComments(raw);
    for (const match of text.matchAll(SHARED_IMPORT_RE)) {
      const clause = match[1];
      if (clauseIsValueImport(clause)) {
        const line = text.slice(0, match.index).split("\n").length;
        violations.push(
          `${file}:${line} — Client Component importa por valor de @shared ("${clause.trim()}")`
        );
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Fila 15 — los agregados de `package.json` resuelven
// ---------------------------------------------------------------------------

function checkPackageJsonScripts(pkgPath: string): string[] {
  const violations: string[] = [];
  const abs = join(ROOT, pkgPath);
  if (!existsSync(abs)) return violations; // p.ej. apps/web/package.json antes de la mudanza
  const pkg = JSON.parse(readFileSync(abs, "utf8")) as { scripts?: Record<string, string> };
  const scripts = pkg.scripts ?? {};
  const pkgDir = dirname(pkgPath);
  for (const [name, command] of Object.entries(scripts)) {
    for (const rawSegment of command.split("&&")) {
      // Solo nos interesan invocaciones `node <archivo>`; "next build",
      // "drizzle-kit generate", "pnpm --filter web build", etc. no apuntan a
      // un archivo del árbol y quedan fuera a propósito.
      const match = rawSegment.trim().match(/^node\s+(?:--\S+\s+)*(\S+\.(?:ts|js|mjs|cjs))\b/);
      if (!match) continue;
      const target = `${pkgDir}/${match[1]}`.replace(/^\.\//, "");
      if (!existsSync(join(ROOT, target))) {
        violations.push(`${pkgPath}: scripts.${name} apunta a "${target}", que no existe`);
      }
    }
    if (name === "curriculum:check") {
      for (const dbScript of DB_REQUIRING_SCRIPTS) {
        if (command.includes(dbScript)) {
          violations.push(
            `${pkgPath}: scripts.curriculum:check todavía invoca ${dbScript}, que exige base de datos (§7.4)`
          );
        }
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function assertNone(label: string, violations: string[]): void {
  assert.equal(
    violations.length,
    0,
    `${label} (${violations.length}):\n${violations.map((v) => `  - ${v}`).join("\n")}`
  );
}

function main(): void {
  for (const root of [API_SRC, WEB_SRC, SHARED_SRC]) {
    assert.ok(
      existsSync(join(ROOT, root)) && sourceFiles(root).length > 0,
      `${root} no existe o no contiene archivos .ts/.tsx — check-boundaries.ts exige el layout ` +
        "de PRD-006 §7.1 (cobertura no vacía, misma razón que §8.1 capa 2)"
    );
  }
  assert.ok(existsSync(join(ROOT, CODEOWNERS_PATH)), `${CODEOWNERS_PATH} no existe`);

  assertNone("Fila 1 — fronteras entre paquetes", checkBoundaries());
  assertNone("Fila 2 — CODEOWNERS", checkCodeowners());
  checkAccessTypeUnique(); // Fila 3, ya lanza con su propio mensaje
  assertNone(
    "Fila 4 — Client Component importa @shared por valor",
    checkNoClientValueImportsFromShared()
  );
  assertNone("Fila 15 — agregados de package.json", [
    ...checkPackageJsonScripts(ROOT_PACKAGE_JSON),
    ...checkPackageJsonScripts(WEB_PACKAGE_JSON),
  ]);

  console.log(
    "OK — fronteras entre paquetes, CODEOWNERS, tipo Access, Client Components y agregados " +
      "de package.json en pie."
  );
}

main();
