/**
 * Coordination for the migration runner (`scripts/migrate.ts`, bundled as
 * `dist/migrate.cjs` in the image).
 *
 * 1. **Lock.** Drizzle's migrator reads the last applied row, then applies
 *    every newer migration in one transaction. Two runners started together
 *    (several web pods, an HPA scale-out, the entrypoint on two replicas) both
 *    read the same "last applied" row; because the bundled migrations are
 *    written to be re-runnable (`IF NOT EXISTS`), the second one can even
 *    succeed and record every migration twice. `withMigrationLock` takes a
 *    session-level Postgres advisory lock on a fixed key around the whole
 *    apply, so runners serialise: the first applies, the others then find
 *    nothing newer and exit 0. Postgres drops a session lock when its
 *    connection closes, so a killed runner never leaves the lock behind.
 *
 * 2. **Gate.** `waitForNoPendingMigrations` is the read-only side: it polls
 *    with backoff until the database has no migration pending for the bundled
 *    journal, so a process that must not run on an old schema (the worker)
 *    can wait for whichever runner applies it.
 *
 * 3. **Target.** `selectMigrations` / `materializeMigrationsFolder` stop the
 *    history at a given tag (`MIGRATE_TARGET`), for staged upgrades and for
 *    the CI test that upgrades a real schema from N-1 to N.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Advisory lock key every LumiBase migration runner takes: the ASCII bytes of
 * "LumiBase" read as a signed 64-bit integer (0x4c756d6942617365). Fixed and
 * documented so an operator can see who holds it:
 *
 *   SELECT pid FROM pg_locks WHERE locktype = 'advisory'
 *     AND classid = 1282764137 AND objid = 1113682789;
 */
export const MIGRATION_LOCK_KEY = '5509430018010346341';
/** High and low 32 bits of the key, as `pg_locks.classid` / `objid` show them. */
export const MIGRATION_LOCK_CLASSID = 0x4c756d69;
export const MIGRATION_LOCK_OBJID = 0x42617365;

/** The subset of a postgres.js client the lock needs (easy to fake in tests). */
export interface MigrationLockClient {
  unsafe(query: string, parameters?: unknown[]): PromiseLike<readonly Record<string, unknown>[]>;
}

export interface Clock {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export interface LockOptions extends Clock {
  /** Give up after this long without the lock (ms). */
  timeoutMs: number;
  /** Delay between attempts (ms). */
  pollMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** Thrown when another runner holds the lock for longer than `timeoutMs`. */
export class MigrationLockTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(
      `[migrate] Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the migration lock ` +
        `(pg advisory lock ${MIGRATION_LOCK_KEY}); another migration runner is still holding it.`,
    );
    this.name = 'MigrationLockTimeoutError';
  }
}

async function tryLock(client: MigrationLockClient): Promise<boolean> {
  const rows = await client.unsafe('SELECT pg_try_advisory_lock($1::bigint) AS locked', [MIGRATION_LOCK_KEY]);
  return rows[0]?.locked === true;
}

/**
 * Take the session-level migration lock, polling `pg_try_advisory_lock` so a
 * waiting runner can log and give up instead of blocking forever. The client
 * must keep one connection for the whole session (postgres.js `max: 1`), or
 * the unlock could run on a connection that never held the lock.
 */
export async function acquireMigrationLock(client: MigrationLockClient, options: LockOptions): Promise<void> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const log = options.log ?? (() => {});
  const pollMs = options.pollMs ?? 2000;
  const deadline = now() + options.timeoutMs;
  let announced = false;

  for (;;) {
    if (await tryLock(client)) {
      log(`[migrate] Holding the migration lock (pg advisory lock ${MIGRATION_LOCK_KEY}).`);
      return;
    }
    if (!announced) {
      log('[migrate] Another migration runner holds the lock; waiting for it to finish...');
      announced = true;
    }
    if (now() >= deadline) throw new MigrationLockTimeoutError(options.timeoutMs);
    await sleep(pollMs);
  }
}

export async function releaseMigrationLock(client: MigrationLockClient): Promise<void> {
  await client.unsafe('SELECT pg_advisory_unlock($1::bigint) AS unlocked', [MIGRATION_LOCK_KEY]);
}

/**
 * Run `fn` while holding the migration lock. Everything that decides what to
 * apply (history check, "last applied" read) must happen inside `fn`, so a
 * runner that waited sees what the previous holder committed.
 */
