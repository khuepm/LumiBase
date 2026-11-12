/**
 * Production image entrypoint (#734). Replaces `entrypoint.sh`: the runtime
 * image is distroless and has no shell.
 *
 *   1. Load `<NAME>_FILE` secrets.
 *   2. Fill in what a one-click platform deploy cannot (#741): the public
 *      origin for `CORS_ALLOWED_ORIGINS`. `ENCRYPTION_KEY` is never rewritten
 *      — the CDC registry derives its key from the string itself.
 *   3. In production, when the server is going to start, stop before touching
 *      the database if a required variable is missing or `ENCRYPTION_KEY` is
 *      one the server would reject. `MIGRATION_MODE=preflight|dry-run` never
 *      starts the server, so it needs only what the migration step needs.
 *   4. Run the migration preflight and migrations with exponential backoff
 *      (`SKIP_MIGRATIONS`, `RUN_MIGRATION_PREFLIGHT`, `MIGRATION_MODE` keep
 *      their old meaning).
 *   5. Load the server in this process, so it is PID 1's own code that
 *      receives SIGTERM — there is no shell in between to swallow it.
 *   6. Once the server answers, print the setup wizard URL while setup is
 *      still pending.
 *
 * Nothing here writes to disk: the image runs with a read-only root
 * filesystem.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  applyDefaultCorsOrigin,
  corsOriginsHaveNoHost,
  encryptionKeyProblem,
  exitsAfterPreflight,
  healthPort,
  loadSecretFiles,
  missingProductionVars,
  resolvePublicUrl,
} from './entrypoint-lib.mjs';

const log = (line) => console.log(`[entrypoint] ${line}`);
const fail = (line) => {
  console.error(`[entrypoint] ${line}`);
  process.exit(1);
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const appDir = process.cwd();
const migrateScript = resolve(appDir, 'dist/migrate.cjs');
const serverScript = resolve(appDir, 'dist/serve.cjs');
const env = process.env;

try {
  const loaded = loadSecretFiles(env);
  if (loaded.length > 0) log(`Loaded from *_FILE: ${loaded.join(', ')}`);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

const publicUrl = resolvePublicUrl(env);
const hostlessCors = corsOriginsHaveNoHost(env.CORS_ALLOWED_ORIGINS);
if (hostlessCors) {
  log(
    `CORS_ALLOWED_ORIGINS='${env.CORS_ALLOWED_ORIGINS}' names no host ` +
      '(a platform domain variable that was still empty?); ignoring it.',
  );
}
const corsOrigin = applyDefaultCorsOrigin(env, publicUrl);
if (corsOrigin) log(`CORS_ALLOWED_ORIGINS unset; using this deployment's origin ${corsOrigin}`);

// Preflight/dry-run exits after the migration check and never loads the
// server, so the server's own configuration is not required for it — the same
// contract `entrypoint.sh` had (`-e DATABASE_URL=… -e MIGRATION_MODE=preflight`).
if (!exitsAfterPreflight(env)) {
  const missing = missingProductionVars(env);
  if (missing.length > 0) {
    const corsHint =
      missing.includes('CORS_ALLOWED_ORIGINS') && hostlessCors
        ? ' Set CORS_ALLOWED_ORIGINS or LUMIBASE_PUBLIC_URL to this deployment\'s ' +
          'https:// origin, or enable the platform\'s public domain.'
        : '';
    fail(
      `Missing required production configuration: ${missing.join(', ')}. ` +
        'Generate secrets with `openssl rand -base64 48` (JWT_SECRET) and ' +
        '`openssl rand -base64 32` (ENCRYPTION_KEY); see ' +
        'docs/en/deployment/one-click.md for the per-platform command.' +
        corsHint,
    );
  }
  const keyProblem = encryptionKeyProblem(env);
  if (keyProblem) fail(keyProblem);
}

function runMigrate(command) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [migrateScript, command], { stdio: 'inherit', env });
    child.on('exit', (code) => done(code === 0));
    child.on('error', () => done(false));
  });
}

async function migrate() {
  if (env.SKIP_MIGRATIONS === 'true') {
    log('SKIP_MIGRATIONS=true, skipping database migrations.');
    return;
  }
  const maxRetries = 5;
  let backoffSeconds = 1;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let ok = true;
    let step = 'Migration';
    if (env.RUN_MIGRATION_PREFLIGHT !== 'false') {
      log('Running database migration preflight...');
      ok = await runMigrate('preflight');
      step = 'Migration preflight';
      if (ok && exitsAfterPreflight(env)) {
        log(`MIGRATION_MODE=${env.MIGRATION_MODE}; exiting after preflight without starting server.`);
        process.exit(0);
      }
    }
    if (ok) {
      log('Running database migrations...');
      step = 'Migration';
      ok = await runMigrate('apply');
      if (ok) {
        log('Migrations completed successfully.');
        return;
      }
    }
    if (attempt === maxRetries) fail(`${step} failed after ${maxRetries} attempts. Exiting.`);
    log(`${step} attempt ${attempt}/${maxRetries} failed. Retrying in ${backoffSeconds}s...`);
    await sleep(backoffSeconds * 1000);
    backoffSeconds *= 2;
  }
}

/**
 * Print where to finish setup, once, while the instance is uninitialized.
 * Best-effort and bounded: it never delays or fails the server.
 */
async function announceSetupWizard() {
  const role = (env.LUMIBASE_PROCESS_ROLE || 'all').toLowerCase();
  if (role === 'worker') return;
  const local = `http://127.0.0.1:${healthPort(env)}`;
  for (let attempt = 0; attempt < 30; attempt++) {
    await sleep(2000);
    try {
      const res = await fetch(`${local}/api/v1/setup/state`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) continue;
      const body = await res.json();
      if (body?.state !== 'uninitialized') return;
      const base = publicUrl ?? `http://localhost:${healthPort(env)}`;
      log(`Setup is pending. Open ${base}/setup to create the first admin account.`);
      if (body.requiresSetupToken) {
        log('The wizard asks for the SETUP_TOKEN printed once in this log above.');
      }
      return;
    } catch {
      // server not up yet
    }
  }
}

await migrate();
log('Starting server...');
createRequire(import.meta.url)(serverScript);
void announceSetupWizard();
