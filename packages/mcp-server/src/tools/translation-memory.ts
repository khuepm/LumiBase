import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { LumiBaseClient } from '../client.js';
import { buildQs, confirmDescription, okText, run } from './_shared.js';
import { encodePathSegment, idPathSegmentSchema } from './path.js';

export function registerTranslationMemoryTools(server: McpServer, client: LumiBaseClient) {
  server.registerTool(
    'list_tm',
    {
      description: 'List translation-memory entries, optionally filtered by source/target language.',
      inputSchema: {
        source: z.string().optional().describe('Source language code.'),
        target: z.string().optional().describe('Target language code.'),
      },
    },
    async (args) =>
      run(() =>
        client.get<unknown>(`/tm${buildQs(args as Record<string, string | number | boolean | undefined>)}`),
      ),
  );

  server.registerTool(
    'upsert_tm',
    {
      description: 'Add or update a translation-memory entry.',
      inputSchema: {
        sourceLang: z.string().min(2),
        targetLang: z.string().min(2),
        sourceText: z.string().min(1),
        targetText: z.string().min(1),
        context: z.string().optional(),
        quality: z.number().min(0).max(100).optional(),
        source: z.enum(['human', 'mt', 'imported']).optional(),
        provider: z.string().optional(),
      },
    },
    async (input) => run(() => client.post<unknown>('/tm', input)),
  );

  server.registerTool(
    'lookup_tm',
    {
      description: 'Fuzzy-match a query string against translation memory for a language pair.',
      inputSchema: {
        query: z.string().min(1),
        sourceLang: z.string().min(2),
        targetLang: z.string().min(2),
        threshold: z.number().min(0).max(100).optional().describe('Minimum match score (default 75).'),
      },
    },
    async (input) => run(() => client.post<unknown>('/tm/lookup', input)),
  );

  server.registerTool(
    'translate_text',
    {
      description: 'Run the full translation pipeline (TM + glossary + MT provider) for a text.',
      inputSchema: {
        text: z.string().min(1),
        from: z.string().min(2),
        to: z.string().min(2),
        provider: z.string().optional(),
      },
    },
    async (input) => run(() => client.post<unknown>('/tm/translate', input)),
  );

  server.registerTool(
    'update_tm',
    {
      description: 'Edit an existing translation-memory entry (partial PATCH).',
      inputSchema: {
        id: idPathSegmentSchema,
        targetText: z.string().min(1).optional(),
        quality: z.number().min(0).max(100).optional(),
        context: z.string().nullable().optional(),
        source: z.enum(['human', 'mt', 'imported']).optional(),
      },
    },
    async ({ id, ...patch }) =>
      run(() => client.patch<unknown>(`/tm/${encodePathSegment(id)}`, patch)),
  );

  server.registerTool(
    'delete_tm',
    {
      description: 'Delete a translation-memory entry. DESTRUCTIVE — warn the user first and pass confirm=true.',
      inputSchema: {
        id: idPathSegmentSchema,
        confirm: z.literal(true).describe(confirmDescription),
      },
    },
    async ({ id }) =>
      run(async () => {
        await client.delete(`/tm/${encodePathSegment(id)}`);
        return okText(`Translation-memory entry "${id}" deleted.`);
      }),
  );
}
