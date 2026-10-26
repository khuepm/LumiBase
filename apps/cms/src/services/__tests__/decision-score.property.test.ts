import { afterEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { LLMDecisionProvider, weightedScore, type DecisionRequest } from '../decision-provider';
import { GeminiProvider, OpenAIProvider } from '../llm-provider';

/**
 * #510 (J03) property tests for the LLM score: Σ i·p(i) over 0..N-1, unrounded,
 * independent of the adapter, and never a repair of an invalid distribution.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A probability distribution over N levels whose sum is exactly representable as ≈1. */
const distribution = fc.integer({ min: 2, max: 10 }).chain((levels) =>
  fc.array(fc.integer({ min: 0, max: 1_000 }), { minLength: levels, maxLength: levels })
    .filter((weights) => weights.some((w) => w > 0))
    .map((weights) => {
      const total = weights.reduce((a, b) => a + b, 0);
      const probabilities = Object.fromEntries(weights.map((w, i) => [String(i), w / total]));
      return { levels, probabilities };
    }),
);

function scoreRequest(levels: number): DecisionRequest {
  return {
    state: 's',
    questions: { q: { type: 'score', instructions: 'rate', criteria: Array.from({ length: levels }, (_, i) => `level ${i}`) } },
  };
}

function reply(probabilities: Record<string, number>): string {
  return JSON.stringify({ answers: { q: { probabilities, confidence: 0.5 } } });
}

function stubOpenAI(content: string) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })));
}

function stubGemini(content: string) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: content }] } }] }),
    { status: 200 },
  )));
}

describe('weightedScore (property)', () => {
  it('stays inside [0, N-1] for every valid distribution', () => {
    fc.assert(fc.property(distribution, ({ levels, probabilities }) => {
      const score = weightedScore(probabilities, levels);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(levels - 1);
    }));
  });

  it('returns k when all mass sits on level k, including both ends', () => {
    fc.assert(fc.property(
      fc.integer({ min: 2, max: 10 }).chain((levels) => fc.tuple(fc.constant(levels), fc.integer({ min: 0, max: levels - 1 }))),
      ([levels, k]) => {
        const probabilities = Object.fromEntries(Array.from({ length: levels }, (_, i) => [String(i), i === k ? 1 : 0]));
        expect(weightedScore(probabilities, levels)).toBe(k);
      },
    ));
    expect(weightedScore({ '0': 1, '1': 0, '2': 0 }, 3)).toBe(0);
    expect(weightedScore({ '0': 0, '1': 0, '2': 1 }, 3)).toBe(2);
  });

  it('is unrounded Σ i·p(i)', () => {
    fc.assert(fc.property(distribution, ({ levels, probabilities }) => {
      let expected = 0;
      for (let i = 0; i < levels; i += 1) expected += i * probabilities[String(i)]!;
      expect(weightedScore(probabilities, levels)).toBeCloseTo(expected, 9);
    }));
  });
});

describe('LLM score is adapter independent (property)', () => {
  it('gives the same score for the same distribution through OpenAI and Gemini', async () => {
    await fc.assert(fc.asyncProperty(distribution, async ({ levels, probabilities }) => {
      const request = scoreRequest(levels);
      stubOpenAI(reply(probabilities));
      const viaOpenAI = await new LLMDecisionProvider(new OpenAIProvider('k'), 'm').decide(request);
      stubGemini(reply(probabilities));
      const viaGemini = await new LLMDecisionProvider(new GeminiProvider('k'), 'm').decide(request);

      expect(viaOpenAI.answers.q).toEqual(viaGemini.answers.q);
      expect((viaOpenAI.answers.q as { score: number }).score).toBe(weightedScore(probabilities, levels));
    }), { numRuns: 40 });
  });
});

describe('invalid distributions are rejected, never clamped into a score (property)', () => {
  const broken = distribution.chain(({ levels, probabilities }) => fc.oneof(
    // sum far from 1
    fc.constant({ levels, probabilities: { ...probabilities, '0': (probabilities['0'] ?? 0) + 0.25 } }),
    // a negative probability
    fc.constant({ levels, probabilities: { ...probabilities, '1': -0.1 } }),
    // a missing level
    fc.constant({ levels, probabilities: Object.fromEntries(Object.entries(probabilities).slice(1)) }),
  ));

  it('returns DECISION_PARSE_FAILED', async () => {
    await fc.assert(fc.asyncProperty(broken, async ({ levels, probabilities }) => {
      stubOpenAI(reply(probabilities));
      await expect(new LLMDecisionProvider(new OpenAIProvider('k'), 'm').decide(scoreRequest(levels)))
        .rejects.toMatchObject({ code: 'DECISION_PARSE_FAILED' });
    }), { numRuns: 40 });
  });

  it('rejects a NaN probability (JSON null / string) as DECISION_PARSE_FAILED', async () => {
    for (const bad of [null, 'NaN', '0.5']) {
      stubOpenAI(JSON.stringify({ answers: { q: { probabilities: { '0': bad, '1': 0.5 }, confidence: 0.5 } } }));
      await expect(new LLMDecisionProvider(new OpenAIProvider('k'), 'm').decide(scoreRequest(2)))
        .rejects.toMatchObject({ code: 'DECISION_PARSE_FAILED' });
    }
  });
});
