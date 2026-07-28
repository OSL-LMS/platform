// Detector de cambios de identidad entre dos versiones del archivo de
// currículo. Se ejecuta con: node scripts/check-curriculum-identity.ts
//
// Por qué existe (PRD-002 §8.1): las reglas de §5.1 son puras y ven UNA sola
// versión del archivo — `id` presente, con forma UUID y único. Ninguna puede
// detectar un `id` *cambiado*, porque un UUID nuevo es un UUID válido y único;
// detectarlo exige comparar contra el estado anterior. Y el clasificador del
// cargador empareja por `slug`, así que es estructuralmente ciego cuando `id` y
// `slug` cambian a la vez. Comparar contra `git show HEAD:` no depende de
// ninguna señal dentro del archivo: es el único detector completo de la clase.
//
// Cubre la fila 24 de PRD-002 §9.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const FILE = "curriculum/contextia.json";

type NodeLike = { id?: unknown; slug?: unknown; children?: unknown };

/** Aplana a `[{id, slug}]` sin validar nada más: este script tiene que poder
 *  leer la versión ANTERIOR del archivo, que puede no cumplir el contrato de
 *  hoy. Validar es trabajo de `check-curriculum.ts`. */
function identities(raw: unknown): { id: string; slug: string }[] {
  const out: { id: string; slug: string }[] = [];
  const walk = (nodes: unknown) => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes as NodeLike[]) {
      if (node && typeof node.id === "string" && typeof node.slug === "string") {
        out.push({ id: node.id, slug: node.slug });
      }
      walk(node?.children);
    }
  };
  walk((raw as { nodes?: unknown })?.nodes);
  return out;
}

export type IdentityDiff = {
  /** Mismo `slug`, otro `id`. El clasificador del cargador también lo ve. */
  changed: { slug: string; before: string; after: string }[];
  /** `id` que desaparece. Con él muere todo lo que cuelgue de esa fila. */
  gone: { id: string; slug: string }[];
  /** `id` que aparece. Solo o emparejado con una baja. */
  added: { id: string; slug: string }[];
  /** Un `id` que se fue y otro que llegó, con `slug` distinto: el punto ciego
   *  del cargador. No se puede afirmar que sean el mismo nodo, y por eso se
   *  reporta como sospecha en vez de como certeza. */
  suspicious: { gone: { id: string; slug: string }; added: { id: string; slug: string } }[];
};

export function diffIdentities(beforeRaw: unknown, afterRaw: unknown): IdentityDiff {
  const before = identities(beforeRaw);
  const after = identities(afterRaw);

  const afterIds = new Set(after.map((n) => n.id));
  const beforeIds = new Set(before.map((n) => n.id));
  const afterBySlug = new Map(after.map((n) => [n.slug, n]));

  const changed: IdentityDiff["changed"] = [];
  const gone: IdentityDiff["gone"] = [];
  for (const node of before) {
    if (afterIds.has(node.id)) continue;
    const twin = afterBySlug.get(node.slug);
    if (twin && !beforeIds.has(twin.id)) {
      changed.push({ slug: node.slug, before: node.id, after: twin.id });
    } else {
      gone.push(node);
    }
  }

  const changedAfterIds = new Set(changed.map((c) => c.after));
  const added = after.filter((n) => !beforeIds.has(n.id) && !changedAfterIds.has(n.id));

  // Emparejamiento posicional de lo que queda: una baja y un alta sin `slug` en
  // común. Es exactamente el caso al que el cargador es ciego.
  const suspicious = gone
    .map((g, i) => (added[i] ? { gone: g, added: added[i] } : null))
    .filter((pair): pair is NonNullable<typeof pair> => pair !== null);

  return { changed, gone, added, suspicious };
}

