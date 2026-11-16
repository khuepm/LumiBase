import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertEmbeddings,
  cosineSimilarity,
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
