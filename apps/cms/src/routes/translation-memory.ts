/**
 * Translation Memory routes — POST-GA1.
 *
 *   GET  /api/v1/tm           List/search TM entries
 *   POST /api/v1/tm           Upsert a TM entry (learn from a translation)
 *   POST /api/v1/tm/lookup    Find fuzzy matches for a source string
 *   POST /api/v1/tm/translate Run the MT pipeline (TM → glossary → provider)
 *
 * The MT provider registry is wired with stub implementations by default.
 * Real production deployments should replace them with proper API clients.
 */

import { glossary, translationMemory } from '@lumibase/database';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import {
  DeepLProvider,
  OpenAiProvider,
  TranslationMemoryService,
  WorkersAiProvider,
  bestMatch,
} from '../services/translation-memory';
import type { MtProvider, TmEntry } from '../services/translation-memory';

export const tmRouter = new Hono<AppEnv>();

// ── helpers ────────────────────────────────────────────────────────────────

function buildProviders(env: AppEnv['Bindings']): Map<string, MtProvider> {
  const map = new Map<string, MtProvider>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = env as any;
  if (e.DEEPL_API_KEY) map.set('deepl', new DeepLProvider(e.DEEPL_API_KEY));
  if (e.OPENAI_API_KEY) map.set('openai', new OpenAiProvider(e.OPENAI_API_KEY));
  if (e.AI) map.set('workers-ai', new WorkersAiProvider(e.AI));

  // Always provide a fallback echo provider so devs can exercise the route.
  if (map.size === 0) {
    map.set('echo', {
      name: 'echo',
      translate: async ({ text, to }) => `[echo:${to}] ${text}`,
    });
  }

  return map;
}

// ── GET /tm ────────────────────────────────────────────────────────────────

tmRouter.get('/', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');

  const sourceLang = c.req.query('source');
  const targetLang = c.req.query('target');

  const conds = [eq(translationMemory.siteId, siteId)];
  if (sourceLang) conds.push(eq(translationMemory.sourceLang, sourceLang));
  if (targetLang) conds.push(eq(translationMemory.targetLang, targetLang));

  const rows = await db
    .select()
    .from(translationMemory)
    .where(and(...conds))
    .limit(200);

  return c.json({ data: rows });
});

// ── POST /tm  (upsert entry) ───────────────────────────────────────────────

const upsertSchema = z.object({
  sourceLang: z.string().min(2),
  targetLang: z.string().min(2),
  sourceText: z.string().min(1),
  targetText: z.string().min(1),
  context: z.string().optional(),
  quality: z.number().min(0).max(100).optional(),
  source: z.enum(['human', 'mt', 'imported']).default('human'),
  provider: z.string().optional(),
});

tmRouter.post('/', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');

  const parsed = upsertSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      { errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) },
      400,
    );
  }

  const inserted = await db
    .insert(translationMemory)
    .values({ siteId, ...parsed.data })
    .returning();

  return c.json({ data: inserted[0] }, 201);
});

// ── POST /tm/lookup  (fuzzy match) ─────────────────────────────────────────

const lookupSchema = z.object({
  query: z.string().min(1),
  sourceLang: z.string().min(2),
  targetLang: z.string().min(2),
  threshold: z.number().min(0).max(100).optional(),
});

tmRouter.post('/lookup', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');

  const parsed = lookupSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      { errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) },
      400,
    );
  }

  const rows = await db
    .select()
    .from(translationMemory)
    .where(
      and(
        eq(translationMemory.siteId, siteId),
        eq(translationMemory.sourceLang, parsed.data.sourceLang),
        eq(translationMemory.targetLang, parsed.data.targetLang),
      ),
    );

  const candidates: TmEntry[] = rows.map((r) => ({
    id: r.id,
    sourceText: r.sourceText,
    targetText: r.targetText,
    quality: r.quality,
    context: r.context,
  }));

  const match = bestMatch(parsed.data.query, candidates, parsed.data.threshold ?? 75);
  return c.json({ data: { match } });
});

// ── POST /tm/translate  (full pipeline) ────────────────────────────────────

const translateSchema = z.object({
  text: z.string().min(1),
  from: z.string().min(2),
  to: z.string().min(2),
  provider: z.string().optional(),
});

tmRouter.post('/translate', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');

  const parsed = translateSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      { errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) },
      400,
    );
  }

  // Load TM + glossary for the language pair.
  const [tmRows, glossaryRows] = await Promise.all([
    db
      .select()
      .from(translationMemory)
      .where(
        and(
          eq(translationMemory.siteId, siteId),
          eq(translationMemory.sourceLang, parsed.data.from),
          eq(translationMemory.targetLang, parsed.data.to),
        ),
      ),
    db
      .select()
      .from(glossary)
      .where(
        and(
          eq(glossary.siteId, siteId),
          eq(glossary.sourceLang, parsed.data.from),
          eq(glossary.targetLang, parsed.data.to),
        ),
      ),
  ]);

  const providers = buildProviders(c.env);
  const service = new TranslationMemoryService(providers, {
    defaultProvider: providers.has('workers-ai') ? 'workers-ai' : 'echo',
    tmThreshold: 80,
  });

  const result = await service.translate({
    text: parsed.data.text,
    from: parsed.data.from,
    to: parsed.data.to,
    provider: parsed.data.provider,
    tm: tmRows.map((r) => ({
      id: r.id,
      sourceText: r.sourceText,
      targetText: r.targetText,
      quality: r.quality,
      context: r.context,
    })),
    glossary: glossaryRows.map((g) => ({
      term: g.term,
      translation: g.translation,
      rule: g.rule as 'do-not-translate' | 'prefer' | 'forbidden',
    })),
  });

  return c.json({ data: result });
});
