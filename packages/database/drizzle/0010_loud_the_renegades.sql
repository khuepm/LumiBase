CREATE TABLE IF NOT EXISTS "user_roles" (
	"user_id" text NOT NULL,
	"site_id" text NOT NULL,
	"role_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_roles_user_id_site_id_role_id_pk" PRIMARY KEY("user_id","site_id","role_id")
);
--> statement-breakpoint
ALTER TABLE "policies" ADD COLUMN "key" text;--> statement-breakpoint
ALTER TABLE "policies" ADD COLUMN "icon" text;--> statement-breakpoint
ALTER TABLE "policies" ADD COLUMN "admin_access" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "policies" ADD COLUMN "app_access" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "policies" ADD COLUMN "enforce_tfa" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "policies" ADD COLUMN "ip_allow" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "policies" ADD COLUMN "ip_deny" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "policies" ADD COLUMN "valid_from" timestamp;--> statement-breakpoint
ALTER TABLE "policies" ADD COLUMN "valid_until" timestamp;--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "key" text;--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "system_key" text;--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "parent_id" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_roles_site_role_idx" ON "user_roles" USING btree ("site_id","role_id");--> statement-breakpoint
INSERT INTO "user_roles" ("user_id", "site_id", "role_id")
SELECT "user_id", "site_id", "role_id"
FROM "user_sites"
WHERE "role_id" IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "permissions"
		GROUP BY "policy_id", "collection", "action"
		HAVING count(*) > 1
	) THEN
		RAISE EXCEPTION 'Cannot create permissions_policy_collection_action_unique: duplicate permission rows exist for at least one policy_id/collection/action.';
	END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "permissions_policy_collection_action_unique" ON "permissions" USING btree ("policy_id","collection","action");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "policies_site_key_unique" ON "policies" USING btree ("site_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "roles_site_key_unique" ON "roles" USING btree ("site_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "roles_site_system_key_unique" ON "roles" USING btree ("site_id","system_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "roles_parent_idx" ON "roles" USING btree ("parent_id");
