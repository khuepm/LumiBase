/**
 * Worker startup gate.
 *
 * `wrangler deploy --dry-run` — which is what `pnpm build` runs — bundles the
 * Worker without ever instantiating it. So a module that throws at TOP LEVEL
 * builds perfectly and then fails the moment Cloudflare tries to start it.
 *
 * This script boots the Worker under workerd via `wrangler dev` and requires an
 * HTTP response from `/health`. ANY status counts as success: we are proving the
 * module graph evaluates, not that dependencies are reachable — there is no
 * Postgres or KV in this job, so `/health` legitimately reports unhealthy
 * services. Failure means no response at all, a crashed process, or a timeout.
 *
 * SCOPE — read this before trusting it.
 *
 * This does NOT catch the BullMQ incident that prompted it, and that was
 * measured, not assumed. With the Docker adapters deliberately re-added to the
 * bundle, `wrangler dev` still booted and answered `/health` with 500, while the
 * real Cloudflare deploy rejected the same bundle with validation error 10021
 * (`Uncaught Error: Could not determine sql-loader directory path`). The likely
 * reason is that BullMQ's `getDirname()` falls back to scanning the stack for a
 * `file:///` frame, which local workerd provides and a deployed Worker does not
 * — so the failure is specifically a production-only one. Only a real upload
 * reproduces it.
 *
 * So this gate covers top-level throws that workerd evaluates eagerly, which is
 * a genuine class, but it is NOT the fence for Docker code leaking into the
 * bundle. That fence is `check-worker-bundle.mjs`, which asserts on bundle
 * composition and does catch it. Keep both, and do not let a green run here be
 * read as "the Worker will deploy".
 *
 * `/health` is deliberately public/no-auth (shell contract C7), which is why it
 * is the probe target.
 *
 * Usage: node scripts/verify-worker-startup.mjs
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const PORT = Number(process.env.WORKER_STARTUP_PORT || 8799);
const BOOT_TIMEOUT_MS = Number(process.env.WORKER_STARTUP_TIMEOUT_MS || 120_000);
const PROBE_PATH = '/health';

/** Collected so a failure can show what workerd actually said. */
const output = [];
function record(chunk) {
  const text = chunk.toString();
  output.push(text);
  if (process.env.WORKER_STARTUP_VERBOSE) process.stdout.write(text);
}

console.log(`[worker-startup] booting the Worker under workerd on port ${PORT}…`);

const child = spawn(
  'pnpm',
  [
    '--filter',
    '@lumibase/cms',
    'exec',
    'wrangler',
    'dev',
    '--port',
    String(PORT),
    '--inspector-port',
    '0',
    // Non-interactive: CI has no TTY, and without this wrangler waits on input.
    '--show-interactive-dev-session=false',
  ],
  {
    // `local` is wrangler's default, so no remote account/credentials are
    // needed — this runs on forked PRs and Dependabot branches too.
    env: { ...process.env, CI: '1', LUMIBASE_RUNTIME: 'cloudflare' },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

child.stdout.on('data', record);
child.stderr.on('data', record);

let exited = false;
let exitInfo = null;
child.on('exit', (code, signal) => {
  exited = true;
  exitInfo = { code, signal };
});

function fail(reason) {
  console.error(`\n[worker-startup] FAILED: ${reason}\n`);
  const log = output.join('');
  console.error('─── wrangler output ───');
  console.error(log.length > 20_000 ? `…${log.slice(-20_000)}` : log || '(no output)');
  console.error('───────────────────────');
  console.error(`
A Worker that builds but does not start almost always means a module threw at
top level. Look for code that runs at import time and needs something workerd
does not have: __dirname, a file:/// stack frame, fs access, a Node built-in
used as a value. \`pnpm build\` cannot catch this — it bundles without booting.

Also run: node scripts/check-worker-bundle.mjs`);
  if (!exited) child.kill('SIGTERM');
  process.exit(1);
}

async function probe() {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let lastError = 'never attempted';

  while (Date.now() < deadline) {
    if (exited) {
      fail(
        `wrangler exited before serving a request (code=${exitInfo?.code}, signal=${exitInfo?.signal})`,
      );
    }

    try {
      const response = await fetch(`http://127.0.0.1:${PORT}${PROBE_PATH}`, {
        signal: AbortSignal.timeout(5_000),
      });
      // Any status proves the Worker's module graph evaluated and the fetch
      // handler ran. Unhealthy dependencies are expected here.
      const body = await response.text().catch(() => '');
      console.log(
        `[worker-startup] OK — Worker booted and answered ${PROBE_PATH} with ${response.status}`,
      );
      if (body) console.log(`[worker-startup] body: ${body.slice(0, 300)}`);
      return;
    } catch (error) {
      lastError = error?.message ?? String(error);
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }

  fail(`no HTTP response from ${PROBE_PATH} within ${BOOT_TIMEOUT_MS} ms (last error: ${lastError})`);
}

try {
  await probe();
} finally {
  if (!exited) {
    child.kill('SIGTERM');
    // Give wrangler a moment to release the port before the job moves on.
    await Promise.race([once(child, 'exit'), new Promise((r) => setTimeout(r, 5_000))]);
  }
}

process.exit(0);
