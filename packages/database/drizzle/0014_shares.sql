CREATE TABLE IF NOT EXISTS "shares" (
  "id" text PRIMARY KEY NOT NULL,
  "site_id" text NOT NULL,
  "collection" text NOT NULL,
  "item_id" text NOT NULL,
  "role_id" text NOT NULL,
  "token_hash" text NOT NULL,
  "password_hash" text,
  "valid_from" timestamp,
  "valid_until" timestamp,
  "max_uses" integer,
  "used_count" integer DEFAULT 0 NOT NULL,
  "revoked_at" timestamp,
  "revoked_by" text,
  "created_by" text,
  "last_used_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "shares" ADD CONSTRAINT "shares_token_hash_unique" UNIQUE ("token_hash");
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "shares" ADD CONSTRAINT "shares_max_uses_positive" CHECK ("max_uses" IS NULL OR "max_uses" >= 1);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "shares" ADD CONSTRAINT "shares_used_count_non_negative" CHECK ("used_count" >= 0);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "shares" ADD CONSTRAINT "shares_site_id_sites_id_fk"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "shares" ADD CONSTRAINT "shares_role_id_roles_id_fk"
    FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "shares" ADD CONSTRAINT "shares_revoked_by_users_id_fk"
    FOREIGN KEY ("revoked_by") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "shares" ADD CONSTRAINT "shares_created_by_users_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "shares_site_collection_item_idx" ON "shares" ("site_id", "collection", "item_id");
CREATE INDEX IF NOT EXISTS "shares_site_role_idx" ON "shares" ("site_id", "role_id");
CREATE INDEX IF NOT EXISTS "shares_site_revoked_idx" ON "shares" ("site_id", "revoked_at");
