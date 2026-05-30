CREATE TABLE IF NOT EXISTS "login_baselines" (
	"user_id" text PRIMARY KEY NOT NULL,
	"countries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"hour_histogram" jsonb DEFAULT '[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]'::jsonb NOT NULL,
	"device_fingerprints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"successful_logins" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "login_baselines" ADD CONSTRAINT "login_baselines_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
