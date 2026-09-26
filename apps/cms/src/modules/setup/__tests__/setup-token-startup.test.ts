import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { getTableName, type Table } from 'drizzle-orm';
import type { Database } from '@lumibase/database';

import type { AppEnv } from '../../../env';
import { setupRouter, __resetSetupRateLimitForTests } from '../routes';
import {
  __resetSetupTokenPrintGuardForTests,
  isSetupTokenRequired,
  verifySetupToken,
} from '../setup-token';
import { CLEAR_SETUP_TOKEN_SQL, runSetupTokenStartup } from '../startup';

/**
 * The startup step that mints the setup token (Req 2.6, #470).
 *
 * #470 was "the function is correct, and nothing calls it": the mint helper
 * existed, the read side was fully wired, and with the flag on every
 * `/setup/complete` answered `SETUP_TOKEN_REQUIRED` forever. So these cases
 * drive `runSetupTokenStartup` — the function `serve.ts` awaits before it
 * listens (asserted by `setup-token-startup.wiring.test.ts`) — and never call
 * the helper directly.
 *
 * The fake database models only the `lumibase_system_state` singleton and the
 * write conditions of the helper. Whether those conditions hold under real
 * concurrency is Postgres's job, and is measured in
 * `setup-token-startup.db.integration.test.ts`.
 */

interface SystemStateRow {
  id: string;
  state: 'uninitialized' | 'initializing' | 'initialized';
  setupTokenHash: string | null;
}

interface FakeDb {
  readonly db: Database;
  row: SystemStateRow | undefined;
  readonly calls: string[];
}

