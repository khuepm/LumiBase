import { describe, expect, it } from 'vitest';
import type { Database } from '@lumibase/database';
import {
  hashRefreshToken,
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllRefreshTokens,
  refreshCookieSettings,
  refreshCsrfOk,
  pruneRefreshTokens,
  runScheduledRefreshTokenPrune,
} from '../refresh-token';

/**
 * Configurable in-memory Drizzle stub. Where-conditions are opaque SQL
 * objects we can't introspect, so we ignore them and drive behaviour from
 * the configured `selectRows` — asserting the control flow + the mutation
 * payloads (`set(...)`) instead.
 */
function fakeDb(opts: {
  selectRows?: unknown[];
  updateReturning?: unknown[];
}): { db: Database; calls: { inserts: any[]; updates: any[] } } {
  const calls = { inserts: [] as any[], updates: [] as any[] };
  let pendingInsert: any = null;
  let insertSeq = 0;

  const builder: any = {
    select: () => builder,
    from: () => builder,
    where: () => builder,
    limit: () => Promise.resolve(opts.selectRows ?? []),
    insert: () => builder,
    values: (v: any) => {
      pendingInsert = v;
      return builder;
    },
    update: () => builder,
    delete: () => builder,
    set: (s: any) => {
      calls.updates.push(s);
      return builder;
    },
    returning: () => {
      if (pendingInsert) {
        calls.inserts.push(pendingInsert);
        pendingInsert = null;
        return Promise.resolve([{ id: `tok_${++insertSeq}` }]);
      }
      return Promise.resolve(opts.updateReturning ?? []);
    },
    transaction: (cb: (tx: any) => unknown) => cb(builder),
    // awaitable for update-without-returning
    then: (resolve: (v: unknown) => void) => resolve(undefined),
  };
  return { db: builder as Database, calls };
}

