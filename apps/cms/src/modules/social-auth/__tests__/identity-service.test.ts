import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { LEGACY_EXTERNAL_ID_ISSUER } from '@lumibase/database';
import { SocialAuthError } from '../errors';
import { linkIdentityToUser, resolveSocialLogin, toIdentityView, unlinkIdentity } from '../identity-service';
import { appleProfile, MemoryIdentityRepo, profile } from './memory-repo';

async function errCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(SocialAuthError);
    return (err as SocialAuthError).code;
  }
  throw new Error('expected a SocialAuthError');
}

describe('acceptance: returning Apple user keeps profile name', () => {
  it('persists the name sent on the first authorization and keeps it when later sign-ins carry none', async () => {
    const repo = new MemoryIdentityRepo();
    const first = await resolveSocialLogin(repo, {
      siteId: 'site_a',
      profile: appleProfile({ firstName: 'Jane', lastName: 'Appleseed' }),
    });
    expect(first.via).toBe('created');
    expect([first.user.firstName, first.user.lastName]).toEqual(['Jane', 'Appleseed']);

    // Second sign-in: Apple posts no `user` field → no name in the profile.
    const again = await resolveSocialLogin(repo, { siteId: 'site_a', profile: appleProfile() });
    expect(again.via).toBe('existing');
    expect(again.user.id).toBe(first.user.id);
    expect([again.user.firstName, again.user.lastName]).toEqual(['Jane', 'Appleseed']);
  });

  it('never overwrites a name the member already has', async () => {
    const repo = new MemoryIdentityRepo();
    const user = repo.addUser({ email: 'ann@example.com', firstName: 'Annie', lastName: 'L.' });
    repo.addIdentity(user.id, 'https://appleid.apple.com', '000123.abc');
    const out = await resolveSocialLogin(repo, {
      siteId: 'site_a',
      profile: appleProfile({ firstName: 'Provider', lastName: 'Name' }),
    });
    expect([out.user.firstName, out.user.lastName]).toEqual(['Annie', 'L.']);
  });
});

describe('acceptance: linking requires a verified email match', () => {
  it('links to an existing verified subscriber account when the provider verified the same address', async () => {
    const repo = new MemoryIdentityRepo();
    const user = repo.addUser({ email: 'ann@example.com', passwordHash: 'x' });
    const out = await resolveSocialLogin(repo, { siteId: 'site_a', profile: profile() });
    expect(out).toMatchObject({ via: 'linked', user: { id: user.id } });
    expect(repo.identities).toHaveLength(1);
    expect(repo.identities[0]).toMatchObject({ userId: user.id, issuer: 'https://accounts.google.com', subject: 'g-1', emailAtLink: 'ann@example.com' });
  });

  it('refuses when the provider does not assert the email is verified', async () => {
    const repo = new MemoryIdentityRepo();
    repo.addUser({ email: 'ann@example.com' });
    expect(await errCode(resolveSocialLogin(repo, { siteId: 'site_a', profile: profile({ emailVerified: false }) }))).toBe(
      'SOCIAL_EMAIL_UNVERIFIED',
    );
    expect(repo.identities).toHaveLength(0);
  });

  it('refuses when the existing account has not verified its own address', async () => {
    const repo = new MemoryIdentityRepo();
    repo.addUser({ email: 'ann@example.com', status: 'invited' });
    expect(await errCode(resolveSocialLogin(repo, { siteId: 'site_a', profile: profile() }))).toBe('LINK_REQUIRES_VERIFIED_ACCOUNT');
    expect(repo.identities).toHaveLength(0);
  });

  it('refuses automatic linking onto a staff account — sign in, then link', async () => {
    const repo = new MemoryIdentityRepo();
    const staff = repo.addUser({ email: 'ann@example.com' });
    repo.studio.add(staff.id);
    expect(await errCode(resolveSocialLogin(repo, { siteId: 'site_a', profile: profile() }))).toBe('LINK_REQUIRES_SIGN_IN');
    const boot = new MemoryIdentityRepo();
    boot.addUser({ email: 'ann@example.com', isBootstrap: true });
    expect(await errCode(resolveSocialLogin(boot, { siteId: 'site_a', profile: profile() }))).toBe('LINK_REQUIRES_SIGN_IN');
  });

  it('never creates an account from an unverified provider email', async () => {
    const repo = new MemoryIdentityRepo();
    expect(await errCode(resolveSocialLogin(repo, { siteId: 'site_a', profile: profile({ emailVerified: false }) }))).toBe(
      'SOCIAL_EMAIL_UNVERIFIED',
    );
    expect(repo.users.size).toBe(0);
  });

  it('requires an email to create or link', async () => {
    const repo = new MemoryIdentityRepo();
    expect(await errCode(resolveSocialLogin(repo, { siteId: 'site_a', profile: profile({ email: null }) }))).toBe('SOCIAL_EMAIL_MISSING');
  });

  it('property: auto-link happens iff provider-verified AND account-verified AND frontend-only', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.constantFrom('active', 'invited', 'suspended'),
        fc.boolean(),
        fc.boolean(),
        async (providerVerified, status, staff, bootstrap) => {
          const repo = new MemoryIdentityRepo();
          const user = repo.addUser({ email: 'ann@example.com', status, isBootstrap: bootstrap });
          if (staff) repo.studio.add(user.id);
          let linked = false;
          try {
            const out = await resolveSocialLogin(repo, { siteId: 's', profile: profile({ emailVerified: providerVerified }) });
            linked = out.via === 'linked' && out.user.id === user.id;
          } catch (err) {
            expect(err).toBeInstanceOf(SocialAuthError);
          }
          const expected = providerVerified && status === 'active' && !staff && !bootstrap;
          expect(linked).toBe(expected);
          expect(repo.identities.length).toBe(expected ? 1 : 0);
          expect(repo.users.size).toBe(1);
        },
      ),
      { numRuns: 64 },
    );
  });
});

