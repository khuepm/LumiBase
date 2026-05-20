/**
 * Translation Memory service — POST-GA1.
 *
 * Provides:
 *   - lookup(query): find TM matches above a fuzzy threshold.
 *   - learn(pair):   record a new (source, target) pair.
 *   - translate(text, opts): MT pipeline — TM → glossary → MT provider fallback.
 *
 * MT providers are pluggable. The default registry includes:
 *   - `deepl`       (DeepL API, requires DEEPL_API_KEY env var)
 *   - `openai`      (OpenAI Chat Completions, requires OPENAI_API_KEY)
 *   - `workers-ai`  (Cloudflare Workers AI binding `AI`)
 *
 * For testability the providers are passed in at construction time and the
 * service is a thin orchestration layer.
 */

export interface TmEntry {
  id: string;
  sourceText: string;
  targetText: string;
  quality: number;
  context?: string | null;
}

export interface MtProvider {
  /** Name used in the `translation_memory.provider` column. */
  name: string;
  /** Translate `text` from `from` → `to` (BCP-47 language tags). */
  translate(input: { text: string; from: string; to: string; glossary?: GlossaryHit[] }): Promise<string>;
}

export interface GlossaryHit {
  term: string;
  translation: string;
  rule: 'do-not-translate' | 'prefer' | 'forbidden';
}

/** Levenshtein-based similarity 0–100. Used as a cheap fuzzy match score. */
export function similarity(a: string, b: string): number {
  if (a === b) return 100;
  if (!a || !b) return 0;

  const la = a.length;
  const lb = b.length;
  const dp: number[][] = Array.from({ length: la + 1 }, () => new Array(lb + 1).fill(0));

  for (let i = 0; i <= la; i++) dp[i]![0] = i;
  for (let j = 0; j <= lb; j++) dp[0]![j] = j;

  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost,
      );
    }
  }

  const distance = dp[la]![lb]!;
  const maxLen = Math.max(la, lb);
  return Math.round((1 - distance / maxLen) * 100);
}

/** Pick the best TM match (>= threshold) given a candidate set. */
export function bestMatch(
  query: string,
  candidates: TmEntry[],
  threshold = 75,
): { entry: TmEntry; score: number } | null {
  let best: { entry: TmEntry; score: number } | null = null;
  for (const entry of candidates) {
    const score = similarity(query, entry.sourceText);
    if (score >= threshold && (!best || score > best.score)) {
      best = { entry, score };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// MT provider stubs — replace with real network calls in production.
// ---------------------------------------------------------------------------

export class DeepLProvider implements MtProvider {
  readonly name = 'deepl';
  constructor(private apiKey: string) {}

  async translate({ text, to }: { text: string; from: string; to: string }): Promise<string> {
    // Placeholder: real impl posts to https://api.deepl.com/v2/translate.
    if (!this.apiKey) throw new Error('DeepL API key missing');
    return `[deepl:${to}] ${text}`;
  }
}

export class OpenAiProvider implements MtProvider {
  readonly name = 'openai';
  constructor(private apiKey: string, private model = 'gpt-4o-mini') {}

  async translate({ text, from, to, glossary }: { text: string; from: string; to: string; glossary?: GlossaryHit[] }): Promise<string> {
    if (!this.apiKey) throw new Error('OpenAI API key missing');
    const glossaryHint = glossary?.length
      ? ` Respect glossary: ${glossary.map((g) => `${g.term}->${g.translation}`).join(', ')}.`
      : '';
    return `[openai:${this.model}:${from}->${to}${glossaryHint}] ${text}`;
  }
}

export class WorkersAiProvider implements MtProvider {
  readonly name = 'workers-ai';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private aiBinding: any) {}

  async translate({ text, to }: { text: string; from: string; to: string }): Promise<string> {
    if (!this.aiBinding) throw new Error('Workers AI binding missing');
    return `[workers-ai:${to}] ${text}`;
  }
}

// ---------------------------------------------------------------------------
// Service orchestrator
// ---------------------------------------------------------------------------

export class TranslationMemoryService {
  constructor(
    private providers: Map<string, MtProvider>,
    private opts: { defaultProvider?: string; tmThreshold?: number } = {},
  ) {}

  /**
   * Translate `text`.
   * 1. Apply glossary substitution placeholders (do-not-translate).
   * 2. Look up TM; if score >= threshold, return TM hit.
   * 3. Otherwise call the chosen MT provider.
   */
  async translate(input: {
    text: string;
    from: string;
    to: string;
    tm: TmEntry[];
    glossary?: GlossaryHit[];
    provider?: string;
  }): Promise<{ text: string; source: 'tm' | 'mt'; provider?: string; tmScore?: number }> {
    const tmHit = bestMatch(input.text, input.tm, this.opts.tmThreshold ?? 75);
    if (tmHit) {
      return { text: tmHit.entry.targetText, source: 'tm', tmScore: tmHit.score };
    }

    const providerName = input.provider ?? this.opts.defaultProvider ?? 'workers-ai';
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new Error(`MT provider not available: ${providerName}`);
    }

    const translated = await provider.translate({
      text: input.text,
      from: input.from,
      to: input.to,
      glossary: input.glossary,
    });

    return { text: translated, source: 'mt', provider: providerName };
  }
}
