-- Site Skills (#712): editorial playbooks a site writes down for agents, with an
-- immutable version trail. Two new tables only; nothing existing is altered, so
-- no backfill is needed and instances upgraded from 2.0.0 start with no skills
-- (nothing is injected into any agent run until an admin activates one).
-- Re-runnable: every statement is guarded. Re-apply
-- packages/database/migrations/rls-policies.sql afterwards (both tables are in
-- its site_isolation list).
CREATE TABLE IF NOT EXISTS lumibase_site_skills (
  id text PRIMARY KEY NOT NULL,
  site_id text NOT NULL REFERENCES lumibase_sites(id) ON DELETE CASCADE,
  slug text NOT NULL,
  name text NOT NULL,
  description text DEFAULT '' NOT NULL,
  status text DEFAULT 'draft' NOT NULL,
  risk_class text DEFAULT 'low' NOT NULL,
  priority integer DEFAULT 0 NOT NULL,
  triggers jsonb DEFAULT '[]'::jsonb NOT NULL,
  surfaces jsonb DEFAULT '[]'::jsonb NOT NULL,
  tools jsonb DEFAULT '[]'::jsonb NOT NULL,
  collections jsonb DEFAULT '[]'::jsonb NOT NULL,
  required_capabilities jsonb DEFAULT '[]'::jsonb NOT NULL,
  body text NOT NULL,
  version integer DEFAULT 1 NOT NULL,
  hash text NOT NULL,
  source text DEFAULT 'api' NOT NULL,
  source_ref text,
  created_by text REFERENCES lumibase_users(id) ON DELETE SET NULL,
  updated_by text REFERENCES lumibase_users(id) ON DELETE SET NULL,
  activated_at timestamp,
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS site_skills_site_slug_unique ON lumibase_site_skills (site_id, slug);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS site_skills_site_status_idx ON lumibase_site_skills (site_id, status);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS lumibase_site_skill_versions (
  id text PRIMARY KEY NOT NULL,
  site_id text NOT NULL REFERENCES lumibase_sites(id) ON DELETE CASCADE,
  skill_id text NOT NULL REFERENCES lumibase_site_skills(id) ON DELETE CASCADE,
  version integer NOT NULL,
  hash text NOT NULL,
  snapshot jsonb NOT NULL,
  source text DEFAULT 'api' NOT NULL,
  source_ref text,
  change_note text,
  author_id text REFERENCES lumibase_users(id) ON DELETE SET NULL,
  author_label text,
  created_at timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS site_skill_versions_skill_version_unique ON lumibase_site_skill_versions (skill_id, version);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS site_skill_versions_site_skill_idx ON lumibase_site_skill_versions (site_id, skill_id);