export async function withMigrationLock<T>(
  client: MigrationLockClient,
  fn: () => Promise<T>,
  options: LockOptions,
): Promise<T> {
  await acquireMigrationLock(client, options);
  try {
    return await fn();
  } finally {
    try {
      await releaseMigrationLock(client);
    } catch {
      // The connection is gone, and with it the session lock.
    }
  }
}

export interface WaitOptions extends Clock {
  timeoutMs: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * Poll `pendingTags` until it reports nothing pending. Errors (database not
 * up yet, schema table missing on a fresh database) count as "not yet".
 * Resolves true when the schema is current, false on timeout. Read-only.
 */
export async function waitForNoPendingMigrations(
  pendingTags: () => Promise<readonly string[]>,
  options: WaitOptions,
): Promise<boolean> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const log = options.log ?? (() => {});
  const maxDelay = options.maxDelayMs ?? 10_000;
  let delay = options.initialDelayMs ?? 1000;
  const deadline = now() + options.timeoutMs;
  let last = '';

  for (;;) {
    let line: string;
    try {
      const pending = await pendingTags();
      if (pending.length === 0) {
        log('[migrate] Schema is current: no pending migrations.');
        return true;
      }
      const shown = pending.length > 5 ? [...pending.slice(0, 2), '…', ...pending.slice(-2)] : pending;
      line = `[migrate] Waiting for ${pending.length} pending migration(s) to be applied: ${shown.join(', ')}`;
    } catch (err) {
      line = `[migrate] Waiting for the database: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (line !== last) {
      log(line);
      last = line;
    }
    const left = deadline - now();
    if (left <= 0) return false;
    await sleep(Math.min(delay, left));
    delay = Math.min(delay * 2, maxDelay);
  }
}

export interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

export interface MigrationMetadata extends JournalEntry {
  hash: string;
}

interface Journal {
  entries: JournalEntry[];
  [key: string]: unknown;
}

function readJournal(folder: string): Journal {
  const journalPath = path.join(folder, 'meta', '_journal.json');
  if (!fs.existsSync(journalPath)) {
    throw new Error(`Can't find ${journalPath}. Set MIGRATIONS_FOLDER when running outside the repo or Docker image root.`);
  }
  return JSON.parse(fs.readFileSync(journalPath, 'utf8')) as Journal;
}

/** Journal entries up to and including `target` (all of them when unset). */
export function selectMigrations(entries: readonly JournalEntry[], target?: string): JournalEntry[] {
  if (!target) return [...entries];
  const at = entries.findIndex((entry) => entry.tag === target);
  if (at < 0) {
    throw new Error(`[migrate] MIGRATE_TARGET=${target} is not a migration in the bundled journal.`);
  }
  return entries.slice(0, at + 1);
}

/** The bundled migrations (cut at `target`) with the hash Drizzle records. */
export function readLocalMigrations(folder: string, target?: string): MigrationMetadata[] {
  return selectMigrations(readJournal(folder).entries, target).map((entry) => {
    const sql = fs.readFileSync(path.join(folder, `${entry.tag}.sql`), 'utf8');
    return { ...entry, hash: crypto.createHash('sha256').update(sql).digest('hex') };
  });
}

/**
 * A migrations folder Drizzle can apply that stops at `target`: the journal
 * cut there and the same SQL files (so hashes match the full history). Written
 * under `tmpRoot` (the image's only writable path is /tmp). Without a target
 * the original folder is returned untouched.
 */
export function materializeMigrationsFolder(folder: string, target: string | undefined, tmpRoot: string): string {
  if (!target) return folder;
  const journal = readJournal(folder);
  const entries = selectMigrations(journal.entries, target);
  const out = fs.mkdtempSync(path.join(tmpRoot, 'lumibase-migrations-'));
  fs.mkdirSync(path.join(out, 'meta'));
  fs.writeFileSync(path.join(out, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }, null, 2));
  for (const entry of entries) {
    fs.copyFileSync(path.join(folder, `${entry.tag}.sql`), path.join(out, `${entry.tag}.sql`));
  }
  return out;
}

/**
 * Migrations Drizzle would still apply: those newer than the last applied
 * row (Drizzle compares `when` against the latest `created_at`, nothing else).
 */
export function pendingMigrations<T extends { when: number }>(
  local: readonly T[],
  lastAppliedCreatedAt: number | null,
): T[] {
  return local.filter((migration) => lastAppliedCreatedAt === null || migration.when > lastAppliedCreatedAt);
}
