CREATE TABLE IF NOT EXISTS "admin_backup_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"used_at" timestamp,
	"used_from_ip" text
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "admin_backup_codes" ADD CONSTRAINT "admin_backup_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_backup_codes_user_unused_idx" ON "admin_backup_codes" USING btree ("user_id") WHERE "admin_backup_codes"."used_at" IS NULL;