/**
 * Embedding Service — POST-GA Task #3.
 *
 * Provides vector embedding generation for RAG (Retrieval Augmented
 * Generation) in AI skills. Supports OpenAI embeddings and Workers AI
 * embeddings, with a fallback echo provider for testing.
 *
 * Status (#581 audit): nothing in the CMS calls this module or reads/writes
 * `lumibase_ai_embeddings` yet. The `aiContentAssist` "RAG" context is a live
 * `ItemService.list` sample, not a vector search. The primitives below fail
 * loudly on a model/dimension mismatch so that whoever wires them later cannot
 * silently compare vectors from two models.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmbeddingProvider {
  /** Generate embeddings for an array of texts. */
  embed(texts: string[]): Promise<number[][]>;
  /** Dimension of the output vectors. */
  dimensions: number;
  /** Model id the vectors came from; store it next to every vector. */
  model: string;
}

/**
 * Checks a provider response: one finite vector of `dimensions` numbers per
 * input text. A short, empty or wrong-sized answer throws instead of reaching
 * storage or a similarity score.
 */
export function assertEmbeddings(
  vectors: unknown,
  expectedCount: number,
  dimensions: number,
  source: string,
): number[][] {
  if (!Array.isArray(vectors) || vectors.length !== expectedCount) {
    const got = Array.isArray(vectors) ? vectors.length : typeof vectors;
    throw new Error(`EMBEDDING_RESPONSE_INVALID: ${source} returned ${got} vectors for ${expectedCount} inputs`);
  }
  vectors.forEach((vector, index) => {
    if (!Array.isArray(vector) || vector.length !== dimensions) {
      const got = Array.isArray(vector) ? vector.length : typeof vector;
      throw new Error(
        `EMBEDDING_DIMENSION_MISMATCH: ${source} vector ${index} has ${got} dimensions, expected ${dimensions}`,
      );
    }
    if (!vector.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      throw new Error(`EMBEDDING_RESPONSE_INVALID: ${source} vector ${index} has a non-finite value`);
    }
  });
  return vectors as number[][];
}

export interface EmbeddingProviderEnv {
  LLM_PROVIDER?: string;
  OPENAI_API_KEY?: string;
  WORKERS_AI_ACCOUNT_ID?: string;
  WORKERS_AI_API_TOKEN?: string;
}

// ---------------------------------------------------------------------------
// Cosine Similarity
// ---------------------------------------------------------------------------

/**
 * Computes cosine similarity between two vectors.
 * Returns a value between -1 and 1, where 1 = identical direction.
 *
 * Vectors of different lengths come from different models (or a truncated
 * response) and have no meaningful similarity, so this throws
 * `EMBEDDING_DIMENSION_MISMATCH` instead of returning 0. A silent 0 would rank
 * the item as merely "unrelated" and hide a mixed index.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {
    throw new Error(`EMBEDDING_DIMENSION_MISMATCH: cannot compare ${a.length}- and ${b.length}-dimension vectors`);
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;
  return dotProduct / denominator;
}

// ---------------------------------------------------------------------------
// OpenAI Embedding Provider
// ---------------------------------------------------------------------------

/** Native output size of the OpenAI embedding models this provider accepts. */
export const OPENAI_EMBEDDING_DIMENSIONS: Readonly<Record<string, number>> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
};

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;
  readonly model: string;
  private readonly apiKey: string;

  constructor(apiKey: string, model = 'text-embedding-3-small') {
    const dimensions = OPENAI_EMBEDDING_DIMENSIONS[model];
    if (dimensions === undefined) {
      // A hardcoded 1536 for every model made `dimensions` wrong for -large.
      throw new Error(`EMBEDDING_MODEL_UNKNOWN: no known dimension for OpenAI model "${model}"`);
    }
    this.apiKey = apiKey;
    this.model = model;
    this.dimensions = dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => 'Unknown error');
      throw new Error(`OpenAI Embeddings API error ${res.status}: ${err}`);
    }

    const data = (await res.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
    };

    // Sort by index to maintain order
    const vectors = Array.isArray(data?.data)
      ? [...data.data].sort((a, b) => a.index - b.index).map((d) => d.embedding)
      : undefined;
    return assertEmbeddings(vectors, texts.length, this.dimensions, `openai:${this.model}`);
  }
}

// ---------------------------------------------------------------------------
// Workers AI Embedding Provider
// ---------------------------------------------------------------------------

export class WorkersAIEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 768;
  readonly model: string;
  private readonly accountId: string;
  private readonly apiToken: string;

  constructor(opts: {
    accountId: string;
    apiToken: string;
    model?: string;
  }) {
    this.accountId = opts.accountId;
    this.apiToken = opts.apiToken;
    this.model = opts.model ?? '@cf/baai/bge-base-en-v1.5';
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/run/${this.model}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiToken}`,
      },
      body: JSON.stringify({ text: texts }),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => 'Unknown error');
      throw new Error(`Workers AI Embeddings error ${res.status}: ${err}`);
    }

    const data = (await res.json()) as {
      result?: { data?: number[][] };
    };

    // `?? []` used to turn a malformed answer into "no vectors" for N inputs.
    return assertEmbeddings(data.result?.data, texts.length, this.dimensions, `workers-ai:${this.model}`);
  }
}

// ---------------------------------------------------------------------------
// Echo Embedding Provider (testing / no-op)
// ---------------------------------------------------------------------------

export class EchoEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 8;
  readonly model = 'echo';

  async embed(texts: string[]): Promise<number[][]> {
    // Return deterministic pseudo-embeddings based on text hash
    return texts.map((text) => {
      const hash = simpleHash(text);
      return Array.from({ length: this.dimensions }, (_, i) =>
        Math.sin(hash * (i + 1)) * 0.5 + 0.5,
      );
    });
  }
}

function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = ((hash << 5) - hash + chr) | 0;
  }
  return hash;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createEmbeddingProvider(env: EmbeddingProviderEnv): EmbeddingProvider {
  const provider = env.LLM_PROVIDER ?? 'echo';

  switch (provider) {
    case 'openai': {
      if (!env.OPENAI_API_KEY) return new EchoEmbeddingProvider();
      return new OpenAIEmbeddingProvider(env.OPENAI_API_KEY);
    }

    case 'workers-ai': {
      if (!env.WORKERS_AI_ACCOUNT_ID || !env.WORKERS_AI_API_TOKEN) {
        return new EchoEmbeddingProvider();
      }
      return new WorkersAIEmbeddingProvider({
        accountId: env.WORKERS_AI_ACCOUNT_ID,
        apiToken: env.WORKERS_AI_API_TOKEN,
      });
    }

    default:
      // 'anthropic' does not have an embedding API — fall back to OpenAI or echo
      if (env.OPENAI_API_KEY) {
        return new OpenAIEmbeddingProvider(env.OPENAI_API_KEY);
      }
      return new EchoEmbeddingProvider();
  }
}
