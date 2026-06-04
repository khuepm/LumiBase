CREATE TABLE IF NOT EXISTS "api_key_policies" (
	"api_key_id" text NOT NULL,
	"site_id" text NOT NULL,
	"policy_id" text NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "api_key_policies_api_key_id_policy_id_pk" PRIMARY KEY("api_key_id","policy_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_key_roles" (
	"api_key_id" text NOT NULL,
	"site_id" text NOT NULL,
	"role_id" text NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "api_key_roles_api_key_id_role_id_pk" PRIMARY KEY("api_key_id","role_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" text,
	"rotated_at" timestamp,
	"rotated_by" text,
	"expires_at" timestamp,
	"revoked_at" timestamp,
	"revoked_by" text,
	"last_used_at" timestamp,
	"last_used_ip" text,
	"last_used_user_agent" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "api_key_policies" ADD CONSTRAINT "api_key_policies_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "api_key_policies" ADD CONSTRAINT "api_key_policies_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "api_key_policies" ADD CONSTRAINT "api_key_policies_policy_id_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "api_key_roles" ADD CONSTRAINT "api_key_roles_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "api_key_roles" ADD CONSTRAINT "api_key_roles_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "api_key_roles" ADD CONSTRAINT "api_key_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_rotated_by_users_id_fk" FOREIGN KEY ("rotated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_key_policies_site_policy_idx" ON "api_key_policies" USING btree ("site_id","policy_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_key_roles_site_role_idx" ON "api_key_roles" USING btree ("site_id","role_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "api_keys_token_hash_unique" ON "api_keys" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_keys_site_prefix_idx" ON "api_keys" USING btree ("site_id","prefix");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_keys_site_active_idx" ON "api_keys" USING btree ("site_id","revoked_at","expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_keys_created_by_idx" ON "api_keys" USING btree ("created_by");