import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveLogicalQueue, WORKER_QUEUE_CONSUMERS } from '../cloudflare-queue';

/**
 * Queue-consumer parity between the two entrypoints (DoD §2b; B10, B118).
 *
 * Docker/Node consumes queues by calling `register*Worker` in `serve.ts`;
 * Cloudflare Workers consumes them through the `queue()` export in
 * `cloudflare.ts` (`processCloudflareQueue`). Twice a consumer existed on only
 * one side: `agent-runs` had no Workers consumer until B10, and `flow-runs` /
 * `flow-events` had none until B118, so async flow runs (including J10
 * `ai:decision` and the J11/J12 automation flows) never executed on Workers.
 * `content-indexing` / `revalidation-dispatch` had none until B131, so on
 * Workers the search index and ISR targets never saw a content change.
 * Nothing failed at build time; jobs just waited forever.
 *
 * This scan fails when:
 *   (a) `serve.ts` registers a consumer that Workers neither consumes nor
 *       allow-lists with a backlog ID;
 *   (b) a Workers consumer has no Docker registration, no entrypoint export,
 *       or is missing a producer, consumer or DLQ in any wrangler profile;
 *   (c) a Workers consumer passes a different provider set than Docker.
 */

const SRC = resolve(__dirname, '..');
const read = (rel: string) => readFileSync(resolve(SRC, rel), 'utf8');
const SERVE = read('serve.ts');
const ENTRY = read('cloudflare.ts');
const FLOW_HANDLERS = read('cloudflare-flow-queue.ts');
const AGENT_HANDLER = read('cloudflare-agent-queue.ts');
const CONTENT_HANDLERS = read('cloudflare-content-queue.ts');
const CRON_PARITY = read('cloudflare-cron-parity.ts');
const WRANGLER = readFileSync(resolve(SRC, '../wrangler.toml'), 'utf8');

const PROFILES = ['local', 'staging', 'production', 'dev', 'demo'] as const;

/**
 * Docker consumers that Workers replaces with a Cron Trigger sweep rather than
 * a queue consumer (B131). Nothing enqueues on their queue in production code,
 * or the queue is only a latency path in front of a periodic backstop, so the
 * backstop is what Workers needs. Each maps to the sweep function Docker runs
 * on node-cron and the tag it has in `cloudflare-cron-parity.ts`.
 */
const WORKER_CRON_EQUIVALENTS: Record<string, { sweep: string; tag: string; dockerSource?: string }> = {
  registerSchedulerWorker: { sweep: 'runSchedulerTick', tag: 'content-scheduler' },
  registerStatusPoller: { sweep: 'sweepAllSites', tag: 'deployment-poll' },
  registerVetoCommitWorker: { sweep: 'sweepDueVetoCommits', tag: 'veto-sweep' },
  // Docker runs the CDC sweep on a setInterval inside the registration.
  registerCdcDispatchWorker: { sweep: 'runCdcDispatchSweep', tag: 'cdc-dispatch', dockerSource: 'modules/cdc/change-feed/dispatcher.ts' },
};

/**
 * Docker consumers Workers deliberately does not run, with the reason. Not a
 * backlog: adding an entry needs a reason a reviewer can check.
 */
const DOCKER_ONLY_BY_DESIGN: Record<string, string> = {
  // Production code wires the audit queue only through this registration
  // (setAuditLogQueue), so on Workers AuditLogger writes every row
  // synchronously and nothing is lost. A Workers consumer would set that
  // isolate-global queue, start routing requests' audit through an in-memory
  // batcher, and risk losing rows when the isolate ends before the flush.
  registerAuditLogWorker: 'Workers writes audit synchronously; no queue is wired there',
};

// ── Scanner ─────────────────────────────────────────────────────────────────

/** Body of the first object-literal argument of each `name({ … })` call. */
export function objectArgs(source: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`\\b${name}\\(\\s*\\{`, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    let depth = 1;
    let i = match.index + match[0].length;
    for (; i < source.length && depth > 0; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') depth -= 1;
    }
    out.push(source.slice(match.index + match[0].length, i - 1));
  }
  return out;
}

/** Top-level keys of an object-literal body (`a`, `b: x`, `c: f({ d })`). */
export function topLevelKeys(body: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let segment = '';
  const flush = () => {
    const key = /^\s*([A-Za-z_$][\w$]*)\s*(?::|$)/.exec(segment);
    if (key) keys.push(key[1]!);
    segment = '';
  };
  // Comments may contain commas and braces; drop them before splitting.
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const ch of code) {
    if ('({['.includes(ch)) depth += 1;
    else if (')}]'.includes(ch)) depth -= 1;
    if (ch === ',' && depth === 0) flush();
    else segment += ch;
  }
  flush();
  return keys.sort();
}

