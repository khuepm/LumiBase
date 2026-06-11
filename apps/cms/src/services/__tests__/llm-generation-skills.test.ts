import { describe, expect, it } from 'vitest';
import type { Database } from '@lumibase/database';
import { AISecureHarness, extractJson } from '../ai-harness';
import type { ItemService } from '../item-service';
import type { SchemaService } from '../schema-service';
import type { ConfiguredLLM, LLMMessage } from '../llm-provider';

/**
 * Feature: content-os, Requirement 2 — real LLM execution for generation
 * skills. Verifies:
 * - llm: null (environment resolved, no provider) → explicit
 *   LLM_NOT_CONFIGURED error, no silent stub fallback (Req 2.2).
 * - configured provider → real generation path with usage meta (Req 2.1, 2.3).
 * - provider failures surface as LLM_PROVIDER_ERROR (Req 2.2).
 */

function fakeItemService(samples: unknown[] = []): ItemService {
  return {
    setProvenance: () => {},
    list: async () => ({ data: samples, meta: { total: samples.length, limit: 3, offset: 0 } }),
  } as unknown as ItemService;
}

function fakeSchemaService(fieldsByCollection: Record<string, Array<{ name: string; type: string }>>): SchemaService {
  return {
    listCollections: async () => Object.keys(fieldsByCollection).map((name) => ({ name })),
    listFields: async (name: string) => {
      const fields = fieldsByCollection[name];
      if (!fields) throw new Error('NOT_FOUND');
      return fields;
    },
  } as unknown as SchemaService;
}

function fakeLLM(reply: string | (() => string)): ConfiguredLLM {
  return {
    name: 'fake',
    model: 'fake-model-1',
    provider: {
      chat: async (_messages: LLMMessage[]) => ({
        content: typeof reply === 'function' ? reply() : reply,
        toolCalls: [],
      }),
    },
  };
}

function makeHarness(llm: ConfiguredLLM | null, samples: unknown[] = []) {
  return new AISecureHarness({
    db: {} as Database,
    siteId: 'site_1',
    itemService: fakeItemService(samples),
    schemaService: fakeSchemaService({
      products: [
        { name: 'title', type: 'string' },
        { name: 'price', type: 'float' },
      ],
    }),
    llm,
  });
}

