import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { LumiBaseClient } from '../client.js';
import { run } from './_shared.js';
import { dispatchOrganizationTool } from '../governed.js';

/** A pin restricts the advertised org surface to these two read operations. */
export function registerOrganizationTools(server: McpServer, client: LumiBaseClient, pinned: boolean) {
  const register = (name: string, description: string, inputSchema: Record<string, z.ZodType>, write = false) => {
    server.registerTool(name, { description, inputSchema,
      annotations: { readOnlyHint: !write, destructiveHint: write } }, async (args) => run(async () => {
      const rows = await client.get<Array<{ id: string }>>('/orgs');
      if (rows.length !== 1) throw new Error('The organization key must resolve to one organization');
      const arguments_: Record<string, unknown> = { organizationId: rows[0]!.id };
      for (const [key, value] of Object.entries(args)) {
        if (key === 'confirm' || value === undefined) continue;
        arguments_[key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = value;
      }
      return dispatchOrganizationTool(client, `org:${name}`, arguments_);
    }));
  };
  register('get_organization', 'Read the organization bound to this credential.', {});
  register('list_sites', 'List sites belonging to this organization.', {});
  if (pinned) return;
  const confirm = z.boolean().optional().describe('Acknowledgement only; human approval is still required.');
  const id = z.string().min(1).max(64);
  register('create_site', 'Request human approval to provision a site.', {
    name: z.string().min(1).max(255), id: id.optional(), slug: id.optional(), confirm,
  }, true);
  register('delete_site', 'Request a human owner to approve deleting a site.', { site_id: id, confirm }, true);
  register('transfer_site', 'Request approval from an owner of both source and destination organizations.', {
    site_id: id, to_organization_id: id, confirm,
  }, true);
  register('list_org_members', 'List organization members.', {});
  register('invite_org_member', 'Request human approval to add or update an organization member.', {
    user_id: id.optional(), email: z.email().optional(), role: z.enum(['owner', 'admin', 'billing', 'member']).default('member'), confirm,
  }, true);
  register('create_org_key', 'Request an organization key. The plaintext is available only to a human in the approval receipt.', {
    name: z.string().min(1).max(255), description: z.string().max(2000).optional(), expires_at: z.iso.datetime().optional(), confirm,
  }, true);
}