function makeFakeDb(initial?: Partial<SystemStateRow>, opts: { failReads?: boolean } = {}): FakeDb {
  const fake: FakeDb = {
    db: undefined as unknown as Database,
    row: initial
      ? { id: 'singleton', state: 'uninitialized', setupTokenHash: null, ...initial }
      : undefined,
    calls: [],
  };

  const api = {
    select() {
      return {
        from(table: Table) {
          const name = getTableName(table);
          return {
            where() {
              return {
                async limit() {
                  fake.calls.push(`select:${name}`);
                  if (opts.failReads) throw new Error('connection refused');
                  if (name === 'lumibase_system_state') return fake.row ? [{ ...fake.row }] : [];
                  // `/setup/state` asks for a bootstrap user; this instance has none.
                  return [];
                },
              };
            },
          };
        },
      };
    },
    insert(table: Table) {
      return {
        values(values: SystemStateRow) {
          return {
            onConflictDoNothing() {
              return {
                async returning() {
                  fake.calls.push(`insert:${getTableName(table)}`);
                  if (fake.row) return [];
                  fake.row = { ...values };
                  return [{ id: values.id }];
                },
              };
            },
          };
        },
      };
    },
    update(table: Table) {
      return {
        set(patch: Partial<SystemStateRow>) {
          return {
            where() {
              return {
                async returning() {
                  fake.calls.push(`update:${getTableName(table)}`);
                  // Mirrors the helper's WHERE: singleton, no hash yet, not initialized.
                  const row = fake.row;
                  if (!row || row.setupTokenHash !== null || row.state === 'initialized') return [];
                  fake.row = { ...row, setupTokenHash: patch.setupTokenHash ?? null };
                  return [{ id: row.id }];
                },
              };
            },
          };
        },
      };
    },
  };

  (fake as { db: Database }).db = api as unknown as Database;
  return fake;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const TOKEN_LINE = /^\[lumibase-cms\] SETUP_TOKEN=(?<token>[A-Za-z0-9_-]+)$/;

function tokenLines(lines: string[]): string[] {
  return lines.filter((l) => l.includes('SETUP_TOKEN='));
}

async function boot(fake: FakeDb, env: Record<string, string | undefined>) {
  const log: string[] = [];
  const warn: string[] = [];
  const outcome = await runSetupTokenStartup({
    db: fake.db,
    env,
    log: (line) => log.push(line),
    warn: (line) => warn.push(line),
  });
  return { outcome, log, warn };
}

beforeEach(() => {
  __resetSetupTokenPrintGuardForTests();
  __resetSetupRateLimitForTests();
});

describe('runSetupTokenStartup — flag on, setup pending', () => {
  it('prints exactly one token line and stores the hash of that token', async () => {
    const fake = makeFakeDb();

    const { outcome, log, warn } = await boot(fake, { LUMIBASE_REQUIRE_SETUP_TOKEN: 'true' });

    expect(outcome).toBe('minted');
    expect(warn).toEqual([]);
    const lines = tokenLines(log);
    expect(lines).toHaveLength(1);
    const token = TOKEN_LINE.exec(lines[0]!)?.groups?.token;
    expect(token, `unexpected token line: ${lines[0]}`).toBeDefined();
    // ≥128 bits of entropy (Req 2.6): 24 random bytes → 32 base64url chars.
    expect(token!.length).toBeGreaterThanOrEqual(32);

    // The stored value is the hash, never the plaintext, and it is the hash
    // of *this* token — which is what `/setup/complete` will verify against.
    expect(fake.row?.setupTokenHash).toBe(await sha256Hex(token!));
    expect(fake.row?.setupTokenHash).not.toContain(token!);
    expect(await verifySetupToken(token!, fake.row?.setupTokenHash)).toBe(true);
    expect(fake.row?.state).toBe('uninitialized');
  });

  it('claims an existing hash-less row instead of inserting a second one', async () => {
    // `/setup/complete` creates the singleton without a hash, so a restart
    // after a refused setup attempt finds the row already there.
    const fake = makeFakeDb({ setupTokenHash: null });

    const { outcome, log } = await boot(fake, { LUMIBASE_REQUIRE_SETUP_TOKEN: 'true' });

    expect(outcome).toBe('minted');
    const token = TOKEN_LINE.exec(tokenLines(log)[0] ?? '')?.groups?.token;
    expect(await verifySetupToken(token ?? '', fake.row?.setupTokenHash)).toBe(true);
    expect(fake.calls).toContain('update:lumibase_system_state');
  });

  it.each(['true', '1', 'yes'])('treats %j as on, the same way the request path does', async (value) => {
    const fake = makeFakeDb();
    const { outcome, log } = await boot(fake, { LUMIBASE_REQUIRE_SETUP_TOKEN: value });
    expect(outcome).toBe('minted');
    expect(tokenLines(log)).toHaveLength(1);
  });

  it('fails the start with context when the database cannot be read', async () => {
    const fake = makeFakeDb(undefined, { failReads: true });
    await expect(boot(fake, { LUMIBASE_REQUIRE_SETUP_TOKEN: 'true' })).rejects.toThrow(
      /LUMIBASE_REQUIRE_SETUP_TOKEN is on but the setup token could not be issued: connection refused/,
    );
  });
});

describe('runSetupTokenStartup — nothing to mint', () => {
  it.each([undefined, '', 'false', '0', 'no', 'TRUE'])(
    'prints nothing and touches no table when the flag is %j',
    async (value) => {
      const fake = makeFakeDb();
      const { outcome, log, warn } = await boot(fake, { LUMIBASE_REQUIRE_SETUP_TOKEN: value });
      expect(outcome).toBe('not_required');
      expect(log).toEqual([]);
      expect(warn).toEqual([]);
      expect(fake.calls).toEqual([]);
      expect(fake.row).toBeUndefined();
    },
  );

  it('prints nothing and writes nothing once setup is complete', async () => {
    const fake = makeFakeDb({ state: 'initialized', setupTokenHash: null });
    const { outcome, log, warn } = await boot(fake, { LUMIBASE_REQUIRE_SETUP_TOKEN: 'true' });
    expect(outcome).toBe('already_initialized');
    expect(log).toEqual([]);
    expect(warn).toEqual([]);
    expect(fake.calls).toEqual(['select:lumibase_system_state']);
    expect(fake.row?.setupTokenHash).toBeNull();
  });

  it('does not reprint or replace a token issued by an earlier start, and says how to recover', async () => {
    const fake = makeFakeDb();
    const first = await boot(fake, { LUMIBASE_REQUIRE_SETUP_TOKEN: 'true' });
    const issuedHash = fake.row?.setupTokenHash;
    expect(first.outcome).toBe('minted');

    // A new process: the in-process guard starts clean, the stored hash does not.
    __resetSetupTokenPrintGuardForTests();
    const second = await boot(fake, { LUMIBASE_REQUIRE_SETUP_TOKEN: 'true' });

    expect(second.outcome).toBe('already_minted');
    expect(tokenLines(second.log)).toEqual([]);
    expect(fake.row?.setupTokenHash).toBe(issuedHash);
    // Silence here is how an operator who lost the first line ends up back
    // at #470, so the notice must carry the exact recovery statement.
    expect(second.warn).toHaveLength(1);
    expect(second.warn[0]).toContain(CLEAR_SETUP_TOKEN_SQL);
    expect(second.warn[0]).not.toMatch(/SETUP_TOKEN=/);
  });
});

describe('the side that checks and the side that mints agree on the flag', () => {
  // Before the shared parser, the request path accepted `1`/`yes` through its
  // own helper. Any divergence between the two readers recreates #470 for
  // that value: `/setup/state` demands a token that startup never printed.
  const values = [undefined, '', 'true', '1', 'yes', 'false', '0', 'no', 'TRUE', 'on'];

  it.each(values)('LUMIBASE_REQUIRE_SETUP_TOKEN=%j', async (value) => {
    const fake = makeFakeDb();
    const env = { LUMIBASE_REQUIRE_SETUP_TOKEN: value };

    const { outcome } = await boot(fake, env);
    const minted = outcome === 'minted';

    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('db', fake.db);
      await next();
    });
    app.route('/api/v1/setup', setupRouter);
    const res = await app.request(
      '/api/v1/setup/state',
      { headers: { 'cf-connecting-ip': '198.51.100.7' } },
      env as unknown as AppEnv['Bindings'],
    );
    const body = (await res.json()) as { state: string; requiresSetupToken: boolean };

    expect(res.status).toBe(200);
    expect(body.requiresSetupToken).toBe(minted);
    expect(isSetupTokenRequired(env)).toBe(minted);
  });
});

