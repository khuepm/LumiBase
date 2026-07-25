import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { LumiBaseClient } from '../client.js';
import { confirmDescription, okText, run } from './_shared.js';
import { encodePathSegment, idPathSegmentSchema } from './path.js';

export function registerUsersTeamsTools(server: McpServer, client: LumiBaseClient) {
  // ── Users ─────────────────────────────────────────────────────────────────
  server.registerTool(
    'list_users',
    { description: 'List users belonging to the active site.', inputSchema: {} },
    async () => run(() => client.get<unknown>('/users')),
  );

  server.registerTool(
    'get_user',
    { description: 'Get a single user in the active site by id.', inputSchema: { id: idPathSegmentSchema } },
    async ({ id }) => run(() => client.get<unknown>(`/users/${encodePathSegment(id)}`)),
  );

  server.registerTool(
    'invite_user',
    {
      description: 'Invite a user to the site by email, optionally assigning a role. Sends an invite email.',
      inputSchema: {
        email: z.string().email(),
        roleId: z.string().optional(),
      },
    },
    async (input) => run(() => client.post<unknown>('/users/invite', input)),
  );

  server.registerTool(
    'update_user',
    {
      description: "Update a user's site membership (role and/or status).",
      inputSchema: {
        id: idPathSegmentSchema,
        roleId: z.string().nullable().optional(),
        status: z.string().optional().describe('e.g. active, suspended.'),
      },
    },
    async ({ id, ...patch }) => run(() => client.patch<unknown>(`/users/${encodePathSegment(id)}`, patch)),
  );

  server.registerTool(
    'remove_user',
    {
      description: 'Remove a user from the site. DESTRUCTIVE — pass confirm=true.',
      inputSchema: { id: idPathSegmentSchema, confirm: z.literal(true).describe(confirmDescription) },
    },
    async ({ id }) =>
      run(async () => {
        await client.delete(`/users/${encodePathSegment(id)}`);
        return okText(`User "${id}" removed from the site.`);
      }),
  );

  // ── Teams ─────────────────────────────────────────────────────────────────
  server.registerTool(
    'list_teams',
    { description: 'List teams in the active site.', inputSchema: {} },
    async () => run(() => client.get<unknown>('/teams')),
  );

  server.registerTool(
    'get_team',
    { description: 'Get a single team by id.', inputSchema: { id: idPathSegmentSchema } },
    async ({ id }) => run(() => client.get<unknown>(`/teams/${encodePathSegment(id)}`)),
  );

  server.registerTool(
    'create_team',
    {
      description: 'Create a team.',
      inputSchema: { name: z.string().min(1).max(128), description: z.string().nullable().optional() },
    },
    async (input) => run(() => client.post<unknown>('/teams', input)),
  );

  server.registerTool(
    'update_team',
    {
      description: 'Update a team (partial PATCH).',
      inputSchema: {
        id: idPathSegmentSchema,
        name: z.string().min(1).max(128).optional(),
        description: z.string().nullable().optional(),
      },
    },
    async ({ id, ...patch }) => run(() => client.patch<unknown>(`/teams/${encodePathSegment(id)}`, patch)),
  );

  server.registerTool(
    'delete_team',
    {
      description: 'Delete a team. DESTRUCTIVE — pass confirm=true.',
      inputSchema: { id: idPathSegmentSchema, confirm: z.literal(true).describe(confirmDescription) },
    },
    async ({ id }) =>
      run(async () => {
        await client.delete(`/teams/${encodePathSegment(id)}`);
        return okText(`Team "${id}" deleted.`);
      }),
  );

  server.registerTool(
    'list_team_members',
    { description: 'List members of a team.', inputSchema: { id: idPathSegmentSchema.describe('Team id.') } },
    async ({ id }) => run(() => client.get<unknown>(`/teams/${encodePathSegment(id)}/members`)),
  );

  server.registerTool(
    'add_team_member',
    {
      description: 'Add a user to a team.',
      inputSchema: { id: idPathSegmentSchema.describe('Team id.'), userId: idPathSegmentSchema },
    },
    async ({ id, userId }) => run(() => client.post<unknown>(`/teams/${encodePathSegment(id)}/members`, { userId })),
  );

  server.registerTool(
    'remove_team_member',
    {
      description: 'Remove a user from a team. DESTRUCTIVE — pass confirm=true.',
      inputSchema: {
        id: idPathSegmentSchema.describe('Team id.'),
        userId: idPathSegmentSchema,
        confirm: z.literal(true).describe(confirmDescription),
      },
    },
    async ({ id, userId }) =>
      run(async () => {
        await client.delete(`/teams/${encodePathSegment(id)}/members/${encodePathSegment(userId)}`);
        return okText(`User "${userId}" removed from team "${id}".`);
      }),
  );
}
