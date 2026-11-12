import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { withOrganizationAccessGuard } from '../middleware/organization-access-guard';
import { systemDbFor } from '../middleware/db';
import { organizationActorFromAuth } from '../services/organization-operations';
import { decideOrganizationApproval, getOrganizationApproval, listOrganizationApprovals } from '../services/organization-harness';

export const organizationApprovalsRouter = new Hono<AppEnv>();
organizationApprovalsRouter.use('*', withOrganizationAccessGuard('org:keys:manage'), async (c, next) => {
  // Approval receipts may contain newly minted secrets. They are human-only,
  // even though an org key otherwise has the admin role's keys:manage action.
  c.header('Cache-Control', 'no-store');
  const auth = c.get('auth');
  if (!auth.userId || auth.apiKeyId) return c.json({ errors: [{ code: 'ORGANIZATION_FORBIDDEN' }] }, 403);
  return next();
});
organizationApprovalsRouter.get('/', async (c) => c.json({ data: await listOrganizationApprovals(c.get('db'), c.get('organization')!.id) }));
organizationApprovalsRouter.get('/:approvalId', async (c) => c.json({ data: await getOrganizationApproval(c.get('db'), c.get('organization')!.id, c.req.param('approvalId')) }));
organizationApprovalsRouter.post('/:approvalId/decide', async (c) => {
  const input = z.strictObject({ decision: z.enum(['approved', 'rejected']) }).safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ errors: [{ code: 'VALIDATION' }] }, 400);
  const receipt = await decideOrganizationApproval({ db: systemDbFor(c), organizationId: c.get('organization')!.id,
    approvalId: c.req.param('approvalId'), decision: input.data.decision,
    decider: organizationActorFromAuth(c.get('auth')), env: c.env, runtime: c.get('runtime'), requestId: c.get('requestId') });
  return c.json({ data: receipt });
});