// ---------------------------------------------------------------------------
// Fila 24 — el detector, contra fixtures
// ---------------------------------------------------------------------------
{
  const node = (id: string, slug: string, children: unknown[] = []) => ({ id, slug, children });
  const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  // Sin cambios.
  const base = { nodes: [node(A, "E1", [node(B, "L1")])] };
  assert.deepEqual(diffIdentities(base, base), {
    changed: [], gone: [], added: [], suspicious: [],
  });

  // `id` cambiado con el `slug` intacto — el caso común.
  const renamedId = { nodes: [node(A, "E1", [node(C, "L1")])] };
  const d1 = diffIdentities(base, renamedId);
  assert.deepEqual(d1.changed, [{ slug: "L1", before: B, after: C }]);
  assert.deepEqual(d1.gone, []);
  assert.deepEqual(d1.added, []);

  // `id` Y `slug` cambiados a la vez: el punto ciego del cargador, que aquí SÍ
  // se reporta. Es la razón de ser de este script.
  const renamedBoth = { nodes: [node(A, "E1", [node(C, "leccion-uno")])] };
  const d2 = diffIdentities(base, renamedBoth);
  assert.deepEqual(d2.changed, []);
  assert.equal(d2.gone.length, 1);
  assert.equal(d2.added.length, 1);
  assert.equal(d2.suspicious.length, 1, "una baja + un alta sin slug común es sospecha");
  assert.equal(d2.suspicious[0].gone.id, B);
  assert.equal(d2.suspicious[0].added.id, C);

  // Renombrar SOLO el `slug` conservando el `id` no es un cambio de identidad.
  const renamedSlug = { nodes: [node(A, "E1", [node(B, "css-basico")])] };
  assert.deepEqual(diffIdentities(base, renamedSlug), {
    changed: [], gone: [], added: [], suspicious: [],
  });

  // Alta limpia: ni baja ni sospecha.
  const grown = { nodes: [node(A, "E1", [node(B, "L1"), node(C, "L2")])] };
  const d3 = diffIdentities(base, grown);
  assert.deepEqual(d3.changed, []);
  assert.deepEqual(d3.gone, []);
  assert.equal(d3.added.length, 1);
  assert.deepEqual(d3.suspicious, []);
}

// ---------------------------------------------------------------------------
// El archivo real, contra la versión de la que parte la rama
// ---------------------------------------------------------------------------

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: "pipe" }).trim();
}

/**
 * Contra QUÉ se compara. `HEAD` a secas no sirve en el flujo que
 * `CONTRIBUTING.md` prescribe: commitear es el paso 5 y abrir el PR el 6, así
 * que quien corre esto en orden ya tiene el `id` cambiado DENTRO de `HEAD` —
 * el diff sale vacío y el script imprime OK sin haber mirado nada.
 *
 * La base correcta es de dónde salió la rama. `HEAD` queda como último
 * recurso: en la rama por defecto sí es la comparación que se quiere.
 */
function baseRef(): string {
  for (const ref of ["origin/main", "origin/master", "main", "master"]) {
    try {
      git("rev-parse", "--verify", "--quiet", ref);
      return git("merge-base", "HEAD", ref);
    } catch {
      // Esa referencia no existe en este clon; se prueba la siguiente.
    }
  }
  return "HEAD";
}

const base = baseRef();
let head: unknown = null;
try {
  head = JSON.parse(git("show", `${base}:${FILE}`));
} catch {
  // El archivo aún no existe en la base (es nuevo): no hay contra qué comparar.
  console.log(`OK — ${FILE} no existe todavía en ${base.slice(0, 8)}: nada que comparar.`);
  process.exit(0);
}

const working = JSON.parse(readFileSync(resolve(ROOT, FILE), "utf8"));
const diff = diffIdentities(head, working);

const problems = diff.changed.length + diff.gone.length + diff.suspicious.length;
if (problems > 0) {
  console.error(
    `curriculum-identity — ${problems} cambio(s) de identidad respecto a ${base.slice(0, 8)}:`
  );
  for (const c of diff.changed) {
    console.error(`  ! "${c.slug}" cambia de id: ${c.before} → ${c.after}`);
  }
  for (const g of diff.gone) console.error(`  - "${g.slug}" (${g.id}) desaparece`);
  for (const s of diff.suspicious) {
    console.error(
      `  ? "${s.gone.slug}" (${s.gone.id}) desaparece y "${s.added.slug}" (${s.added.id}) ` +
        `aparece: ¿es el mismo nodo con id y slug cambiados a la vez?`
    );
  }
  console.error(
    "  Un `id` es la identidad del nodo y sobrevive a renombrados: cambiarlo destruye " +
      "todo lo que cuelgue de esa fila. Ver curriculum/README.md."
  );
  process.exit(1);
}

console.log(
  `OK — identidad estable respecto a ${base.slice(0, 8)}: ` +
    `${diff.added.length} alta(s), ningún \`id\` cambiado.`
);