describe('known identity', () => {
  it('refuses a suspended account', async () => {
    const repo = new MemoryIdentityRepo();
    const u = repo.addUser({ email: 'a@x.io', status: 'suspended' });
    repo.addIdentity(u.id, 'https://accounts.google.com', 'g-1');
    expect(await errCode(resolveSocialLogin(repo, { siteId: 's', profile: profile() }))).toBe('ACCOUNT_SUSPENDED');
  });

  it('signs in by (issuer, subject) even if the provider email changed', async () => {
    const repo = new MemoryIdentityRepo();
    const u = repo.addUser({ email: 'old@x.io' });
    repo.addIdentity(u.id, 'https://accounts.google.com', 'g-1');
    const out = await resolveSocialLogin(repo, { siteId: 'site_b', profile: profile({ email: 'new@x.io' }) });
    expect(out).toMatchObject({ via: 'existing', user: { id: u.id } });
    expect(repo.memberships.has(`${u.id}|site_b`)).toBe(true);
  });
});

describe('sign-in-then-link', () => {
  it('links a provider to the signed-in account even with a different email', async () => {
    const repo = new MemoryIdentityRepo();
    const u = repo.addUser({ email: 'staff@corp.io', passwordHash: 'x' });
    const out = await linkIdentityToUser(repo, { userId: u.id, profile: profile({ email: 'personal@gmail.com' }) });
    expect(out.status).toBe('linked');
    expect(await linkIdentityToUser(repo, { userId: u.id, profile: profile() })).toMatchObject({ status: 'already_linked' });
  });

  it('refuses an identity that belongs to another account', async () => {
    const repo = new MemoryIdentityRepo();
    const a = repo.addUser({ email: 'a@x.io' });
    const b = repo.addUser({ email: 'b@x.io' });
    repo.addIdentity(a.id, 'https://accounts.google.com', 'g-1');
    expect(await errCode(linkIdentityToUser(repo, { userId: b.id, profile: profile() }))).toBe('IDENTITY_ALREADY_LINKED');
  });
});

describe('unlink', () => {
  it('cannot unlink the last login method', async () => {
    const repo = new MemoryIdentityRepo();
    const u = repo.addUser({ email: 'a@x.io', passwordHash: null });
    const only = repo.addIdentity(u.id, 'https://accounts.google.com', 'g-1');
    expect(await errCode(unlinkIdentity(repo, { userId: u.id, identityId: only.id }))).toBe('LAST_LOGIN_METHOD');
    expect(repo.identities).toHaveLength(1);
  });

  it('can unlink when a password or another identity remains', async () => {
    const repo = new MemoryIdentityRepo();
    const u = repo.addUser({ email: 'a@x.io', passwordHash: null });
    const g = repo.addIdentity(u.id, 'https://accounts.google.com', 'g-1');
    repo.addIdentity(u.id, 'https://github.com', '42');
    await unlinkIdentity(repo, { userId: u.id, identityId: g.id });
    expect(repo.identities.map((i) => i.issuer)).toEqual(['https://github.com']);

    const withPw = new MemoryIdentityRepo();
    const p = withPw.addUser({ email: 'b@x.io', passwordHash: 'hash' });
    const only = withPw.addIdentity(p.id, 'https://github.com', '7');
    await unlinkIdentity(withPw, { userId: p.id, identityId: only.id });
    expect(withPw.identities).toHaveLength(0);
  });

  it('refuses the legacy external-JWT identity and other users’ identities', async () => {
    const repo = new MemoryIdentityRepo();
    const u = repo.addUser({ email: 'a@x.io', passwordHash: 'hash' });
    const other = repo.addUser({ email: 'b@x.io', passwordHash: 'hash' });
    const legacy = repo.addIdentity(u.id, LEGACY_EXTERNAL_ID_ISSUER, 'ext-1');
    const theirs = repo.addIdentity(other.id, 'https://github.com', '9');
    expect(await errCode(unlinkIdentity(repo, { userId: u.id, identityId: legacy.id }))).toBe('IDENTITY_MANAGED_EXTERNALLY');
    expect(await errCode(unlinkIdentity(repo, { userId: u.id, identityId: theirs.id }))).toBe('NOT_FOUND');
    expect(toIdentityView(legacy)).toMatchObject({ provider: 'external', unlinkable: false });
  });
});
