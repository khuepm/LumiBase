import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { LumiBaseClient } from '../client.js';
import { registerCrud } from './_crud.js';
import { confirmDescription, okText, run } from './_shared.js';
import { encodePathSegment, idPathSegmentSchema } from './path.js';

const roleSchema = z.object({
  key: z.string().min(1).max(96).optional(),
  systemKey: z.string().min(1).max(96).optional(),
  name: z.string().min(1).max(64),
  description: z.string().max(512).optional(),
  icon: z.string().max(64).optional(),
  parentId: z.string().nullable().optional(),
  adminAccess: z.boolean().optional(),
  appAccess: z.boolean().optional(),
});

const policySchema = z.object({
  key: z.string().min(1).max(96).optional(),
  name: z.string().min(1).max(64),
  icon: z.string().max(64).optional(),
  description: z.string().max(512).optional(),
  adminAccess: z.boolean().optional(),
  appAccess: z.boolean().optional(),
  enforceTfa: z.boolean().optional(),
  ipAllow: z.array(z.string()).optional(),
  ipDeny: z.array(z.string()).optional(),
  validFrom: z.string().datetime().nullable().optional(),
  validUntil: z.string().datetime().nullable().optional(),
  rules: z.record(z.string(), z.unknown()).optional(),
});

const permissionSchema = z.object({
  collection: z.string().min(1).max(64),
  action: z.enum(['create', 'read', 'update', 'delete', 'share']),
  permissions: z.record(z.string(), z.unknown()).optional(),
  validation: z.record(z.string(), z.unknown()).optional(),
  presets: z.record(z.string(), z.unknown()).optional(),
  fields: z.array(z.string()).optional(),
});

