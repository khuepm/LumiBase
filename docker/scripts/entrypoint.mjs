/**
 * Production image entrypoint (#734). Replaces `entrypoint.sh`: the runtime
 * image is distroless and has no shell.
 *
 *   1. Load `<NAME>_FILE` secrets.
 *   2. Run the migration preflight and migrations with exponential backoff
 *      (`SKIP_MIGRATIONS`, `RUN_MIGRATION_PREFLIGHT`, `MIGRATION_MODE` keep
 *      their old meaning).
 *   3. Load the server in this process, so it is PID 1's own code that
 *      receives SIGTERM — there is no shell in between to swallow it.
 *
 * Nothing here writes to disk: the image runs with a read-only root
 * filesystem.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { loadSecretFiles } from './entrypoint-lib.mjs';

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
      if (ok && (env.MIGRATION_MODE === 'preflight' || env.MIGRATION_MODE === 'dry-run')) {
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

await migrate();
log('Starting server...');
createRequire(import.meta.url)(serverScript);
