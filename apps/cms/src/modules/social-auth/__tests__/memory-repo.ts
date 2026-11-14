import { emailRoot } from '../../email-identity/normalize';
import type { AccountRow, IdentityRepo, IdentityRow } from '../identity-service';
import type { SocialProfile } from '../providers';

/** In-memory {@link IdentityRepo}: the rule engine's oracle, matching emails by root mailbox. */
export class MemoryIdentityRepo implements IdentityRepo {
  users = new Map<string, AccountRow>();
  identities: IdentityRow[] = [];
  memberships = new Set<string>();
  studio = new Set<string>();
  private seq = 0;

  addUser(partial: Partial<AccountRow> & { email: string }): AccountRow {
    const id = partial.id ?? `usr_${++this.seq}`;
    const row = {
      id,
      externalId: null,
      passwordHash: null,
      emailCanonical: null,
      emailRoot: null,
      firstName: null,
      lastName: null,
      avatar: null,
      status: 'active',
      preferences: {},
      tfa: {},
      lastSeenAt: null,
      isBootstrap: false,
      lockedUntil: null,
      failedCount: 0,
      failedCountWindowStart: null,
      passwordChangedAt: null,
      tokenVersion: 0,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      ...partial,
    } as AccountRow;
    this.users.set(id, row);
    return row;
  }

  addIdentity(userId: string, issuer: string, subject: string): IdentityRow {
    const row = { id: `idn_${++this.seq}`, userId, issuer, subject, emailAtLink: null, createdAt: new Date(this.seq) };
    this.identities.push(row);
    return row;
  }

  async findIdentity(issuer: string, subject: string) {
    return this.identities.find((i) => i.issuer === issuer && i.subject === subject) ?? null;
  }
  async findUserById(userId: string) {
    return this.users.get(userId) ?? null;
  }
  async findUserByEmail(email: string) {
    return [...this.users.values()].find((u) => emailRoot(u.email) === emailRoot(email)) ?? null;
  }
  async hasStudioAccess(user: AccountRow) {
    return user.isBootstrap || this.studio.has(user.id);
  }
  async createAccount({ siteId, profile }: { siteId: string; profile: SocialProfile }) {
    if (await this.findUserByEmail(profile.email!)) return null;
    const user = this.addUser({ email: profile.email!, firstName: profile.firstName, lastName: profile.lastName, avatar: profile.avatar });
    this.memberships.add(`${user.id}|${siteId}`);
    const idn = this.addIdentity(user.id, profile.issuer, profile.subject);
    idn.emailAtLink = profile.email;
    return user;
  }
  async insertIdentity(userId: string, profile: SocialProfile) {
    if (await this.findIdentity(profile.issuer, profile.subject)) return false;
    this.addIdentity(userId, profile.issuer, profile.subject).emailAtLink = profile.email;
    return true;
  }
  async ensureMembership(userId: string, siteId: string) {
    this.memberships.add(`${userId}|${siteId}`);
  }
  async fillMissingProfile(userId: string, profile: SocialProfile) {
    const u = this.users.get(userId);
    if (!u) return null;
    const next = {
      ...u,
      firstName: u.firstName || profile.firstName,
      lastName: u.lastName || profile.lastName,
      avatar: u.avatar || profile.avatar,
    };
    this.users.set(userId, next);
    return next;
  }
  async listIdentities(userId: string) {
    return this.identities.filter((i) => i.userId === userId);
  }
  async deleteIdentity(userId: string, identityId: string) {
    const before = this.identities.length;
    this.identities = this.identities.filter((i) => !(i.id === identityId && i.userId === userId));
    return this.identities.length < before;
  }
}

export function profile(over: Partial<SocialProfile> = {}): SocialProfile {
  return {
    provider: 'google',
    issuer: 'https://accounts.google.com',
    subject: 'g-1',
    email: 'ann@example.com',
    emailVerified: true,
    firstName: 'Ann',
    lastName: 'Lee',
    avatar: null,
    ...over,
  };
}

export function appleProfile(over: Partial<SocialProfile> = {}): SocialProfile {
  return profile({ provider: 'apple', issuer: 'https://appleid.apple.com', subject: '000123.abc', firstName: null, lastName: null, ...over });
}
