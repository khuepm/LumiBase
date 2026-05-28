/**
 * Embedding Service — POST-GA Task #3.
 *
 * Provides vector embedding generation for RAG (Retrieval Augmented
 * Generation) in AI skills. Supports OpenAI embeddings and Workers AI
 * embeddings, with a fallback echo provider for testing.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmbeddingProvider {
  /** Generate embeddings for an array of texts. */
  embed(texts: string[]): Promise<number[][]>;
  /** Dimension of the output vectors. */
  dimensions: number;
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
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

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

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 1536;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model = 'text-embedding-3-small') {
    this.apiKey = apiKey;
    this.model = model;
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
    return data.data
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }
}

// ---------------------------------------------------------------------------
// Workers AI Embedding Provider
// ---------------------------------------------------------------------------

export class WorkersAIEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 768;
  private readonly accountId: string;
  private readonly apiToken: string;
  private readonly model: string;

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

    return data.result?.data ?? [];
  }
}

// ---------------------------------------------------------------------------
// Echo Embedding Provider (testing / no-op)
// ---------------------------------------------------------------------------

export class EchoEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 8;

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
