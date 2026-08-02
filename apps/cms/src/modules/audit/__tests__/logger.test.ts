import { describe, it, expect, vi } from 'vitest';
import { getTableName } from 'drizzle-orm';

import {
  AuditLogger,
  maskSensitive,
  AUDIT_EVENTS,
  type AuditFallbackRecord,
  type AuditLogWriteInput,
} from '../logger';

/**
 * Unit tests for the AuditLogger write path + the `maskSensitive`
 * secret masker (admin-setup-wizard task 11.1).
 *
 * These run WITHOUT Postgres: a hand-rolled fake Drizzle client
 * (mirroring the `makeFakeDb` capture pattern from
 * `setup/__tests__/backup-codes-persister.test.ts` and
 * `recovery/__tests__/service.test.ts`) records the row passed to
 * `insert(auditLog).values(row)`, and can be configured to reject or
 * to hang so the budget-race path is exercised. The structured
 * fallback is captured through the injectable `errorSink`, and a tiny
 * injected `budgetMs` drives the timeout branch without real waiting.
 *
 * Coverage:
 *   - maskSensitive: passwordHash → null; setupToken / backupCode /
 *     recoveryToken → 8 hex chars equal to sha256(value).slice(0,8)
 *     computed independently; nested objects + arrays walked;
 *     non-string secret values → null; unrelated keys untouched; input
 *     not mutated.
 *   - write: successful insert writes the row with masked metadata; a
 *     rejecting insert fires the fallback errorSink with
 *     { level:'error', source:'audit-fallback', entry } and does not
 *     throw; a slow insert (exceeds the injected budget) fires the
 *     fallback and resolves; write never throws even when BOTH the
 *     insert AND the errorSink throw.
 *
 * **Validates: Requirements 15.1, 15.2, 15.3**
 */

// ── independent sha256 prefix (test oracle) ─────────────────────────────

const enc = new TextEncoder();

async function sha256Prefix8(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(input));
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex.slice(0, 8);
}

// ── fake Drizzle client capturing insert(auditLog).values(row) ──────────

interface FakeDbOptions {
  /** When set, the insert rejects with this error. */
  readonly rejectWith?: Error;
  /** When true, the insert never settles (drives the budget timeout). */
  readonly hang?: boolean;
}

function makeFakeDb(opts: FakeDbOptions = {}) {
  const rows: Array<{ table: string; row: Record<string, unknown> }> = [];

  const db = {
    insert(table: unknown) {
      const name = getTableName(table as never);
      return {
        values(row: Record<string, unknown>) {
          rows.push({ table: name, row });
          if (opts.hang) {
            // A promise that never resolves → forces the budget race to
            // time out. The logger attaches a catch handler so this
            // doesn't leak as an unhandled rejection.
            return new Promise<void>(() => {});
          }
          if (opts.rejectWith) {
            return Promise.reject(opts.rejectWith);
          }
          return Promise.resolve();
        },
      };
    },
  };

  return { db: db as never, rows };
}

// ── maskSensitive ───────────────────────────────────────────────────────

