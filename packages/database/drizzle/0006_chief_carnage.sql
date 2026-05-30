CREATE TABLE IF NOT EXISTS "login_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"email_lower" text NOT NULL,
	"user_id" text,
	"ip" text NOT NULL,
	"user_agent" text,
	"country_code" text,
	"geo_lookup_status" text,
	"result" text NOT NULL,
	"reason" text,
	"anomaly_score" numeric(4, 2),
	"anomaly_triggered" boolean DEFAULT false NOT NULL,
	"baseline_warmup" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "login_attempts" ADD CONSTRAINT "login_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "login_attempts_email_window_idx" ON "login_attempts" USING btree ("email_lower","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "login_attempts_ip_window_idx" ON "login_attempts" USING btree ("ip","created_at");