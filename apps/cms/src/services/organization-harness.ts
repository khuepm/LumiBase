import { and, desc, eq, isNull } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { aiApprovals, organizationMembers, organizations, sites, users, type Database } from '@lumibase/database';
import { canOrg, OrganizationToolSchemas, type OrgRole, type OrganizationToolName } from '@lumibase/contracts';
import type { AppEnv } from '../env';
import type { RuntimeContext } from '@lumibase/runtime';
import type { HarnessExecutionResult } from './ai-harness';
import type { McpHarnessPort } from './mcp-service';
import { AuditLogger } from '../modules/audit/logger';
import { executeOrganizationMutation, lockOrganization, organizationFail, OrganizationError,
  resolveOrganizationActorRole, type OrganizationActor, type OrganizationMutation, type OrganizationDb } from './organization-operations';
import { finalizeSiteProvisioning } from './site-provisioning';
import { invalidateSiteExists } from './domains/site-exists-cache';

export function organizationMcpEnabled(settings: unknown, env: { LUMIBASE_MCP_ORG_TOOLS?: string }): boolean {
  if (env.LUMIBASE_MCP_ORG_TOOLS === 'off') return false;
  const value = settings as { contentOs?: { mcp?: { allowOrganizationTools?: unknown } } } | null;
  return value?.contentOs?.mcp?.allowOrganizationTools === true;
}
const readActions = new Set(['get_organization', 'list_sites', 'list_org_members']);
const actorSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('user'), userId: z.string().min(1) }),
  z.strictObject({ type: z.literal('api_key'), apiKeyId: z.string().min(1) }),
]);
function canRequest(role: OrgRole | null, operation: string): boolean {
  if (!role) return false;
  if (readActions.has(operation)) return canOrg(role, 'org:read');
  // Admin keys may request owner-only actions, but can never execute/approve them.
  return role === 'owner' || role === 'admin';
}
export interface OrganizationHarnessContext {
  db: Database;
  organizationId: string;
  requester: OrganizationActor;
  env: AppEnv['Bindings'];
  runtime?: RuntimeContext;
  requestId?: string;
  actorEmail?: string;
}
export class OrganizationHarness implements McpHarnessPort {
  constructor(private readonly context: OrganizationHarnessContext) {}
  async listTools() {
    return Object.entries(OrganizationToolSchemas).map(([name, schema]) => ({
      name, description: name.replace('org:', '').replaceAll('_', ' '), inputSchema: z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>,
    }));
  }
  async execute(name: string, args: Record<string, unknown>, _capabilities: string[]): Promise<HarnessExecutionResult> {
    const { db, organizationId, requester, env } = this.context;
    const runId = uuidv7();
    try {
      if (!Object.hasOwn(OrganizationToolSchemas, name)) organizationFail('SKILL_NOT_FOUND', 404);
      const parsed = OrganizationToolSchemas[name as OrganizationToolName].safeParse(args);
      if (!parsed.success) organizationFail('VALIDATION', 400);
      const { organizationId: target, ...input } = parsed.data!;
      if (target !== organizationId) organizationFail('NOT_FOUND', 404);
      const operation = name.slice(4);
      const result = await db.transaction(async (tx) => {
        const org = await lockOrganization(tx, organizationId);
        if (!organizationMcpEnabled(org.settings, env)) organizationFail('MCP_DISABLED', 403);
        const role = await resolveOrganizationActorRole(tx, organizationId, requester);
        if (!canRequest(role, operation)) organizationFail('ORGANIZATION_FORBIDDEN', 403);
        if (readActions.has(operation)) {
          let data: unknown = { ...org, role };
          if (operation === 'list_sites') data = await tx.select().from(sites).where(eq(sites.organizationId, organizationId));
          if (operation === 'list_org_members') data = await tx.select({ userId: organizationMembers.userId,
            email: users.email, role: organizationMembers.role, createdAt: organizationMembers.createdAt })
            .from(organizationMembers).innerJoin(users, eq(users.id, organizationMembers.userId))
            .where(eq(organizationMembers.organizationId, organizationId));
          return { status: 'executed' as const, data };
        }
        // Every org write is an explicit, durable human action. confirm is not an execution grant.
        await tx.insert(aiApprovals).values({ id: runId, siteId: null, organizationId,
          organizationRequester: requester, agentName: 'lumibase-mcp', skillName: name,
          arguments: input, status: 'pending', context: 'Organization MCP operation: human approval required.' });
        return { status: 'pending_approval' as const, approvalId: runId,
          message: 'An authorized human must approve this organization operation.' };
      });
      await this.audit('organization_mcp_call', runId, { skillName: name, status: result.status, requester });
      return { ...result, organizationId, runId };
    } catch (error) {
      const code = error instanceof OrganizationError ? error.code : 'INTERNAL_ERROR';
      await this.audit('organization_mcp_denied', runId, { skillName: name, code, requester });
      return { status: 'denied', code, message: code, organizationId, runId };
    }
  }
  private async audit(event: string, runId: string, metadata: Record<string, unknown>) {
    await new AuditLogger({ db: this.context.db, siteId: null }).write({ event,
      actorEmail: this.context.actorEmail ?? null, requestId: this.context.requestId ?? null,
      metadata: { ...metadata, organizationId: this.context.organizationId, runId, via: 'organization' },
    });
  }
}

