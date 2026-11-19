import { describe, expect, it } from 'vitest';
import type { Database } from '@lumibase/database';
import { provisionExternalUser } from '../adapter';
import type { TrustedIssuer, VerifiedPrincipalDraft } from '../verifier';

/**
 * #861 sub-bug 1: SSO JIT provisioning only absorbed an `external_id` conflict.
 * An address taken by another account (an alias under `root`, or a strict-site
 * membership collision) raised 23505 out of the auth middleware as a 500.
 */

/** Shape postgres-js gives a unique violation, wrapped by drizzle in `cause`. */
function uniqueViolation(constraint: string): Error {
  return Object.assign(new Error('Failed query'), {
    cause: Object.assign(new Error('duplicate key value'), { code: '23505', constraint_name: constraint }),
  });
}

interface FakeOptions {
  existing?: { id: string; status: string };
  failUsersInsert?: Error;
  failMembershipInsert?: Error;
}

/** Minimal chainable stand-in for the Drizzle calls `provisionExternalUser` makes. */
function fakeDb(opts: FakeOptions) {
  const calls = { usersInserts: 0, membershipInserts: 0, transactions: 0 };
  let insertCount = 0;
  const select = () => ({
    from: () => ({
      where: () => ({ limit: async () => (opts.existing ? [opts.existing] : []) }),
    }),
  });
  const insert = () => {
    // First insert in a JIT run is `users`, the next is `user_sites`; with an
    // existing account the only insert is the membership.
    const isUsers = !opts.existing && insertCount === 0;
    insertCount += 1;
    if (isUsers) calls.usersInserts += 1;
    else calls.membershipInserts += 1;
    return {
      values: () => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (opts.failUsersInsert) throw opts.failUsersInsert;
            return [{ id: 'u_new' }];
          },
        }),
        onConflictDoUpdate: async () => {
          if (opts.failMembershipInsert) throw opts.failMembershipInsert;
        },
      }),
    };
  };
  const handle = { select, insert };
  const db = {
    ...handle,
    transaction: async <T>(fn: (tx: typeof handle) => Promise<T>): Promise<T> => {
      calls.transactions += 1;
      return fn(handle);
    },
  };
  return { db: db as unknown as Database, calls };
}

const issuer: TrustedIssuer = {
  id: 'iss_1',
  issuer: 'https://idp.example.com/',
  jwksUri: 'https://idp.example.com/jwks',
  discoveryUrl: null,
  audience: 'lumibase-api',
  algorithms: ['RS256'],
  claimMapping: { email: 'email', roles: 'roles', externalId: 'sub' },
  roleMapping: {},
  defaultRoleId: null,
  jitProvisioning: true,
  clockSkewSeconds: 60,
};

const draft: VerifiedPrincipalDraft = {
  externalId: 'idp|alice',
  email: 'alice+sso@corp.com',
  rawRoles: [],
  payload: {},
  issuerConfig: issuer,
};

const meta = { ip: null, userAgent: null, requestId: null };

describe('provisionExternalUser — email identity collisions (#861)', () => {
  it('JIT login with an alias of an existing account under root → 403 EMAIL_IDENTITY_CONFLICT, not a throw', async () => {
    const { db } = fakeDb({ failUsersInsert: uniqueViolation('users_email_canonical_unique') });
    await expect(provisionExternalUser(db, 'site_a', draft, ['role_1'], meta)).resolves.toEqual({
      error: '403',
      code: 'EMAIL_IDENTITY_CONFLICT',
    });
  });

  it('JIT membership refused by a strict site → 403 EMAIL_IDENTITY_CONFLICT, inside one transaction', async () => {
    const { db, calls } = fakeDb({ failMembershipInsert: uniqueViolation('user_sites_site_identity_unique') });
    await expect(provisionExternalUser(db, 'site_a', draft, ['role_1'], meta)).resolves.toEqual({
      error: '403',
      code: 'EMAIL_IDENTITY_CONFLICT',
    });
    // Account + membership commit together, so the refusal leaves no orphan.
    expect(calls.transactions).toBe(1);
    expect(calls.usersInserts).toBe(1);
    expect(calls.membershipInserts).toBe(1);
  });

  it('existing account whose membership a strict site refuses → 403 EMAIL_IDENTITY_CONFLICT', async () => {
    const { db } = fakeDb({
      existing: { id: 'u_1', status: 'active' },
      failMembershipInsert: uniqueViolation('user_sites_site_identity_unique'),
    });
    await expect(provisionExternalUser(db, 'site_a', draft, [], meta)).resolves.toEqual({
      error: '403',
      code: 'EMAIL_IDENTITY_CONFLICT',
    });
  });

  it('other database errors still propagate', async () => {
    const { db } = fakeDb({ failUsersInsert: Object.assign(new Error('boom'), { code: '57014' }) });
    await expect(provisionExternalUser(db, 'site_a', draft, [], meta)).rejects.toThrow('boom');
  });

  it('existing active account with no conflict resolves to its id', async () => {
    const { db } = fakeDb({ existing: { id: 'u_1', status: 'active' } });
    await expect(provisionExternalUser(db, 'site_a', draft, [], meta)).resolves.toEqual({ userId: 'u_1' });
  });
});
