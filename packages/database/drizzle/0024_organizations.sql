-- ADR-013 Phase 1. The migrator runs this file in its transaction.
-- All existing sites move to one Personal Org; only the bootstrap user becomes
-- owner. Existing API keys retain site scope. No automatic rollback: restore
-- a pre-upgrade backup to remove the organization plane.
-- Re-runnable. FK/CHECK validation fails for inconsistent manually edited data;
-- repair orphan organization IDs / key targets before retrying. No rows deleted.
CREATE TABLE IF NOT EXISTS lumibase_organizations (
  id text PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  settings jsonb NOT NULL DEFAULT '{}',
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS lumibase_organization_members (
  user_id text NOT NULL REFERENCES lumibase_users(id) ON DELETE CASCADE,
  organization_id text NOT NULL REFERENCES lumibase_organizations(id) ON DELETE CASCADE,
  role text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, organization_id),
  CONSTRAINT org_members_role_check CHECK (role IN ('owner','admin','billing','member'))
);
CREATE INDEX IF NOT EXISTS org_members_org_idx ON lumibase_organization_members(organization_id);
ALTER TABLE lumibase_sites ADD COLUMN IF NOT EXISTS organization_id text;
DO $$ BEGIN
  ALTER TABLE lumibase_sites ADD CONSTRAINT lumibase_sites_organization_id_fk
    FOREIGN KEY (organization_id) REFERENCES lumibase_organizations(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Built-in random UUID entropy avoids requiring the pgcrypto extension. This
-- is a random 21-character domain identifier, never a serial/sequence.
INSERT INTO lumibase_organizations (id, slug, name)
SELECT substr(replace(gen_random_uuid()::text, '-', ''), 1, 21), 'default',
  COALESCE((SELECT COALESCE(display_title, name) FROM lumibase_sites WHERE id='__default__'), 'Default')
WHERE NOT EXISTS (SELECT 1 FROM lumibase_organizations WHERE slug='default');
UPDATE lumibase_sites SET organization_id =
  (SELECT id FROM lumibase_organizations WHERE slug='default') WHERE organization_id IS NULL;
INSERT INTO lumibase_organization_members (user_id, organization_id, role)
SELECT u.id, o.id, 'owner' FROM lumibase_users u CROSS JOIN lumibase_organizations o
WHERE u.is_bootstrap = true AND o.slug='default'
ON CONFLICT (user_id, organization_id) DO NOTHING;
ALTER TABLE lumibase_sites ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE lumibase_api_keys ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'site';
ALTER TABLE lumibase_api_keys ADD COLUMN IF NOT EXISTS organization_id text;
ALTER TABLE lumibase_api_keys ALTER COLUMN site_id DROP NOT NULL;
DO $$ BEGIN
  ALTER TABLE lumibase_api_keys ADD CONSTRAINT lumibase_api_keys_organization_id_fk
    FOREIGN KEY (organization_id) REFERENCES lumibase_organizations(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE lumibase_api_keys ADD CONSTRAINT api_keys_scope_target CHECK (
    (scope='site' AND site_id IS NOT NULL AND organization_id IS NULL) OR
    (scope='organization' AND organization_id IS NOT NULL AND site_id IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS api_keys_organization_idx ON lumibase_api_keys(organization_id);
