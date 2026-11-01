#!/usr/bin/env node
/**
 * Post-deploy check for a shared-domain CMS Worker (dev / staging / demo).
 *
 * It separates three questions that `curl --fail /health` used to collapse into
 * one (#461):
 *
 *   1. Did the Worker boot and does it own its routes?  `/health` must answer
 *      200 with the CMS health JSON. A Studio `index.html` means the request
 *      fell through to Pages, so the Worker route is missing.
 *   2. Is the deployed build the one for this channel?  `/api/v1/system/version`
 *      must report `releaseChannel` = the target env.
 *   3. Are its dependencies ready?  `/health/ready` answers 200 or 503 with the
 *      same JSON. `/health` stays 200 when the database is unreachable (it is a
 *      degraded-info endpoint), so only this probe can say "not ready".
 *
 * Questions 1 and 2 always fail the step. Question 3 fails it only with
 * `--require-ready`; otherwise a 503 is a warning with the per-dependency
 * breakdown when the Worker exposes it. Staging had no Hyperdrive/KV/R2
 * bindings when this was written, so requiring readiness by default would turn
 * every push to `main` red until an owner provisions them.
 *
 * Dependency-free on purpose (Node 22+ global fetch): it runs in CI after the
 * deploy and should not depend on the workspace install.
 *
 * Usage:
 *   node scripts/verify-cms-deploy.mjs --base-url https://staging.lumibase.dev \
 *     --channel staging [--require-ready] [--attempts 7] [--delay-ms 5000]
 */
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const HEALTH_STATUSES = new Set(['healthy', 'degraded']);

/** Parse a probe body as the CMS health/version JSON, or report what it was. */
export function parseJsonBody(probe) {
  const contentType = String(probe.contentType ?? '').toLowerCase();
  const text = String(probe.body ?? '');
  if (contentType.includes('text/html') || /^\s*</.test(text)) {
    return { kind: 'html' };
  }
  try {
    return { kind: 'json', value: JSON.parse(text) };
  } catch {
    return { kind: 'other' };
  }
}

function describeServices(value) {
  const services = value && typeof value === 'object' ? value.services : undefined;
  if (!services || typeof services !== 'object') return null;
  return Object.entries(services)
    .map(([name, status]) => `${name}=${status}`)
    .join(', ');
}

/**
 * Pure verdict over three probe results `{ status, contentType, body }`.
 * Returns `{ ok, failures, warnings, notes }`.
 */
export function assessDeployment({ health, version, ready, channel, requireReady = false }) {
  const failures = [];
  const warnings = [];
  const notes = [];

  // 1. Boot + route ownership.
  const healthBody = parseJsonBody(health);
  if (healthBody.kind === 'html') {
    failures.push(
      `/health returned HTML (status ${health.status}): the request was served by Pages, not the CMS Worker. ` +
        'Check the Worker routes for this hostname.',
    );
  } else if (health.status !== 200) {
    failures.push(`/health returned ${health.status}: the Worker did not answer its public health endpoint.`);
  } else if (healthBody.kind !== 'json' || !HEALTH_STATUSES.has(healthBody.value?.status)) {
    failures.push('/health returned 200 but not the CMS health JSON ({"status":"healthy"|"degraded"}).');
  } else {
    notes.push(`Worker booted: /health status=${healthBody.value.status}`);
  }

  // 2. Channel.
  const versionBody = parseJsonBody(version);
  if (version.status !== 200 || versionBody.kind !== 'json') {
    failures.push(`/api/v1/system/version returned ${version.status} without version JSON.`);
  } else if (versionBody.value?.releaseChannel !== channel) {
    failures.push(
      `/api/v1/system/version reports releaseChannel=${JSON.stringify(versionBody.value?.releaseChannel)}, expected ${JSON.stringify(channel)}.`,
    );
  } else {
    const { version: v, gitSha } = versionBody.value;
    notes.push(`Deployed build: version=${v} gitSha=${gitSha} releaseChannel=${channel}`);
  }

  // 3. Readiness.
  const readyBody = parseJsonBody(ready);
  if (readyBody.kind === 'html') {
    failures.push(
      `/health/ready returned HTML (status ${ready.status}): it is not routed to the CMS Worker, ` +
        'so readiness cannot be observed. Add a `<host>/health/*` Worker route.',
    );
  } else if (readyBody.kind !== 'json' || (ready.status !== 200 && ready.status !== 503)) {
    failures.push(`/health/ready returned ${ready.status} without the CMS health JSON.`);
  } else if (ready.status === 200) {
    notes.push('Dependencies ready: /health/ready 200');
  } else {
    const breakdown = describeServices(readyBody.value);
    const message =
      `/health/ready returned 503: the Worker is up but its dependencies are not ready` +
      (breakdown ? ` (${breakdown})` : ' (per-dependency detail hidden; call it with the observability token)') +
      '. See docs/en/deployment/shared-domain-environments.md, "Bindings".';
    if (requireReady) failures.push(message);
    else warnings.push(message);
  }

  return { ok: failures.length === 0, failures, warnings, notes };
}

function parseArgs(argv) {
  const args = { attempts: 7, delayMs: 5000, requireReady: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--base-url') args.baseUrl = argv[++i];
    else if (flag === '--channel') args.channel = argv[++i];
    else if (flag === '--require-ready') args.requireReady = true;
    else if (flag === '--attempts') args.attempts = Number(argv[++i]);
    else if (flag === '--delay-ms') args.delayMs = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!args.baseUrl || !args.channel) throw new Error('--base-url and --channel are required');
  return args;
}

async function probe(url) {
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    return { status: res.status, contentType: res.headers.get('content-type') ?? '', body: await res.text() };
  } catch (error) {
    return { status: 0, contentType: '', body: '', error: String(error?.message ?? error) };
  }
}

/**
 * Retry while the answer is not yet the Worker's: network errors, 5xx and the
 * Pages HTML that a freshly added route can still return for a few seconds.
 * A JSON 503 from /health/ready is a real answer and is not retried.
 */
async function probeUntilWorker(url, { attempts, delayMs, done }) {
  let last;
  for (let i = 1; i <= attempts; i += 1) {
    last = await probe(url);
    if (done(last)) return last;
    if (i < attempts) await new Promise((r) => setTimeout(r, delayMs));
  }
  return last;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = args.baseUrl.replace(/\/+$/, '');
  const opts = { attempts: args.attempts, delayMs: args.delayMs };
  const isJson = (p) => parseJsonBody(p).kind === 'json';

  const health = await probeUntilWorker(`${base}/health`, { ...opts, done: (p) => p.status === 200 && isJson(p) });
  const version = await probeUntilWorker(`${base}/api/v1/system/version`, {
    ...opts,
    done: (p) => p.status === 200 && isJson(p),
  });
  const ready = await probeUntilWorker(`${base}/health/ready`, {
    ...opts,
    done: (p) => (p.status === 200 || p.status === 503) && isJson(p),
  });

  const verdict = assessDeployment({ health, version, ready, channel: args.channel, requireReady: args.requireReady });
  for (const note of verdict.notes) console.log(note);
  for (const warning of verdict.warnings) console.log(`::warning title=CMS readiness::${warning}`);
  for (const failure of verdict.failures) console.log(`::error title=CMS deploy check::${failure}`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [
      `### CMS deploy check: ${base}`,
      '',
      ...verdict.notes.map((n) => `- ✅ ${n}`),
      ...verdict.warnings.map((w) => `- ⚠️ ${w}`),
      ...verdict.failures.map((f) => `- ❌ ${f}`),
      '',
    ];
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  }
  process.exit(verdict.ok ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
