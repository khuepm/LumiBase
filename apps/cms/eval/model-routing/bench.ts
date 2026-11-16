/** Synthetic upstream, actual provider serialization/parsing and fallback selection. */
import { performance } from 'node:perf_hooks';
import { createLLMProvider } from '../../src/services/llm-provider';

const iterations = 120;
const inputPrice = 2;
const outputPrice = 8;
const message = [{ role: 'user' as const, content: 'List collections available to this principal.' }];
const configured = createLLMProvider({ LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'synthetic-benchmark' });
const fallback = createLLMProvider({ LLM_PROVIDER: 'echo' });
let failed = false;
let networkCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  networkCalls++;
  return failed ? new Response('unavailable', { status: 503 }) : Response.json({
    choices: [{ message: { content: 'Synthetic provider answer.' } }],
    usage: { prompt_tokens: 96, completion_tokens: 12 },
  });
};
async function measure(kind: 'provider_success' | 'provider_outage' | 'configured_echo') {
  const durations: number[] = [];
  let inputTokens = 0; let outputTokens = 0; let errors = 0;
  const before = networkCalls;
  failed = kind === 'provider_outage';
  for (let i = 0; i < iterations; i++) {
    const started = performance.now();
    try {
      const response = await (kind === 'configured_echo' ? fallback : configured).chat(message);
      inputTokens += response.usage?.inputTokens ?? 0;
      outputTokens += response.usage?.outputTokens ?? 0;
    } catch { errors++; }
    durations.push(performance.now() - started);
  }
  durations.sort((a, b) => a - b);
  const p = (percent: number) => Number(durations[Math.ceil(durations.length * percent) - 1]!.toFixed(3));
  const upstreamAttempts = networkCalls - before;
  const valid = errors === (failed ? iterations : 0) && upstreamAttempts === (kind === 'configured_echo' ? 0 : iterations);
  const usd = kind === 'provider_success' ? (inputTokens * inputPrice + outputTokens * outputPrice) / 1_000_000 : null;
  return { kind, iterations, errors, upstreamAttempts, p50Ms: p(0.5), p95Ms: p(0.95), p99Ms: p(0.99),
    inputTokens: kind === 'provider_success' ? inputTokens : null, outputTokens: kind === 'provider_success' ? outputTokens : null,
    estimatedUsd: usd, passed: valid && p(0.95) < 100 };
}
try {
  const results = [];
  for (const kind of ['provider_success', 'provider_outage', 'configured_echo'] as const) results.push(await measure(kind));
  console.log(JSON.stringify({ mode: 'synthetic-provider-local', iterations, pricesUsdPerMillion: { input: inputPrice, output: outputPrice }, thresholdLocalP95Ms: 100, results }, null, 2));
  if (results.some((row) => !row.passed)) process.exitCode = 1;
} finally { globalThis.fetch = originalFetch; }
