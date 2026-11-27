import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertEmbeddings,
  cosineSimilarity,
  createEmbeddingProvider,
  EchoEmbeddingProvider,
  OpenAIEmbeddingProvider,
  WorkersAIEmbeddingProvider,
} from '../embedding-service';

/**
 * Mixed models or dimensions must fail loudly (#581). Before the fix a length
 * mismatch scored 0 ("unrelated"), a malformed Workers AI answer became `[]`,
 * and the OpenAI provider reported 1536 dimensions for every model.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })),
  );
}

const vec = (n: number, value = 0.1) => Array.from({ length: n }, () => value);

describe('cosineSimilarity', () => {
  it('scores vectors of the same dimension', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('throws on a dimension mismatch instead of scoring 0', () => {
    expect(() => cosineSimilarity(vec(1536), vec(768))).toThrow(/EMBEDDING_DIMENSION_MISMATCH/);
    expect(() => cosineSimilarity([], [])).toThrow(/EMBEDDING_DIMENSION_MISMATCH/);
  });
});

describe('assertEmbeddings', () => {
  it('accepts one finite vector of the expected size per input', () => {
    expect(assertEmbeddings([vec(3), vec(3)], 2, 3, 't')).toHaveLength(2);
  });

  it.each([
    ['missing answer', undefined, /EMBEDDING_RESPONSE_INVALID/],
    ['fewer vectors than inputs', [vec(3)], /EMBEDDING_RESPONSE_INVALID/],
    ['wrong dimension', [vec(3), vec(4)], /EMBEDDING_DIMENSION_MISMATCH/],
    ['non-finite value', [vec(3), [0, Number.NaN, 0]], /EMBEDDING_RESPONSE_INVALID/],
  ])('rejects %s', (_label, vectors, error) => {
    expect(() => assertEmbeddings(vectors, 2, 3, 't')).toThrow(error);
  });
});

describe('providers', () => {
  it('OpenAI reports the dimension of the configured model and records the model', () => {
    expect(new OpenAIEmbeddingProvider('k').dimensions).toBe(1536);
    const large = new OpenAIEmbeddingProvider('k', 'text-embedding-3-large');
    expect(large.dimensions).toBe(3072);
    expect(large.model).toBe('text-embedding-3-large');
    expect(() => new OpenAIEmbeddingProvider('k', 'made-up-model')).toThrow(/EMBEDDING_MODEL_UNKNOWN/);
  });

  it('OpenAI rejects a vector whose size does not match the model', async () => {
    stubFetch({ data: [{ index: 0, embedding: vec(768) }] });
    await expect(new OpenAIEmbeddingProvider('k').embed(['a'])).rejects.toThrow(/EMBEDDING_DIMENSION_MISMATCH/);
  });

  it('OpenAI keeps input order', async () => {
    stubFetch({ data: [{ index: 1, embedding: vec(1536, 0.2) }, { index: 0, embedding: vec(1536, 0.1) }] });
    const out = await new OpenAIEmbeddingProvider('k').embed(['a', 'b']);
    expect(out[0]![0]).toBe(0.1);
    expect(out[1]![0]).toBe(0.2);
  });

  it('Workers AI rejects a malformed answer instead of returning no vectors', async () => {
    stubFetch({ result: {} });
    const provider = new WorkersAIEmbeddingProvider({ accountId: 'a', apiToken: 't' });
    await expect(provider.embed(['a'])).rejects.toThrow(/EMBEDDING_RESPONSE_INVALID/);
  });

  it('Echo vectors match its declared dimension', async () => {
    const echo = new EchoEmbeddingProvider();
    const [v] = await echo.embed(['x']);
    expect(v).toHaveLength(echo.dimensions);
    expect(echo.model).toBe('echo');
  });
});

describe('createEmbeddingProvider', () => {
  it.each([undefined, 'anthropic', 'claude', 'gemini', 'nvidia', 'vertex'])(
    'keeps embeddings optional for %s and honors an existing OpenAI key',
    (LLM_PROVIDER) => {
      expect(createEmbeddingProvider({ LLM_PROVIDER })).toBeNull();
      expect(createEmbeddingProvider({ LLM_PROVIDER, OPENAI_API_KEY: 'key' })).toBeInstanceOf(OpenAIEmbeddingProvider);
    },
  );

  it('requires credentials for the selected backend', () => {
    expect(() => createEmbeddingProvider({ LLM_PROVIDER: 'openai' })).toThrow(/OPENAI_API_KEY/);
    for (const credentials of [{ WORKERS_AI_ACCOUNT_ID: 'id' }, { WORKERS_AI_API_TOKEN: 'token' }]) {
      expect(() => createEmbeddingProvider({ LLM_PROVIDER: 'workers-ai', ...credentials })).toThrow(/Workers|WORKERS/);
    }
    expect(createEmbeddingProvider({ LLM_PROVIDER: 'workers-ai', WORKERS_AI_ACCOUNT_ID: 'id', WORKERS_AI_API_TOKEN: 'token' }))
      .toBeInstanceOf(WorkersAIEmbeddingProvider);
    expect(createEmbeddingProvider({ LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'key' })).toBeInstanceOf(OpenAIEmbeddingProvider);
  });

  it('rejects unknown providers even with a usable OpenAI key', () => {
    expect(() => createEmbeddingProvider({ LLM_PROVIDER: 'unknown', OPENAI_API_KEY: 'key' }))
      .toThrow('Unsupported embedding provider configuration');
  });

  it.each(['development', 'test'])('allows explicit Echo in %s', (LUMIBASE_ENV) => {
    expect(createEmbeddingProvider({ LLM_PROVIDER: 'echo', LUMIBASE_ENV })).toBeInstanceOf(EchoEmbeddingProvider);
    expect(createEmbeddingProvider({ LUMIBASE_ENV })).toBeNull();
  });

  it.each([undefined, 'staging', 'production'])('rejects explicit Echo in %s', (LUMIBASE_ENV) => {
    expect(() => createEmbeddingProvider({ LLM_PROVIDER: 'echo', LUMIBASE_ENV })).toThrow(/Echo embeddings require/);
  });
});
