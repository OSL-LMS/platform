CREATE TABLE "broadcasts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"curriculum" text NOT NULL,
	"season" text NOT NULL,
	"lesson_node_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"vod_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "broadcasts_season_lesson_starts_key" UNIQUE("curriculum","season","lesson_node_id","starts_at"),
	CONSTRAINT "broadcasts_vod_url_https_check" CHECK ("broadcasts"."vod_url" IS NULL OR "broadcasts"."vod_url" LIKE 'https://%')
);
--> statement-breakpoint
CREATE INDEX "broadcasts_curriculum_starts_idx" ON "broadcasts" USING btree ("curriculum","starts_at");