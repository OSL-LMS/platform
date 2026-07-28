CREATE TABLE "curriculum_nodes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"curriculum" text NOT NULL,
	"parent_id" uuid,
	"kind" text NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"position" integer NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	-- EDITADO A MANO (PRD-002 §6.1 / §10 paso 3). drizzle-kit no emite DEFERRABLE
	-- desde su constructor `unique()`, y sin ella intercambiar dos `slug` o
	-- reutilizar el de un nodo retirado aborta la carga a mitad de la fase de
	-- escritura. INITIALLY IMMEDIATE (no DEFERRED): solo el cargador se acoge,
	-- con `SET CONSTRAINTS ... DEFERRED` dentro de su transacción; cualquier otro
	-- escritor sigue viendo el error en la sentencia que lo causa.
	-- La CLAVE PRIMARIA se queda inmediata a propósito: una PK diferible rompe
	-- `ON CONFLICT (id)`, que es como hace upsert el cargador.
	CONSTRAINT "curriculum_nodes_curriculum_slug_key" UNIQUE("curriculum","slug") DEFERRABLE INITIALLY IMMEDIATE
);
--> statement-breakpoint
ALTER TABLE "curriculum_nodes" ADD CONSTRAINT "curriculum_nodes_parent_id_curriculum_nodes_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."curriculum_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "curriculum_nodes_parent_position_idx" ON "curriculum_nodes" USING btree ("curriculum","parent_id","position");--> statement-breakpoint
COMMENT ON COLUMN "curriculum_nodes"."curriculum" IS 'Slug del currículo. NO hay aislamiento ni control de acceso entre currículos: cualquier lector puede leer cualquiera. Este valor sale de CURRICULUM_SLUG (configuración de servidor) y NUNCA se deriva del request. Ver PRD-002 §8.5.';