function keysOf(source: string, name: string): string[] {
  const calls = objectArgs(source, name);
  expect(calls, `${name}({ … }) not found`).toHaveLength(1);
  return topLevelKeys(calls[0]!);
}

const serveRegistrations = [...new Set([...SERVE.matchAll(/\b(register\w+(?:Worker|Poller))\(/g)].map((m) => m[1]!))];
const consumers = Object.entries(WORKER_QUEUE_CONSUMERS);

// ── (a) Docker → Workers ────────────────────────────────────────────────────

describe('every Docker queue consumer is consumed on Workers or allow-listed (a)', () => {
  it('finds the serve.ts registrations (non-vacuous)', () => {
    expect(serveRegistrations.length).toBeGreaterThanOrEqual(11);
  });

  it('no serve.ts consumer is missing on Workers without a backlog ID', () => {
    const workers = new Set<string>(consumers.map(([, c]) => c.dockerRegistration));
    const missing = serveRegistrations.filter(
      (name) => !workers.has(name) && !(name in WORKER_CRON_EQUIVALENTS) && !(name in DOCKER_ONLY_BY_DESIGN),
    );
    expect(
      missing,
      'These serve.ts consumers have no Workers counterpart. Add a handler to ' +
        'WORKER_QUEUE_CONSUMERS (src/cloudflare-queue.ts) + wrangler bindings, a sweep ' +
        'to cloudflare-cron-parity.ts, or a reasoned entry in DOCKER_ONLY_BY_DESIGN.',
    ).toEqual([]);
  });

  it('every category names a consumer that still exists, in exactly one category', () => {
    const queued = consumers.map(([, c]) => c.dockerRegistration as string);
    for (const name of [...Object.keys(WORKER_CRON_EQUIVALENTS), ...Object.keys(DOCKER_ONLY_BY_DESIGN)]) {
      expect(serveRegistrations, `${name} left serve.ts; drop it`).toContain(name);
      expect(queued).not.toContain(name);
    }
    for (const name of Object.keys(DOCKER_ONLY_BY_DESIGN)) expect(WORKER_CRON_EQUIVALENTS).not.toHaveProperty(name);
  });

  it.each(Object.entries(WORKER_CRON_EQUIVALENTS))(
    '%s: serve.ts runs %s on a schedule and the Worker runs it from a sweep',
    (_name, { sweep, tag, dockerSource }) => {
      expect(dockerSource ? read(dockerSource) : SERVE).toMatch(new RegExp(`\\b${sweep}\\(`));
      expect(CRON_PARITY).toMatch(new RegExp(`\\b${sweep}\\(`));
      expect(CRON_PARITY).toContain(`'${tag}':`);
    },
  );

  it('the goal-dispatch tick, which has no queue, runs on both entrypoints', () => {
    expect(SERVE).toMatch(/\brunGoalDispatchTick\(/);
    expect(CRON_PARITY).toMatch(/\brunGoalDispatchTick\(/);
    expect(CRON_PARITY).toContain("'goal-dispatch':");
  });

  it('the retention sweep runs hourly on both entrypoints', () => {
    expect(SERVE).toMatch(/\bsweepRetention\(/);
    expect(CRON_PARITY).toMatch(/\bsweepRetention\(/);
  });
});

// ── (b) Workers → Docker + wrangler ─────────────────────────────────────────

describe('every Workers consumer has a Docker twin and wrangler config in every profile (b)', () => {
  it('the Worker exports the dispatcher and runs the parity sweeps on every trigger', () => {
    expect(ENTRY).toContain('queue: processCloudflareQueue');
    expect(ENTRY).toContain("controller.cron === '* * * * *'");
    expect(ENTRY).toContain('runWorkerSweeps(MINUTE_SWEEPS, sweepDeps)');
    expect(ENTRY).toContain('runWorkerSweeps({ ...MINUTE_SWEEPS, ...FIVE_MINUTE_SWEEPS }, sweepDeps)');
    expect(ENTRY).toContain('runWorkerSweeps(HOURLY_SWEEPS, sweepDeps)');
    // The scheduler tick carries the schedule-flow sweep (B118, B132).
    expect(read('services/scheduler-worker.ts')).toMatch(/runDueScheduledFlows\(/);
  });

  it.each(consumers)('%s is registered in serve.ts', (_logical, consumer) => {
    expect(SERVE).toMatch(new RegExp(`\\b${consumer.dockerRegistration}\\(`));
  });

  it.each(consumers.flatMap(([logical, c]) => PROFILES.map((p) => [logical, c.binding, p] as const)))(
    '%s (%s) has producer, consumer and DLQ in the %s profile',
    (logical, binding, profile) => {
      const prefix = profile === 'local' ? '' : `env.${profile}.`;
      const queue = `lumibase-${logical}-${profile}`;
      expect(WRANGLER).toContain(`[[${prefix}queues.producers]]\nbinding = "${binding}"\nqueue = "${queue}"`);
      expect(WRANGLER).toContain(`[[${prefix}queues.consumers]]\nqueue = "${queue}"`);
      expect(WRANGLER).toContain(`dead_letter_queue = "${queue}-dlq"`);
      expect(resolveLogicalQueue(queue)).toBe(logical);
      expect(resolveLogicalQueue(`${queue}-dlq`)).toBeNull();
    },
  );

  it('every consumer configured in wrangler.toml has a handler', () => {
    const configured = [...WRANGLER.matchAll(/queues\.consumers\]\]\nqueue = "([^"]+)"/g)].map((m) => m[1]!);
    expect(configured.length).toBe(consumers.length * PROFILES.length);
    expect(configured.filter((q) => resolveLogicalQueue(q) === null)).toEqual([]);
  });

  it('production and local fire the minute cron while other profiles reserve quota', () => {
    const crons = [...WRANGLER.matchAll(/^crons = (\[.*\])$/gm)].map((m) => JSON.parse(m[1]!) as string[]);
    expect(crons).toHaveLength(PROFILES.length);
    for (const [index, profile] of PROFILES.entries()) {
      if (profile === 'dev' || profile === 'demo') {
        expect(crons[index]).toEqual([]);
      } else if (profile === 'staging') {
        expect(crons[index]).toEqual(['0 * * * *', '*/5 * * * *']);
      } else {
        expect(crons[index]).toContain('* * * * *');
      }
    }
  });
});

// ── (c) Provider parity ─────────────────────────────────────────────────────

describe('Workers consumers get the same providers as Docker (c)', () => {
  it.each(['registerFlowRunsWorker', 'registerFlowEventWorker'])('%s: same deps keys on both entrypoints', (name) => {
    const docker = keysOf(SERVE, name);
    expect(docker).toEqual(['cache', 'db', 'env', 'keys', 'queue']);
    expect(keysOf(FLOW_HANDLERS, name)).toEqual(docker);
  });

  it.each([
    ['registerContentIndexingWorker', ['queue', 'search']],
    ['registerRevalidationWorker', ['db', 'queue']],
  ])('%s: same deps keys on both entrypoints', (name, expected) => {
    const docker = keysOf(SERVE, name);
    expect(docker).toEqual(expected);
    expect(keysOf(CONTENT_HANDLERS, name)).toEqual(docker);
  });

  it('agent-runs: the Workers handler passes at least the Docker providers', () => {
    const docker = keysOf(SERVE, 'registerAgentRunWorker');
    const workers = keysOf(AGENT_HANDLER, 'processAgentRunJob');
    expect(docker).toEqual(expect.arrayContaining(['cache', 'db', 'env', 'keys', 'queue', 'search']));
    expect(workers).toEqual(expect.arrayContaining(docker));
  });
});

// ── (d) The scanner itself ──────────────────────────────────────────────────

describe('scanner self-checks (d)', () => {
  it('extracts shorthand and key: value keys, ignoring nested objects', () => {
    const [body] = objectArgs('registerX({ db, cache: runtime.cache, env: f({ inner: 1, other }), keys })', 'registerX');
    expect(topLevelKeys(body!)).toEqual(['cache', 'db', 'env', 'keys']);
  });

  it('ignores commas and braces inside comments', () => {
    const [body] = objectArgs('registerX({\n  db,\n  // uses, so {x}\n  keys: k,\n})', 'registerX');
    expect(topLevelKeys(body!)).toEqual(['db', 'keys']);
  });

  it('detects a registration missing a provider', () => {
    const [body] = objectArgs('registerFlowRunsWorker({ db, queue, keys: k, env: e });', 'registerFlowRunsWorker');
    expect(topLevelKeys(body!)).not.toContain('cache');
  });
});
