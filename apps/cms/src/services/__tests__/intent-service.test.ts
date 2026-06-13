import { describe, expect, it } from 'vitest';
import type { Database } from '@lumibase/database';
import { IntentService, IntentServiceError, intentInputSchema } from '../intent-service';
import type { ConfiguredLLM } from '../llm-provider';

/**
 * Feature: content-os, Requirement 5 — content intents (SLO).
 * Covers intent-rule.v1 validation (Req 5.4) and natural-language
 * compilation returning a confirmable draft without persisting (Req 5.3).
 */

const validIntent = {
  name: 'product-quality',
  collection: 'products',
  rules: [
    { type: 'required_fields', fields: ['title', 'description'] },
    { type: 'freshness', maxAgeDays: 30 },
    { type: 'translations', locales: ['vi', 'en'] },
  ],
  schedule: '0 6 * * *',
};

describe('intentInputSchema (intent-rule.v1)', () => {
  it('accepts a valid intent and applies defaults', () => {
    const parsed = intentInputSchema.parse(validIntent);
    expect(parsed.autonomyCap).toBe(2);
    expect(parsed.budget).toEqual({ maxGoalsPerCycle: 10, maxWritesPerMinute: 60, maxCostUsd: 1 });
  });

  it('rejects unknown rule types', () => {
    const result = intentInputSchema.safeParse({
      ...validIntent,
      rules: [{ type: 'make_it_pop', strength: 11 }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid cron schedules', () => {
    const result = intentInputSchema.safeParse({ ...validIntent, schedule: 'whenever' });
    expect(result.success).toBe(false);
  });

  it('rejects autonomyCap outside 0-4', () => {
    const result = intentInputSchema.safeParse({ ...validIntent, autonomyCap: 5 });
    expect(result.success).toBe(false);
  });

  it('rejects malformed maintenance windows', () => {
    const result = intentInputSchema.safeParse({
      ...validIntent,
      maintenanceWindow: { tz: 'UTC', windows: [{ dow: 8, start: '06:00', end: '07:00' }] },
    });
    expect(result.success).toBe(false);
  });
});

function makeService(llm: ConfiguredLLM | null) {
  return new IntentService({ db: {} as Database, siteId: 'site_1', llm });
}

function fakeLLM(reply: string): ConfiguredLLM {
  return {
    name: 'fake',
    model: 'fake-model-1',
    provider: { chat: async () => ({ content: reply, toolCalls: [] }) },
  };
}

describe('IntentService.compile', () => {
  it('fails with LLM_NOT_CONFIGURED when no provider is available', async () => {
    await expect(makeService(null).compile('keep products fresh', 'products')).rejects.toMatchObject({
      code: 'LLM_NOT_CONFIGURED',
    });
  });

  it('returns validated rules and keeps a valid schedule', async () => {
    const service = makeService(
      fakeLLM(
        JSON.stringify({
          rules: [
            { type: 'freshness', maxAgeDays: 14 },
            { type: 'bogus_rule', nope: true },
          ],
          schedule: '30 2 * * 1',
        }),
      ),
    );
    const draft = await service.compile('refresh products every two weeks', 'products');
    expect(draft.rules).toEqual([{ type: 'freshness', maxAgeDays: 14 }]);
    expect(draft.schedule).toBe('30 2 * * 1');
    // Invalid rules are dropped with a warning, not silently ignored.
    expect(draft.warnings.some((w) => w.includes('bogus_rule'))).toBe(true);
  });

  it('defaults the schedule when the model omits or mangles it', async () => {
    const service = makeService(
      fakeLLM(JSON.stringify({ rules: [{ type: 'link_health' }], schedule: 'sometimes' })),
    );
    const draft = await service.compile('no broken links', 'posts');
    expect(draft.schedule).toBe('0 6 * * *');
    expect(draft.warnings.some((w) => w.includes('Schedule'))).toBe(true);
  });

  it('fails with COMPILE_EMPTY when no rule survives validation', async () => {
    const service = makeService(fakeLLM(JSON.stringify({ rules: [{ type: 'nope' }] })));
    await expect(service.compile('gibberish', 'posts')).rejects.toMatchObject({ code: 'COMPILE_EMPTY' });
  });

  it('surfaces provider errors with an explicit code', async () => {
    const failing: ConfiguredLLM = {
      name: 'fake',
      model: 'fake-model-1',
      provider: {
        chat: async () => {
          throw new Error('boom');
        },
      },
    };
    await expect(makeService(failing).compile('x', 'y')).rejects.toBeInstanceOf(IntentServiceError);
  });
});
