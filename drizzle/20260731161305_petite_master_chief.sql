CREATE TYPE "public"."evidence_status" AS ENUM('declared', 'verified', 'failed');--> statement-breakpoint
CREATE TABLE "lesson_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"lesson_node_id" uuid NOT NULL,
	"url" text NOT NULL,
	"status" "evidence_status" DEFAULT 'declared' NOT NULL,
	"failure_reason" text,
	"checked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "lesson_evidence_user_lesson_key" UNIQUE("user_id","lesson_node_id"),
	CONSTRAINT "lesson_evidence_url_https_check" CHECK ("lesson_evidence"."url" LIKE 'https://%')
);
--> statement-breakpoint
ALTER TABLE "lesson_evidence" ADD CONSTRAINT "lesson_evidence_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lesson_evidence_lesson_status_idx" ON "lesson_evidence" USING btree ("lesson_node_id","status");