export const organizationApprovalSummary = (row: typeof aiApprovals.$inferSelect) => ({
  id: row.id, organizationId: row.organizationId, skillName: row.skillName, arguments: row.arguments,
  status: row.status, createdAt: row.createdAt, decidedAt: row.decidedAt, decidedBy: row.decidedBy,
  requester: row.organizationRequester,
});
export async function listOrganizationApprovals(db: OrganizationDb, organizationId: string) {
  return (await db.select().from(aiApprovals).where(and(eq(aiApprovals.organizationId, organizationId), isNull(aiApprovals.siteId)))
    .orderBy(desc(aiApprovals.createdAt)).limit(100)).map(organizationApprovalSummary);
}
export async function getOrganizationApproval(db: OrganizationDb, organizationId: string, approvalId: string) {
  const [row] = await db.select().from(aiApprovals).where(and(eq(aiApprovals.id, approvalId),
    eq(aiApprovals.organizationId, organizationId), isNull(aiApprovals.siteId))).limit(1);
  if (!row) organizationFail('NOT_FOUND', 404);
  return { ...organizationApprovalSummary(row!), result: redactApprovalResult(row!.result) };
}
/**
 * Drop plaintext credentials from an approval result before it is stored or
 * replayed. Also applied on read so a row written before this rule existed
 * cannot hand its secret out again.
 */
export function redactApprovalResult(result: unknown): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result) || !('token' in result)) return result;
  const { token: _token, ...rest } = result as Record<string, unknown>;
  return { ...rest, tokenRedacted: true };
}
/** Domain writes and the receipt are atomic; retries cannot mint a second key/site. */
export async function decideOrganizationApproval(input: {
  db: Database; organizationId: string; approvalId: string; decider: OrganizationActor;
  decision: 'approved' | 'rejected'; env: AppEnv['Bindings']; runtime?: RuntimeContext; requestId?: string;
}) {
  if (input.decider.type !== 'user') organizationFail('ORGANIZATION_FORBIDDEN', 403);
  let createdSiteId: string | undefined;
  let deletedSiteId: string | undefined;
  const receipt = await input.db.transaction(async (tx) => {
    const where = and(eq(aiApprovals.id, input.approvalId), eq(aiApprovals.organizationId, input.organizationId), isNull(aiApprovals.siteId));
    const [initial] = await tx.select().from(aiApprovals).where(where).limit(1);
    if (!initial) organizationFail('NOT_FOUND', 404);
    const storedArgs = initial!.arguments as Record<string, unknown>;
    const destination = input.decision === 'approved' && initial!.status === 'pending'
      && initial!.skillName === 'org:transfer_site' && typeof storedArgs.toOrganizationId === 'string'
      ? storedArgs.toOrganizationId : null;
    // Keep live parent locks ordered before the approval. A deleted destination
    // must not prevent rejection or replay of an already committed receipt.
    // Pending execution still requires both parents in executeOrganizationMutation.
    for (const id of [...new Set([input.organizationId, ...(destination ? [destination] : [])])].sort()) {
      if (id === input.organizationId) await lockOrganization(tx, id);
      else await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, id)).for('update');
    }
    const [row] = await tx.select().from(aiApprovals).where(where).for('update');
    if (!row) organizationFail('NOT_FOUND', 404);
    const role = await resolveOrganizationActorRole(tx, input.organizationId, input.decider);
    if (!role || !canOrg(role, 'org:keys:manage')) organizationFail('ORGANIZATION_FORBIDDEN', 403);
    if (row!.status !== 'pending') {
      if (row!.status !== input.decision) organizationFail('APPROVAL_ALREADY_DECIDED', 409);
      return { ...organizationApprovalSummary(row!), result: redactApprovalResult(row!.result) };
    }
    let result: unknown = null;
    if (input.decision === 'approved') {
      const [org] = await tx.select().from(organizations).where(eq(organizations.id, input.organizationId));
      if (!org || !organizationMcpEnabled(org.settings, input.env)) organizationFail('MCP_DISABLED', 403);
      const requester = actorSchema.safeParse(row!.organizationRequester);
      if (!requester.success) organizationFail('REQUESTER_REVOKED', 409);
      const operation = row!.skillName.slice(4) as OrganizationMutation;
      const requesterRole = await resolveOrganizationActorRole(tx, input.organizationId, requester.data!);
      if (!canRequest(requesterRole, operation)) organizationFail('REQUESTER_REVOKED', 409);
      if (!Object.hasOwn(OrganizationToolSchemas, row!.skillName) || readActions.has(operation)) organizationFail('VALIDATION', 400);
      const execution = await executeOrganizationMutation(tx, input.organizationId, operation, storedArgs, input.decider);
      createdSiteId = execution.createdSiteId;
      if (operation === 'delete_site' && typeof storedArgs.siteId === 'string') deletedSiteId = storedArgs.siteId;
      result = execution.data;
    }
    // The stored receipt never holds a plaintext secret: only the token hash is
    // kept for API keys, and a receipt row must not become a second copy that
    // every admin (or a backup reader) can read later. The approver sees the
    // token once, in this response, exactly like POST /orgs/:id/keys.
    const [saved] = await tx.update(aiApprovals).set({ status: input.decision, result: redactApprovalResult(result),
      decidedAt: new Date(),
      decidedBy: (input.decider as Extract<OrganizationActor, { type: 'user' }>).userId }).where(where).returning();
    return { ...organizationApprovalSummary(saved!), result };
  });
  if (createdSiteId) await finalizeSiteProvisioning(input.db, input.env, input.runtime, createdSiteId).catch(() => undefined);
  if (deletedSiteId) await invalidateSiteExists(input.runtime?.cache, deletedSiteId);
  await new AuditLogger({ db: input.db, siteId: null }).write({ event: 'organization_mcp_approval_decided',
    requestId: input.requestId ?? null, metadata: { organizationId: input.organizationId, runId: input.approvalId,
      requester: receipt.requester, decider: input.decider, decision: receipt.status, via: 'organization' } });
  return receipt;
}