describe('extractJson', () => {
  it('parses plain JSON, fenced JSON, and JSON embedded in prose', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n[1,2]\n```')).toEqual([1, 2]);
    expect(extractJson('Here you go: {"content":"hi"} hope it helps')).toEqual({ content: 'hi' });
  });

  it('throws LLM_INVALID_JSON for non-JSON responses', () => {
    expect(() => extractJson('no json here')).toThrow(/LLM_INVALID_JSON/);
  });
});

describe('generation skills with llm: null (no provider configured)', () => {
  const harness = makeHarness(null);

  it.each(['aiContentAssist', 'generateAppSpec', 'generateSeedData'])(
    '%s fails with LLM_NOT_CONFIGURED instead of stubbing',
    async (skillName) => {
      const result = await harness.runSkill(skillName, { collection: 'products' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('LLM_NOT_CONFIGURED');
      }
    },
  );

  it('aiSuggestField fails with LLM_NOT_CONFIGURED', async () => {
    const result = await harness.runSkill('aiSuggestField', {
      collection: 'products',
      description: 'a blog post',
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('LLM_NOT_CONFIGURED');
  });

  it('generateApiDocs still works — it derives the spec from the live schema', async () => {
    const result = await harness.runSkill('generateApiDocs', { collections: ['products'] });
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { artifacts: Array<{ content: { paths: Record<string, unknown> } }> };
      expect(data.artifacts[0]!.content.paths['/api/v1/items/products']).toBeDefined();
      expect(data.artifacts[0]!.content.paths['/api/v1/items/products/{id}']).toBeDefined();
    }
  });
});

describe('generation skills with a configured provider', () => {
  it('aiContentAssist returns model content with usage meta and RAG sample count', async () => {
    const harness = makeHarness(fakeLLM('{"content":"A crisp product blurb."}'), [
      { id: 'p1', title: 'Sample', status: 'published' },
    ]);
    const result = await harness.runSkill('aiContentAssist', {
      collection: 'products',
      fieldName: 'description',
      instruction: 'write a blurb',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      expect(data['generatedContent']).toBe('A crisp product blurb.');
      expect(data['ragSamples']).toBe(1);
      expect(data['meta']).toMatchObject({ provider: 'fake', model: 'fake-model-1' });
      expect((data['meta'] as { estimatedTokens: number }).estimatedTokens).toBeGreaterThan(0);
    }
  });

  it('aiSuggestField filters duplicates of existing fields and respects maxSuggestions', async () => {
    const harness = makeHarness(
      fakeLLM(
        JSON.stringify([
          { name: 'title', type: 'string', interface: 'input', required: true, description: 'dup' },
          { name: 'summary', type: 'text', interface: 'input-multiline', required: false, description: 'ok' },
          { name: 'cover', type: 'string', interface: 'file', required: false, description: 'ok' },
        ]),
      ),
    );
    const result = await harness.runSkill('aiSuggestField', {
      collection: 'products',
      description: 'product page',
      maxSuggestions: 1,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { suggestions: Array<{ name: string }> };
      // 'title' already exists on products and must be filtered out.
      expect(data.suggestions).toHaveLength(1);
      expect(data.suggestions[0]!.name).toBe('summary');
    }
  });

  it('generateAppSpec produces page/component artifacts whose sections carry source bindings', async () => {
    const harness = makeHarness(
      fakeLLM(
        JSON.stringify({
          pages: [
            {
              collection: 'products',
              route: '/products',
              title: 'Products',
              sections: [
                { id: 'grid', component: 'ProductGrid', source: { collection: 'products', limit: 12, orderBy: '-created_at' } },
              ],
            },
          ],
          components: [{ name: 'ProductGrid', collection: 'products', props: {} }],
        }),
      ),
    );
    const result = await harness.runSkill('generateAppSpec', { collections: ['products'], targetApp: 'storefront' });
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { artifacts: Array<{ type: string; content: Record<string, unknown> }> };
      expect(data.artifacts.map((a) => a.type)).toEqual(['page_spec', 'component_spec']);
      const pages = data.artifacts[0]!.content['pages'] as Array<{ sections: Array<{ source?: unknown }> }>;
      expect(pages[0]!.sections[0]!.source).toMatchObject({ collection: 'products' });
    }
  });

  it('generateSeedData returns model rows clamped to count with draft default status', async () => {
    const harness = makeHarness(
      fakeLLM(
        JSON.stringify([
          { title: 'Aurora Lamp', price: 49.5 },
          { title: 'Granite Mug', price: 18, status: 'published' },
          { title: 'Extra Row', price: 1 },
        ]),
      ),
    );
    const result = await harness.runSkill('generateSeedData', { collection: 'products', count: 2 });
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { artifacts: Array<{ content: { rows: Array<Record<string, unknown>> } }> };
      const rows = data.artifacts[0]!.content.rows;
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ title: 'Aurora Lamp', status: 'draft' });
      expect(rows[1]).toMatchObject({ status: 'published' });
    }
  });

  it('surfaces provider failures as LLM_PROVIDER_ERROR', async () => {
    const failing: ConfiguredLLM = {
      name: 'fake',
      model: 'fake-model-1',
      provider: {
        chat: async () => {
          throw new Error('429 rate limited');
        },
      },
    };
    const harness = makeHarness(failing);
    const result = await harness.runSkill('aiContentAssist', { collection: 'products', fieldName: 'x', instruction: 'y' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('LLM_PROVIDER_ERROR');
  });

  it('rejects invalid model JSON with LLM_INVALID_JSON', async () => {
    const harness = makeHarness(fakeLLM('certainly! here is your content'));
    const result = await harness.runSkill('generateSeedData', { collection: 'products', count: 2 });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('LLM_INVALID_JSON');
  });
});