export function registerAccessTools(server: McpServer, client: LumiBaseClient) {
  // ── Roles ─────────────────────────────────────────────────────────────────
  registerCrud(server, client, {
    basePath: '/roles',
    resource: 'role',
    namePrefix: 'role',
    createSchema: roleSchema.shape,
    updateSchema: roleSchema.partial().shape,
  });

  server.registerTool(
    'attach_role_policy',
    {
      description: 'Attach a policy to a role. Conflicts/warnings may require overrideWarnings=true.',
      inputSchema: {
        id: idPathSegmentSchema.describe('Role id.'),
        policyId: idPathSegmentSchema,
        priority: z.number().int().optional(),
        overrideWarnings: z.boolean().optional(),
      },
    },
    async ({ id, ...body }) => run(() => client.post<unknown>(`/roles/${encodePathSegment(id)}/policies`, body)),
  );

  server.registerTool(
    'detach_role_policy',
    {
      description: 'Detach a policy from a role. DESTRUCTIVE — pass confirm=true.',
      inputSchema: {
        id: idPathSegmentSchema.describe('Role id.'),
        policyId: idPathSegmentSchema,
        confirm: z.literal(true).describe(confirmDescription),
      },
    },
    async ({ id, policyId }) =>
      run(async () => {
        await client.delete(`/roles/${encodePathSegment(id)}/policies/${encodePathSegment(policyId)}`);
        return okText(`Policy "${policyId}" detached from role "${id}".`);
      }),
  );

  server.registerTool(
    'assign_role_user',
    {
      description: "Assign a role to a user (sets the user's primary role for this site).",
      inputSchema: { id: idPathSegmentSchema.describe('Role id.'), userId: idPathSegmentSchema },
    },
    async ({ id, userId }) => run(() => client.post<unknown>(`/roles/${encodePathSegment(id)}/users`, { userId })),
  );

  server.registerTool(
    'remove_role_user',
    {
      description: "Remove a user's role assignment. DESTRUCTIVE — pass confirm=true.",
      inputSchema: {
        id: idPathSegmentSchema.describe('Role id.'),
        userId: idPathSegmentSchema,
        confirm: z.literal(true).describe(confirmDescription),
      },
    },
    async ({ id, userId }) =>
      run(async () => {
        await client.delete(`/roles/${encodePathSegment(id)}/users/${encodePathSegment(userId)}`);
        return okText(`User "${userId}" removed from role "${id}".`);
      }),
  );

  // ── Policies ──────────────────────────────────────────────────────────────
  registerCrud(server, client, {
    basePath: '/policies',
    resource: 'policy',
    namePrefix: 'policy',
    listName: 'list_policies',
    createSchema: policySchema.shape,
    updateSchema: policySchema.partial().shape,
  });

  server.registerTool(
    'add_policy_permission',
    {
      description: 'Add a permission row (collection + action) to a policy.',
      inputSchema: { id: idPathSegmentSchema.describe('Policy id.'), ...permissionSchema.shape },
    },
    async ({ id, ...body }) => run(() => client.post<unknown>(`/policies/${encodePathSegment(id)}/permissions`, body)),
  );

  server.registerTool(
    'update_policy_permission',
    {
      description: 'Update a permission row on a policy (partial PATCH).',
      inputSchema: {
        id: idPathSegmentSchema.describe('Policy id.'),
        permId: idPathSegmentSchema.describe('Permission row id.'),
        ...permissionSchema.partial().shape,
      },
    },
    async ({ id, permId, ...body }) =>
      run(() => client.patch<unknown>(`/policies/${encodePathSegment(id)}/permissions/${encodePathSegment(permId)}`, body)),
  );

  server.registerTool(
    'delete_policy_permission',
    {
      description: 'Delete a permission row from a policy. DESTRUCTIVE — pass confirm=true.',
      inputSchema: {
        id: idPathSegmentSchema.describe('Policy id.'),
        permId: idPathSegmentSchema.describe('Permission row id.'),
        confirm: z.literal(true).describe(confirmDescription),
      },
    },
    async ({ id, permId }) =>
      run(async () => {
        await client.delete(`/policies/${encodePathSegment(id)}/permissions/${encodePathSegment(permId)}`);
        return okText(`Permission "${permId}" deleted from policy "${id}".`);
      }),
  );

  server.registerTool(
    'attach_policy_user',
    {
      description: 'Attach a policy directly to a user. Warnings may require overrideWarnings=true.',
      inputSchema: {
        id: idPathSegmentSchema.describe('Policy id.'),
        userId: idPathSegmentSchema,
        priority: z.number().int().optional(),
        overrideWarnings: z.boolean().optional(),
      },
    },
    async ({ id, ...body }) => run(() => client.post<unknown>(`/policies/${encodePathSegment(id)}/users`, body)),
  );

  server.registerTool(
    'detach_policy_user',
    {
      description: 'Detach a policy from a user. DESTRUCTIVE — pass confirm=true.',
      inputSchema: {
        id: idPathSegmentSchema.describe('Policy id.'),
        userId: idPathSegmentSchema,
        confirm: z.literal(true).describe(confirmDescription),
      },
    },
    async ({ id, userId }) =>
      run(async () => {
        await client.delete(`/policies/${encodePathSegment(id)}/users/${encodePathSegment(userId)}`);
        return okText(`Policy "${id}" detached from user "${userId}".`);
      }),
  );

  // ── Bulk RBAC export / import / conflict checks ────────────────────────────
  server.registerTool(
    'export_access',
    { description: 'Export the full RBAC manifest (roles, policies, permissions, bindings).', inputSchema: {} },
    async () => run(() => client.get<unknown>('/access/export')),
  );

  server.registerTool(
    'dry_run_access_import',
    {
      description: 'Validate an RBAC manifest import without applying it. Returns the planned changes.',
      inputSchema: { manifest: z.record(z.string(), z.unknown()).describe('RBAC manifest from export_access.') },
    },
    async ({ manifest }) => run(() => client.post<unknown>('/access/import?dryRun=true', manifest)),
  );

  server.registerTool(
    'apply_access_import',
    {
      description:
        'Apply an RBAC manifest import. High-impact — changes roles/policies/permissions. Pass confirm=true.',
      inputSchema: {
        manifest: z.record(z.string(), z.unknown()).describe('RBAC manifest from export_access.'),
        mode: z.enum(['merge', 'replace-managed', 'replace-all']).optional().describe('Import mode (default merge).'),
        confirm: z.literal(true).describe(confirmDescription),
      },
    },
    async ({ manifest, mode }) =>
      run(() => client.post<unknown>(`/access/import${mode ? `?mode=${mode}` : ''}`, manifest)),
  );

  server.registerTool(
    'check_access_conflicts',
    {
      description: 'Check for permission conflicts before attaching/detaching policies on a target.',
      inputSchema: {
        target: z
          .object({ type: z.enum(['role', 'user', 'api_key']), id: z.string().min(1) })
          .describe('The role/user/api_key the policies would apply to.'),
        addPolicies: z.array(z.string()).optional(),
        removePolicies: z.array(z.string()).optional(),
      },
    },
    async (input) => run(() => client.post<unknown>('/access/conflicts/check', input)),
  );
}
