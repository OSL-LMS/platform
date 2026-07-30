// Costura hacia el prompt certificado de la raíz (PRD-005 §7).
//
// ponytail: import temporal a la raíz; lo cierra la fase de packages/shared, ver ADR-001 §7
//
// POR QUÉ RE-EXPORTAR Y NO COPIAR, que aquí no es una preferencia de estilo:
// `TUTOR_SYSTEM_PROMPT` lo certifica un banco de 35 evals y `CONTRIBUTING.md`
// promete que ningún cambio suyo se despliega sin pasarlo. Una segunda copia es
// la forma de desplegar un tutor que nadie certificó, y el fallo sería
// SILENCIOSO: el tutor responde igual, solo que con otro texto.
//
// Es el mismo idioma que `db/schema.ts:12` — ruta relativa con extensión, un
// fichero de costura por pieza — y su coste (el `rootDir` inferido por tsc, que
// es lo que obliga a arrancar con `node dist/apps/api/src/main.js`) está pagado
// desde PRD-003.
//
// El módulo de destino es PURO: no importa base de datos, así que esta costura
// no arrastra el `Pool` de `src/lib/db.ts` al proceso de apps/api.
//
// Regla de código: identificadores en inglés, comentarios en español.

export * from "../../../../src/lib/tutor-prompt.ts";
