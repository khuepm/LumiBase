import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { LumiBaseClient } from '../client.js';
import { confirmDescription, okText, run } from './_shared.js';

export function registerApiKeyTools(server: McpServer, client: LumiBaseClient) {
  server.registerTool(
    'list_api_keys',
    { description: 'List API keys for the site (token values are never returned).', inputSchema: {} },
    async () => run(() => client.get<unknown>('/api-keys')),
  );

  server.registerTool(
    'get_api_key',
    { description: 'Get a single API key by id.', inputSchema: { id: z.string().min(1) } },
    async ({ id }) => run(() => client.get<unknown>(`/api-keys/${id}`)),
  );

  server.registerTool(
    'create_api_key',
    {
      description:
        'Create a new API key. The plaintext token is returned ONCE in the response — surface it ' +
        'to the user and tell them it cannot be retrieved again.',
      inputSchema: {
        name: z.string().min(1).max(96),
        description: z.string().max(512).optional(),
        expiresAt: z.string().datetime().nullable().optional(),
        metadata: z.record(z.unknown()).optional(),
      },
    },
    async (input) => run(() => client.post<unknown>('/api-keys', input)),
  );

  server.registerTool(
    'rotate_api_key',
    {
      description:
        'Rotate an API key — issues a new token (returned once) and invalidates the old one. ' +
        'DESTRUCTIVE for existing integrations — pass confirm=true.',
      inputSchema: {
        id: z.string().min(1),
        expiresAt: z.string().datetime().nullable().optional(),
        confirm: z.literal(true).describe(confirmDescription),
      },
    },
    async ({ id, expiresAt }) =>
      run(() => client.post<unknown>(`/api-keys/${id}/rotate`, expiresAt !== undefined ? { expiresAt } : {})),
  );

  server.registerTool(
    'revoke_api_key',
    {
      description: 'Revoke an API key permanently. DESTRUCTIVE — pass confirm=true.',
      inputSchema: { id: z.string().min(1), confirm: z.literal(true).describe(confirmDescription) },
    },
    async ({ id }) => run(() => client.post<unknown>(`/api-keys/${id}/revoke`, {})),
  );

  server.registerTool(
    'attach_api_key_role',
    {
      description: 'Attach a role to an API key (grants the role’s policies to the key).',
      inputSchema: {
        id: z.string().min(1).describe('API key id.'),
        roleId: z.string().min(1),
        priority: z.number().int().optional(),
        overrideWarnings: z.boolean().optional(),
      },
    },
    async ({ id, ...body }) => run(() => client.post<unknown>(`/api-keys/${id}/roles`, body)),
  );

  server.registerTool(
    'detach_api_key_role',
    {
      description: 'Detach a role from an API key. DESTRUCTIVE — pass confirm=true.',
      inputSchema: {
        id: z.string().min(1).describe('API key id.'),
        roleId: z.string().min(1),
        confirm: z.literal(true).describe(confirmDescription),
      },
    },
    async ({ id, roleId }) =>
      run(async () => {
        await client.delete(`/api-keys/${id}/roles/${roleId}`);
        return okText(`Role "${roleId}" detached from API key "${id}".`);
      }),
  );

  server.registerTool(
    'attach_api_key_policy',
    {
      description: 'Attach a policy directly to an API key.',
      inputSchema: {
        id: z.string().min(1).describe('API key id.'),
        policyId: z.string().min(1),
        priority: z.number().int().optional(),
        overrideWarnings: z.boolean().optional(),
      },
    },
    async ({ id, ...body }) => run(() => client.post<unknown>(`/api-keys/${id}/policies`, body)),
  );

  server.registerTool(
    'detach_api_key_policy',
    {
      description: 'Detach a policy from an API key. DESTRUCTIVE — pass confirm=true.',
      inputSchema: {
        id: z.string().min(1).describe('API key id.'),
        policyId: z.string().min(1),
        confirm: z.literal(true).describe(confirmDescription),
      },
    },
    async ({ id, policyId }) =>
      run(async () => {
        await client.delete(`/api-keys/${id}/policies/${policyId}`);
        return okText(`Policy "${policyId}" detached from API key "${id}".`);
      }),
  );
}