describe('where nothing minted a token (Cloudflare Workers)', () => {
  it('POST /setup/complete answers 503 SETUP_TOKEN_NOT_ISSUED with a message the operator can act on', async () => {
    type SetupOverride = NonNullable<AppEnv['Variables']['setupServiceOverride']>;
    const service: SetupOverride = {
      async complete() {
        return { ok: false, error: { code: 'SETUP_TOKEN_NOT_ISSUED' } };
      },
    };
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('db', makeFakeDb().db);
      c.set('requestId', 'req_not_issued');
      c.set('setupServiceOverride', service);
      await next();
    });
    app.route('/api/v1/setup', setupRouter);

    const res = await app.request(
      '/api/v1/setup/complete',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.8' },
        body: JSON.stringify({
          setupToken: 'guess',
          account: {
            email: 'admin@example.com',
            password: 'Sup3r$ecret!Pass',
            firstName: 'Ada',
            lastName: 'Lovelace',
          },
          adminPath: '/lumi-abc123',
        }),
      },
      { LUMIBASE_REQUIRE_SETUP_TOKEN: 'true' } as unknown as AppEnv['Bindings'],
    );
    const body = (await res.json()) as { errors: Array<{ code: string; message?: string }> };

    expect(res.status).toBe(503);
    expect(body.errors[0]?.code).toBe('SETUP_TOKEN_NOT_ISSUED');
    // Studio's wizard renders `errors[0].message` verbatim, so the message is
    // the only place the operator learns what to do.
    const message = body.errors[0]?.message ?? '';
    expect(message).toContain('LUMIBASE_REQUIRE_SETUP_TOKEN');
    expect(message).toMatch(/restart the CMS/);
    expect(message).toMatch(/Cloudflare Workers/);
  });
});
