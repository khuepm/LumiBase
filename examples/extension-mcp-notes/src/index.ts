import { defineMcp, defineTool } from '@lumibase/extension-sdk';

/**
 * Sandbox context the host passes to the module factory. Item access is
 * actor-scoped (the caller's own row/field permissions) and capability-checked
 * against what the admin granted on install (`items:read:notes`, …).
 */
interface Ctx {
  items: {
    list(collection: string, params?: Record<string, unknown>): Promise<unknown>;
    create(collection: string, payload: { data: Record<string, unknown> }): Promise<unknown>;
  };
}

export default (ctx: Ctx) => ({
  mcp: defineMcp({
    tools: [
      defineTool<{ itemId: string }>({
        name: 'countNotes',
        description: 'Count the notes on an item.',
        capability: 'items:read',
        riskClass: 'read_only',
        inputSchema: { type: 'object', properties: { itemId: { type: 'string', maxLength: 64 } }, required: ['itemId'] },
        handler: async ({ itemId }) => {
          const notes = (await ctx.items.list('notes', { filter: { item: { _eq: itemId } } })) as { data?: unknown[] };
          return { itemId, count: notes.data?.length ?? 0 };
        },
      }),
      defineTool<{ itemId: string; text: string }>({
        name: 'appendNote',
        description: 'Append an editorial note to an item.',
        capability: 'items:write',
        riskClass: 'low',
        inputSchema: {
          type: 'object',
          properties: { itemId: { type: 'string', maxLength: 64 }, text: { type: 'string', maxLength: 2000 } },
          required: ['itemId', 'text'],
        },
        handler: async ({ itemId, text }) => ctx.items.create('notes', { data: { item: itemId, text } }),
      }),
      defineTool<{ field: string }>({
        name: 'addNotesField',
        description: 'Add a field to the notes collection. Always needs a human approval (schema:write).',
        capability: 'schema:write',
        riskClass: 'medium',
        inputSchema: { type: 'object', properties: { field: { type: 'string', maxLength: 64 } }, required: ['field'] },
        // Reached only after a signed-in human approved the call.
        handler: async ({ field }) => ({ planned: { collection: 'notes', field } }),
      }),
    ],
  }),
});
