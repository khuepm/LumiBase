/**
 * Concurrent migration runners against a real, fresh PostgreSQL database.
 *
 * Runs the real CLI (`scripts/migrate.ts`, what the image bundles as
 * `dist/migrate.cjs`) as separate processes, the way two web pods' init
 * containers or two entrypoint-mode replicas would. To make the race certain
 * rather than lucky, the test holds the migration lock itself until both
 * runners report they are waiting on it, then lets go.
 *
 * Skips without DATABASE_URL; CI's "DB integration suites" job runs it. The
 * role needs CREATEDB: each case works in its own throwaway database.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { nanoid } from 'nanoid';
import { MIGRATION_LOCK_KEY } from '../migration-runner';

const url = process.env.DATABASE_URL;
const pkg = fileURLToPath(new URL('../../', import.meta.url));
const tsx = path.join(pkg, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
const journal = JSON.parse(fs.readFileSync(path.join(pkg, 'drizzle', 'meta', '_journal.json'), 'utf8')) as {
  entries: { tag: string; when: number }[];
};
const ALL = journal.entries.length;
const PREVIOUS = journal.entries.at(-2)!.tag;

interface Run {
  code: Promise<number>;
  output: () => string;
}

function runMigrator(databaseUrl: string, args: string[], env: Record<string, string> = {}): Run {
  let out = '';
  const child = spawn(tsx, ['scripts/migrate.ts', ...args], {
    cwd: pkg,
    env: { ...process.env, DATABASE_URL: databaseUrl, MIGRATIONS_FOLDER: './drizzle', ...env },
  });
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const code = new Promise<number>((done) => child.on('exit', (c) => done(c ?? 1)));
  return { code, output: () => out };
}

async function until(check: () => boolean, what: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function withDatabase(base: string, name: string) {
  const u = new URL(base);
  u.pathname = `/${name}`;
  return u.toString();
}

describe.skipIf(!url)('migration runner concurrency (real PostgreSQL)', () => {
  const admin = url ? postgres(url, { max: 1, onnotice: () => {} }) : null;
  const created: string[] = [];

  async function freshDatabase() {
    const name = `lb_migrate_lock_${nanoid(10).toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
    await admin!.unsafe(`CREATE DATABASE "${name}"`);
    created.push(name);
    return withDatabase(url!, name);
  }

  async function migrationRows(databaseUrl: string) {
    const db = postgres(databaseUrl, { max: 1 });
    try {
      return await db<{ hash: string; created_at: string }[]>`
        SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`;
    } finally {
      await db.end();
    }
  }

  /** Start two runners while the test holds the lock; release once both wait. */
  async function racingPair(databaseUrl: string, env: Record<string, string> = {}) {
    const holder = postgres(databaseUrl, { max: 1 });
    try {
      const rows = await holder<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(${MIGRATION_LOCK_KEY}::bigint) AS locked`;
      expect(rows[0]?.locked).toBe(true);
      const runs = [runMigrator(databaseUrl, ['apply'], env), runMigrator(databaseUrl, ['apply'], env)];
      await until(
        () => runs.every((r) => r.output().includes('Another migration runner holds the lock')),
        'both runners to queue on the lock',
      );
      await holder`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY}::bigint)`;
      return Promise.all(runs.map(async (r) => ({ code: await r.code, output: r.output() })));
    } finally {
      await holder.end();
    }
  }

  beforeAll(async () => {
    await admin!`SELECT 1`;
  });

  afterAll(async () => {
    for (const name of created) await admin!.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin?.end();
  });

  it('two runners on a fresh database: both exit 0 and the schema is applied once', async () => {
    const db = await freshDatabase();
    const results = await racingPair(db);
    for (const r of results) expect(r.code, r.output).toBe(0);
    const applied = results.filter((r) => r.output.includes(`Applied ${ALL} migration(s)`));
    const idle = results.filter((r) => r.output.includes('Nothing to apply'));
    expect(applied).toHaveLength(1);
    expect(idle).toHaveLength(1);

    const rows = await migrationRows(db);
    expect(rows).toHaveLength(ALL);
    expect(new Set(rows.map((r) => r.hash)).size).toBe(ALL);
    expect(rows.map((r) => Number(r.created_at))).toEqual(journal.entries.map((e) => e.when));
  }, 180_000);

  it('upgrade N-1 → N: the wait gate holds until the racing runners finish', async () => {
    const db = await freshDatabase();
    const first = runMigrator(db, ['apply'], { MIGRATE_TARGET: PREVIOUS });
    expect(await first.code, first.output()).toBe(0);
    expect(await migrationRows(db)).toHaveLength(ALL - 1);

    // The gate for this image's journal reports the pending one and times out…
    const early = runMigrator(db, ['wait', '--timeout', '2']);
    expect(await early.code).toBe(1);
    expect(early.output()).toContain(journal.entries.at(-1)!.tag);
    // …but passes for a process pinned to the same target.
    const pinned = runMigrator(db, ['wait', '--timeout', '5'], { MIGRATE_TARGET: PREVIOUS });
    expect(await pinned.code, pinned.output()).toBe(0);

    const gate = runMigrator(db, ['wait', '--timeout', '120']);
    const results = await racingPair(db);
    for (const r of results) expect(r.code, r.output).toBe(0);
    expect(results.filter((r) => r.output.includes('Applied 1 migration(s)'))).toHaveLength(1);
    expect(results.filter((r) => r.output.includes('Nothing to apply'))).toHaveLength(1);
    expect(await gate.code, gate.output()).toBe(0);
    expect(gate.output()).toContain('no pending migrations');

    const rows = await migrationRows(db);
    expect(rows).toHaveLength(ALL);
    expect(new Set(rows.map((r) => r.hash)).size).toBe(ALL);
  }, 180_000);
});
