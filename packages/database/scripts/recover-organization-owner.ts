/** Operator-only recovery for an organization backfilled without a bootstrap user. */
import postgres from 'postgres';

const [organizationId, userId, confirmation] = process.argv.slice(2);
if (!organizationId || !userId || confirmation !== `CONFIRM:${organizationId}`) {
  console.error('Usage: pnpm -F @lumibase/database recover:organization-owner <organization-id> <user-id> CONFIRM:<organization-id>');
  process.exit(2);
}
const url = process.env.DATABASE_SYSTEM_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_SYSTEM_URL or DATABASE_URL is required');
const db = postgres(url, { max: 1, prepare: false });
try {
  await db.begin(async (tx) => {
    const org = await tx`SELECT id FROM lumibase_organizations WHERE id = ${organizationId} FOR UPDATE`;
    if (!org.length) throw new Error('Organization does not exist');
    const owners = await tx`SELECT 1 FROM lumibase_organization_members
      WHERE organization_id = ${organizationId} AND role = 'owner' LIMIT 1`;
    if (owners.length) throw new Error('Organization already has an owner; use the member API');
    const user = await tx`SELECT id FROM lumibase_users WHERE id = ${userId} AND status = 'active'`;
    if (!user.length) throw new Error('Target user must exist and be active');
    const inaccessible = await tx`SELECT s.id FROM lumibase_sites s
      WHERE s.organization_id = ${organizationId} AND NOT EXISTS (
        SELECT 1 FROM lumibase_user_sites us JOIN lumibase_roles r ON r.id = us.role_id
        WHERE us.site_id = s.id AND us.user_id = ${userId} AND r.admin_access = true
      ) LIMIT 1`;
    if (inaccessible.length) throw new Error('Target user must already administer every site in this organization');
    await tx`INSERT INTO lumibase_organization_members (user_id, organization_id, role)
      VALUES (${userId}, ${organizationId}, 'owner')
      ON CONFLICT (user_id, organization_id) DO UPDATE SET role = 'owner'`;
  });
  console.log(`Recovered owner membership for organization ${organizationId}`);
} finally {
  await db.end();
}
