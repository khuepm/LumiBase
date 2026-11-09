-- ADR-013 Phase 3. Existing approvals retain their site scope. Organization-only
-- operations have a real organization parent and never use an unrelated site.
-- Applied in the migrator's transaction; re-runnable. No automatic rollback.
-- Validation fails if manually edited rows have neither/both parents, or an org
-- approval lacks requester provenance: repair those rows before retrying.
ALTER TABLE lumibase_ai_approvals ADD COLUMN IF NOT EXISTS organization_id text;
ALTER TABLE lumibase_ai_approvals ADD COLUMN IF NOT EXISTS organization_requester jsonb;
ALTER TABLE lumibase_ai_approvals ADD COLUMN IF NOT EXISTS result jsonb;
ALTER TABLE lumibase_ai_approvals ALTER COLUMN site_id DROP NOT NULL;
DO $$ BEGIN
  ALTER TABLE lumibase_ai_approvals ADD CONSTRAINT ai_approvals_organization_id_fk
    FOREIGN KEY (organization_id) REFERENCES lumibase_organizations(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE lumibase_ai_approvals ADD CONSTRAINT ai_approvals_scope_target CHECK (
    (site_id IS NOT NULL AND organization_id IS NULL) OR
    (site_id IS NULL AND organization_id IS NOT NULL AND organization_requester IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS ai_approvals_org_status_idx ON lumibase_ai_approvals(organization_id, status);
