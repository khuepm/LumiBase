-- 0044_backend_templates — private backend template catalog (#902, epic #900 BT02).
--
-- Two new site-scoped tables; additive only, no backfill (existing sites get
-- no template and no content):
--   lumibase_backend_templates           one editable draft per (site, slug),
--                                        optimistic `draft_revision` counter.
--   lumibase_backend_template_revisions  immutable published revisions, unique
--                                        per (site, template, version), content-
--                                        addressed by `digest`.
-- Official templates ship read-only in the application bundle, not here.
-- Both tables carry site_id and are added to the site_isolation list in
-- rls-policies.sql — re-apply it after migrating, as after every upgrade.
--
-- Hand-written to the 0040-0043 convention (re-runnable: IF NOT EXISTS /
-- duplicate_object guards); the drizzle snapshot chain stops at 0000, so
-- `drizzle-kit generate` re-emits every table. Number is provisional on the
-- epic/900 branch and is renumbered when the epic merges into main.
-- Rollback:
--   DROP TABLE IF EXISTS lumibase_backend_template_revisions, lumibase_backend_templates;
CREATE TABLE IF NOT EXISTS "lumibase_backend_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"draft" jsonb NOT NULL,
	"draft_revision" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "lumibase_backend_template_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"template_id" text NOT NULL,
	"template_version" text NOT NULL,
	"digest" text NOT NULL,
	"document" jsonb NOT NULL,
	"published_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
DO $$ BEGIN
  ALTER TABLE "lumibase_backend_templates" ADD CONSTRAINT "backend_templates_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "lumibase_backend_templates" ADD CONSTRAINT "backend_templates_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "public"."lumibase_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "lumibase_backend_template_revisions" ADD CONSTRAINT "backend_template_revisions_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "lumibase_backend_template_revisions" ADD CONSTRAINT "backend_template_revisions_template_fk" FOREIGN KEY ("template_id") REFERENCES "public"."lumibase_backend_templates"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "lumibase_backend_template_revisions" ADD CONSTRAINT "backend_template_revisions_published_by_fk" FOREIGN KEY ("published_by") REFERENCES "public"."lumibase_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "backend_templates_site_slug_unique" ON "lumibase_backend_templates" USING btree ("site_id","slug");
CREATE UNIQUE INDEX IF NOT EXISTS "backend_template_revisions_version_unique" ON "lumibase_backend_template_revisions" USING btree ("site_id","template_id","template_version");
CREATE INDEX IF NOT EXISTS "backend_template_revisions_digest_idx" ON "lumibase_backend_template_revisions" USING btree ("site_id","digest");