describe('hashRefreshToken + issueRefreshToken', () => {
  it('hashes deterministically and distinguishes inputs', async () => {
    expect(await hashRefreshToken('abc')).toBe(await hashRefreshToken('abc'));
    expect(await hashRefreshToken('abc')).not.toBe(await hashRefreshToken('abd'));
    expect(await hashRefreshToken('abc')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('issues a unique secret and an expiry in the future', async () => {
    const { db, calls } = fakeDb({});
    const a = await issueRefreshToken(db, { siteId: 's1', userId: 'u1', audience: 'studio' }, undefined);
    const b = await issueRefreshToken(db, { siteId: 's1', userId: 'u1', audience: 'studio' }, undefined);
    expect(a.token).not.toBe(b.token);
    expect(a.expiresAt.getTime()).toBeGreaterThan(Date.now());
    // The stored row never contains the plaintext, only its hash.
    expect(calls.inserts[0].tokenHash).toBe(await hashRefreshToken(a.token));
    expect(JSON.stringify(calls.inserts[0])).not.toContain(a.token);
  });

  it('uses a longer default TTL for frontend than studio', async () => {
    const { db: ds } = fakeDb({});
    const studio = await issueRefreshToken(ds, { siteId: 's', userId: 'u', audience: 'studio' }, undefined);
    const { db: df } = fakeDb({});
    const frontend = await issueRefreshToken(df, { siteId: 's', userId: 'u', audience: 'frontend' }, undefined);
    expect(frontend.expiresAt.getTime()).toBeGreaterThan(studio.expiresAt.getTime());
  });
});

describe('rotateRefreshToken', () => {
  const live = {
    id: 'r1',
    userId: 'u1',
    audience: 'studio',
    familyId: 'fam1',
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
  };

  it('returns invalid when the token is unknown', async () => {
    const { db, calls } = fakeDb({ selectRows: [] });
    const out = await rotateRefreshToken(db, { rawToken: 'x', siteId: 's1' }, undefined);
    expect(out).toEqual({ ok: false, reason: 'invalid' });
    expect(calls.updates).toHaveLength(0);
  });

  it('detects reuse of a revoked token and revokes the family', async () => {
    const { db, calls } = fakeDb({ selectRows: [{ ...live, revokedAt: new Date() }] });
    const out = await rotateRefreshToken(db, { rawToken: 'x', siteId: 's1' }, undefined);
    expect(out).toEqual({ ok: false, reason: 'reuse' });
    // One update: the family-wide revoke.
    expect(calls.updates).toHaveLength(1);
    expect(calls.updates[0]).toHaveProperty('revokedAt');
    expect(calls.inserts).toHaveLength(0);
  });

  it('rejects (and retires) an expired token', async () => {
    const { db, calls } = fakeDb({
      selectRows: [{ ...live, expiresAt: new Date(Date.now() - 1000) }],
    });
    const out = await rotateRefreshToken(db, { rawToken: 'x', siteId: 's1' }, undefined);
    expect(out).toEqual({ ok: false, reason: 'expired' });
    expect(calls.updates).toHaveLength(1);
    expect(calls.inserts).toHaveLength(0);
  });

  it('rotates a live token: issues a successor and retires the old row', async () => {
    const { db, calls } = fakeDb({ selectRows: [live] });
    const out = await rotateRefreshToken(db, { rawToken: 'x', siteId: 's1' }, undefined);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.userId).toBe('u1');
      expect(out.audience).toBe('studio');
      expect(out.token).toBeTruthy();
    }
    // Successor inserted in the same family...
    expect(calls.inserts).toHaveLength(1);
    expect(calls.inserts[0].familyId).toBe('fam1');
    // ...and the presented row retired with a lineage pointer.
    expect(calls.updates).toHaveLength(1);
    expect(calls.updates[0]).toHaveProperty('revokedAt');
    expect(calls.updates[0]).toHaveProperty('replacedBy');
  });
});

describe('refreshCookieSettings (cross-domain)', () => {
  it('defaults to the safe same-site posture', () => {
    expect(refreshCookieSettings()).toEqual({ sameSite: 'Lax', secure: true });
    expect(refreshCookieSettings({})).toEqual({ sameSite: 'Lax', secure: true });
  });

  it('enables cross-site cookies with SameSite=None (case-insensitive) + Domain', () => {
    expect(
      refreshCookieSettings({ REFRESH_COOKIE_SAMESITE: 'none', REFRESH_COOKIE_DOMAIN: '.example.com' }),
    ).toEqual({ sameSite: 'None', secure: true, domain: '.example.com' });
  });

  it('forces Secure when SameSite=None even if secure is disabled', () => {
    expect(
      refreshCookieSettings({ REFRESH_COOKIE_SAMESITE: 'None', REFRESH_COOKIE_SECURE: 'false' }),
    ).toEqual({ sameSite: 'None', secure: true });
  });

  it('allows insecure cookies for local http dev (Lax + secure=false)', () => {
    expect(refreshCookieSettings({ REFRESH_COOKIE_SECURE: 'false' })).toEqual({
      sameSite: 'Lax',
      secure: false,
    });
  });

  it('accepts Strict and ignores an unknown value (falls back to Lax)', () => {
    expect(refreshCookieSettings({ REFRESH_COOKIE_SAMESITE: 'Strict' }).sameSite).toBe('Strict');
    expect(refreshCookieSettings({ REFRESH_COOKIE_SAMESITE: 'bogus' }).sameSite).toBe('Lax');
  });
});

describe('pruneRefreshTokens', () => {
  it('returns the number of swept rows', async () => {
    const { db } = fakeDb({ updateReturning: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
    expect(await pruneRefreshTokens(db)).toBe(3);
  });

  it('runScheduledRefreshTokenPrune never throws and reports the count', async () => {
    const { db } = fakeDb({ updateReturning: [{ id: 'a' }] });
    expect(await runScheduledRefreshTokenPrune(db)).toEqual({ deleted: 1 });

    const throwing = {
      delete: () => {
        throw new Error('db down');
      },
    } as unknown as import('@lumibase/database').Database;
    expect(await runScheduledRefreshTokenPrune(throwing)).toEqual({ deleted: 0 });
  });
});

describe('refreshCsrfOk', () => {
  it('exempts body-token and absent-token callers', () => {
    expect(refreshCsrfOk('body', undefined)).toBe(true);
    expect(refreshCsrfOk('none', undefined)).toBe(true);
  });

  it('requires a non-empty custom header for the cookie path', () => {
    expect(refreshCsrfOk('cookie', undefined)).toBe(false);
    expect(refreshCsrfOk('cookie', '   ')).toBe(false);
    expect(refreshCsrfOk('cookie', '1')).toBe(true);
  });
});

describe('revokeRefreshToken / revokeAllRefreshTokens', () => {
  it('returns true when the family was revoked', async () => {
    const { db } = fakeDb({ selectRows: [{ familyId: 'fam1' }], updateReturning: [{ id: 'r1' }] });
    expect(await revokeRefreshToken(db, 'x', 's1')).toBe(true);
  });

  it('returns false when the token is unknown', async () => {
    const { db } = fakeDb({ selectRows: [] });
    expect(await revokeRefreshToken(db, 'x', 's1')).toBe(false);
  });

  it('revokeAll issues a single bulk update', async () => {
    const { db, calls } = fakeDb({});
    await revokeAllRefreshTokens(db, 's1', 'u1');
    expect(calls.updates).toHaveLength(1);
    expect(calls.updates[0]).toHaveProperty('revokedAt');
  });
});
