CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"timestamp" timestamp DEFAULT now() NOT NULL,
	"event" text NOT NULL,
	"actor_email" text,
	"target_email" text,
	"ip" text,
	"user_agent" text,
	"country_code" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request_id" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "system_state" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"state" text DEFAULT 'uninitialized' NOT NULL,
	"admin_path" text,
	"setup_token_hash" text,
	"initialized_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "system_state_singleton_chk" CHECK ("system_state"."id" = 'singleton')
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_bootstrap" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "locked_until" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "failed_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "failed_count_window_start" timestamp;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_ts_idx" ON "audit_log" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_event_idx" ON "audit_log" USING btree ("event","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_actor_idx" ON "audit_log" USING btree ("actor_email","timestamp");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "system_state_admin_path_unique" ON "system_state" USING btree ("admin_path");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_is_bootstrap_unique" ON "users" USING btree ("is_bootstrap") WHERE "users"."is_bootstrap" = true;