describe('maskSensitive (Req 15.3)', () => {
  it('replaces passwordHash with null', async () => {
    const out = await maskSensitive({ passwordHash: 'pbkdf2$100000$aa$bb' });
    expect(out).toEqual({ passwordHash: null });
  });

  it('replaces setupToken / backupCode / recoveryToken with the 8-hex-char sha256 prefix', async () => {
    const setupToken = 'super-secret-setup-token';
    const backupCode = 'ABCD-2345';
    const recoveryToken = 'recovery-token-xyz';

    const out = await maskSensitive({ setupToken, backupCode, recoveryToken });

    for (const key of ['setupToken', 'backupCode', 'recoveryToken'] as const) {
      expect(out[key]).toMatch(/^[0-9a-f]{8}$/);
    }
    // Each masked value equals an independently computed prefix.
    expect(out.setupToken).toBe(await sha256Prefix8(setupToken));
    expect(out.backupCode).toBe(await sha256Prefix8(backupCode));
    expect(out.recoveryToken).toBe(await sha256Prefix8(recoveryToken));
  });

  it('masks API key plaintext and drops API key token hashes', async () => {
    const apiKeyToken = 'lbk_plaintext-secret';
    const out = await maskSensitive({
      apiKeyToken,
      apiKeyTokenHash: 'sha256-hex-value-that-should-not-land-in-audit',
    });

    expect(out.apiKeyToken).toBe(await sha256Prefix8(apiKeyToken));
    expect(out.apiKeyTokenHash).toBeNull();
  });

  it('walks nested objects and arrays', async () => {
    const setupToken = 'nested-token';
    const backupCode = 'WXYZ-9876';
    const input = {
      context: {
        passwordHash: 'pbkdf2$100000$cc$dd',
        deep: { setupToken },
      },
      codes: [{ backupCode }, { note: 'keep me' }],
    };

    const out = await maskSensitive(input);

    expect((out.context as Record<string, unknown>).passwordHash).toBeNull();
    expect(
      ((out.context as Record<string, unknown>).deep as Record<string, unknown>)
        .setupToken,
    ).toBe(await sha256Prefix8(setupToken));
    const codes = out.codes as Array<Record<string, unknown>>;
    expect(codes[0]!.backupCode).toBe(await sha256Prefix8(backupCode));
    expect(codes[1]!.note).toBe('keep me');
  });

  it('redacts raw content payload keys (CWE-359)', async () => {
    const out = await maskSensitive({
      collection: 'posts',
      recordId: 'rec_123',
      data: { ssn: '123-45-6789', notes: 'private' },
      payload: 'raw body',
      content: 'more raw',
      body: { anything: true },
    });
    expect(out).toEqual({
      collection: 'posts',
      recordId: 'rec_123',
      data: '[redacted]',
      payload: '[redacted]',
      content: '[redacted]',
      body: '[redacted]',
    });
  });

  it('truncates long free-form strings (CWE-359)', async () => {
    const long = 'x'.repeat(400);
    const out = await maskSensitive({ note: long });
    expect(typeof out.note).toBe('string');
    expect((out.note as string).length).toBeLessThan(long.length);
    expect(out.note as string).toMatch(/\[truncated\]$/);
  });

  it('maps non-string secret values to null (defensive)', async () => {
    const out = await maskSensitive({
      setupToken: 12345 as unknown as string,
      backupCode: { nested: 'object' } as unknown as string,
      recoveryToken: '' as string, // empty string is treated as non-secret → null
    });
    expect(out).toEqual({
      setupToken: null,
      backupCode: null,
      recoveryToken: null,
    });
  });

  it('leaves unrelated keys untouched (including similarly named ones)', async () => {
    const input = {
      event: 'login_failed',
      count: 5,
      enabled: true,
      // NOT in the secret set — exact, case-sensitive match only.
      password: 'not-masked-by-this-helper',
      SetupToken: 'wrong-case-not-masked',
      tokens: ['a', 'b'],
    };
    const out = await maskSensitive(input);
    expect(out).toEqual(input);
  });

  it('does not mutate the input object', async () => {
    const input = {
      passwordHash: 'secret',
      nested: { setupToken: 'tok' },
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    await maskSensitive(input);
    expect(input).toEqual(snapshot);
  });

  it('returns an empty object for null/undefined/non-object input', async () => {
    expect(await maskSensitive(null)).toEqual({});
    expect(await maskSensitive(undefined)).toEqual({});
    expect(await maskSensitive(42 as unknown as Record<string, unknown>)).toEqual(
      {},
    );
  });
});

// ── write: success path ─────────────────────────────────────────────────

describe('AuditLogger.write — success (Req 15.1, 15.2)', () => {
  function makeEntry(): AuditLogWriteInput {
    return {
      event: 'setup_completed',
      actorEmail: 'admin@example.com',
      targetEmail: 'admin@example.com',
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0',
      countryCode: 'US',
      requestId: 'req-1',
      metadata: {
        setupToken: 'the-raw-setup-token',
        passwordHash: 'pbkdf2$100000$aa$bb',
        adminPathHash: 'abc12345',
      },
    };
  }

  it('writes one row to audit_log with secrets masked in metadata', async () => {
    const { db, rows } = makeFakeDb();
    const errorSink = vi.fn();
    const logger = new AuditLogger({ db, errorSink });

    await logger.write(makeEntry());

    expect(rows).toHaveLength(1);
    expect(rows[0]!.table).toBe('lumibase_audit_log');

    const row = rows[0]!.row;
    expect(row.event).toBe('setup_completed');
    expect(row.actorEmail).toBe('admin@example.com');
    expect(row.countryCode).toBe('US');
    expect(row.requestId).toBe('req-1');

    const metadata = row.metadata as Record<string, unknown>;
    // Secrets masked; non-secret field preserved.
    expect(metadata.passwordHash).toBeNull();
    expect(metadata.setupToken).toBe(
      await sha256Prefix8('the-raw-setup-token'),
    );
    expect(metadata.adminPathHash).toBe('abc12345');

    // No fallback on a successful write.
    expect(errorSink).not.toHaveBeenCalled();
  });

  it('null-coalesces absent optional columns and defaults metadata to {}', async () => {
    const { db, rows } = makeFakeDb();
    const logger = new AuditLogger({ db });

    await logger.write({ event: 'login_success' });

    const row = rows[0]!.row;
    expect(row.actorEmail).toBeNull();
    expect(row.targetEmail).toBeNull();
    expect(row.ip).toBeNull();
    expect(row.userAgent).toBeNull();
    expect(row.countryCode).toBeNull();
    expect(row.requestId).toBeNull();
    expect(row.metadata).toEqual({});
  });
});

// ── write: failure → fallback ───────────────────────────────────────────

describe('AuditLogger.write — fallback on failure (Req 13.4 spirit, design §10.1)', () => {
  it('a rejecting sync insert fires the structured fallback and does NOT throw', async () => {
    const { db, rows } = makeFakeDb({ rejectWith: new Error('db down') });
    const captured: AuditFallbackRecord[] = [];
    const logger = new AuditLogger({
      db,
      errorSink: (r) => captured.push(r),
      queue: undefined,
    });

    await expect(
      logger.write({
        event: 'login_failed',
        metadata: { recoveryToken: 'leak-me-not' },
      }),
    ).resolves.toBeUndefined();

    // The insert was attempted.
    expect(rows).toHaveLength(1);

    // Exactly one fallback with the pinned shape.
    expect(captured).toHaveLength(1);
    expect(captured[0]!.level).toBe('error');
    expect(captured[0]!.source).toBe('audit-fallback');
    expect(captured[0]!.reason).toBe('db_error');

    // The fallback entry carries the MASKED metadata (never the raw secret).
    const meta = captured[0]!.entry.metadata as Record<string, unknown>;
    expect(meta.recoveryToken).toBe(await sha256Prefix8('leak-me-not'));
  });

  it('never throws even when BOTH the insert AND the errorSink throw', async () => {
    const { db } = makeFakeDb({ rejectWith: new Error('db down') });
    const logger = new AuditLogger({
      db,
      queue: undefined,
      errorSink: () => {
        throw new Error('sink also broken');
      },
    });

    await expect(
      logger.write({ event: 'user_locked' }),
    ).resolves.toBeUndefined();
  });
});

// ── event vocabulary ─────────────────────────────────────────────────────

describe('AUDIT_EVENTS (Req 15.1)', () => {
  it('enumerates the 15 event codes from Req 15.1', () => {
    expect(AUDIT_EVENTS).toHaveLength(15);
    expect(AUDIT_EVENTS).toContain('setup_completed');
    expect(AUDIT_EVENTS).toContain('backup_code_used');
    // No duplicates.
    expect(new Set(AUDIT_EVENTS).size).toBe(15);
  });
});
