import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { LumiBaseClient } from '../client.js';
import { confirmDescription, okText, run } from './_shared.js';
import { encodePathSegment, idPathSegmentSchema } from './path.js';

const relationInputSchema = {
  manyCollection: z.string().min(1).describe('Collection that holds the foreign key (the "many" side).'),
  manyField: z.string().min(1).describe('Field on manyCollection that stores the relation.'),
  oneCollection: z.string().min(1).describe('Related collection (the "one" side).'),
  oneField: z.string().nullable().optional(),
  junctionCollection: z.string().nullable().optional().describe('Junction table for m2m relations.'),
  type: z.enum(['m2o', 'o2m', 'm2m', 'm2a']).optional(),
  aliasField: z.string().nullable().optional(),
  relatedDisplayTemplate: z.string().nullable().optional(),
  junctionManyField: z.string().nullable().optional(),
  junctionOneField: z.string().nullable().optional(),
  sortField: z.string().nullable().optional(),
  onDelete: z.enum(['restrict', 'cascade', 'set null', 'no action']).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
};

export function registerRelationTools(server: McpServer, client: LumiBaseClient) {
  server.registerTool(
    'list_relations',
    { description: 'List all relations configured in the schema.', inputSchema: {} },
    async () => run(() => client.get<unknown>('/relations')),
  );

  server.registerTool(
    'create_relation',
    {
      description:
        'Create a relation between two collections (m2o, o2m, m2m, or m2a). ' +
        'Schema-changing operation.',
      inputSchema: relationInputSchema,
    },
    async (input) => run(() => client.post<unknown>('/relations', input)),
  );

  server.registerTool(
    'delete_relation',
    {
      description: 'Delete a relation by id. DESTRUCTIVE — warn the user first and pass confirm=true.',
      inputSchema: {
        id: idPathSegmentSchema,
        confirm: z.literal(true).describe(confirmDescription),
      },
    },
    async ({ id }) =>
      run(async () => {
        await client.delete(`/relations/${encodePathSegment(id)}`);
        return okText(`Relation "${id}" deleted.`);
      }),
  );
}
