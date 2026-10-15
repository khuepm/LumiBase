import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * DoD §2b provider parity for the Flows workers (B121). The event/schedule
 * worker used to be registered with `db`, `queue` and `keys` only, while the
 * manual-run worker also got `cache` and the process env. Every Flows
 * operation that needs the decision path (the J12 `drift-scan` semantic pass)
 * then failed closed, silently, only on scheduled runs.
 *
 * This scan fails when any `registerFlow*Worker({...})` call in `serve.ts`
 * omits `cache` or `env`, so the next worker cannot drift apart again.
 */
const SERVE = resolve(__dirname, '../serve.ts');

function workerCalls(source: string): Array<{ name: string; body: string }> {
  const calls: Array<{ name: string; body: string }> = [];
  const re = /\b(registerFlow\w*Worker)\(\{/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    let depth = 1;
    let i = match.index + match[0].length;
    for (; i < source.length && depth > 0; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') depth -= 1;
    }
    calls.push({ name: match[1]!, body: source.slice(match.index + match[0].length, i - 1) });
  }
  return calls;
}

describe('Flows workers get the same runtime providers (B121)', () => {
  const calls = workerCalls(readFileSync(SERVE, 'utf8'));

  it('finds the Flows worker registrations in serve.ts', () => {
    expect(calls.map((c) => c.name).sort()).toEqual(['registerFlowEventWorker', 'registerFlowRunsWorker']);
  });

  it.each(['cache', 'env', 'keys'])('every Flows worker is registered with `%s`', (provider) => {
    const missing = calls.filter((c) => !new RegExp(`\\b${provider}\\s*:`).test(c.body)).map((c) => c.name);
    expect(missing, `registered without ${provider}`).toEqual([]);
  });

  it('the scan itself catches a registration without a provider', () => {
    const [call] = workerCalls('registerFlowEventWorker({ db: x, queue: y, keys: z });');
    expect(/\bcache\s*:/.test(call!.body)).toBe(false);
  });
});
