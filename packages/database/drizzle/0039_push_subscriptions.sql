-- Web Push subscriptions (push-noti feature).
--
-- One row per browser/device PushSubscription an authenticated Studio user
-- has granted. Stores the W3C Push API endpoint plus the two RFC 8291 keys
-- (p256dh, auth) the push dispatcher needs to encrypt payloads.
--
-- Hand-written (migrations 0012+ are authored by hand, not drizzle-kit).
-- Idempotent guards (IF NOT EXISTS) let the migration re-run safely.
--
-- RLS: site_isolation is applied by the consolidated
-- packages/database/migrations/rls-policies.sql (push_subscriptions is added
-- to its table list). Not enabled here per project convention.

CREATE TABLE IF NOT EXISTS "push_subscriptions" (
  "id" text PRIMARY KEY NOT NULL,
  "site_id" text NOT NULL,
  "user_id" text,
  "endpoint" text NOT NULL,
  "p256dh" text NOT NULL,
  "auth" text NOT NULL,
  "user_agent" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "push_subscriptions"
    ADD CONSTRAINT "push_subscriptions_site_id_sites_id_fk"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "push_subscriptions"
    ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "push_subscriptions_site_endpoint_idx"
  ON "push_subscriptions" ("site_id", "endpoint");

CREATE INDEX IF NOT EXISTS "push_subscriptions_site_user_idx"
  ON "push_subscriptions" ("site_id", "user_id");
