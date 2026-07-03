-- External JWT authentication (spec: .kiro/specs/external-jwt-auth).
-- Trusted external issuer config per site. PUBLIC config only — no secrets
-- (signatures verify against the issuer's public JWKS). Additive + idempotent;
-- existing instances have no issuers → the external-JWT auth branch skips every
-- token and current auth (CF Access / custom JWT) is unchanged. No backfill.
--
-- NOTE: renumbered 0034 -> 0042 when merging main v0.15 (main occupied
-- 0033-0039; 0040/0041 are reserved by the in-flight content-releases and
-- save-default-preference PRs).
CREATE TABLE IF NOT EXISTS "auth_external_issuers" (
  "id" text PRIMARY KEY NOT NULL,
  "site_id" text NOT NULL,
  "issuer" text NOT NULL,
  "jwks_uri" text,
  "discovery_url" text,
  "audience" jsonb NOT NULL,
  "algorithms" jsonb NOT NULL,
  "claim_mapping" jsonb NOT NULL,
  "role_mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "default_role_id" text,
  "jit_provisioning" boolean DEFAULT false NOT NULL,
  "clock_skew_seconds" integer DEFAULT 60 NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "auth_external_issuers" ADD CONSTRAINT "auth_external_issuers_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "auth_external_issuers_site_issuer_unique" ON "auth_external_issuers" USING btree ("site_id","issuer");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_external_issuers_site_enabled_idx" ON "auth_external_issuers" USING btree ("site_id","enabled");
