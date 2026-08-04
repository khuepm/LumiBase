import { afterEach, describe, expect, it } from 'vitest';

import { D1SponsorStore, type D1DatabaseLike, type D1StatementLike } from './d1-store';
import {
  claimReward,
  configureSponsorStore,
  createSponsor,
  generateRewardToken,
  getAllSponsors,
  getSponsorByGitHubUser,
  getSponsorByToken,
  getSponsorStore,
  removeSponsor,
  resetSponsorStore,
  resolveSponsorStore,
} from './index';
import { InMemorySponsorStore } from './memory-store';
import {
  ALREADY_CLAIMED_ERROR,
  INVALID_TOKEN_ERROR,
  type SponsorStore,
} from './types';

// ---------------------------------------------------------------------------
// Fake D1 — enough of SQLite to execute the handful of statements the store
// issues, so D1SponsorStore runs against the same behavioural suite as the
// in-memory store instead of only asserting on query strings.
// ---------------------------------------------------------------------------

interface FakeRow {
  github_user: string;
  tier: number;
  reward_token: string;
  created_at: string;
  claimed: number;
  claimed_at: string | null;
}

class FakeD1 implements D1DatabaseLike {
  rows: FakeRow[] = [];
  queries: string[] = [];

  prepare(query: string): D1StatementLike {
    this.queries.push(query);
    return new FakeStatement(this, query.trim());
  }
}

class FakeStatement implements D1StatementLike {
  private values: unknown[] = [];

  constructor(
    private readonly db: FakeD1,
    private readonly query: string
  ) {}

  bind(...values: unknown[]): D1StatementLike {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return (this.exec().rows[0] as T) ?? null;
  }

  async all<T>(): Promise<{ results?: T[] }> {
    return { results: this.exec().rows as T[] };
  }

  async run(): Promise<{ meta?: { changes?: number } }> {
    return { meta: { changes: this.exec().changes } };
  }

  private exec(): { rows: unknown[]; changes: number } {
    if (this.query.startsWith('INSERT')) {
      const [githubUser, tier, rewardToken, createdAt] = this.values as [
        string,
        number,
        string,
        string,
      ];
      const row: FakeRow = {
        github_user: githubUser,
        tier,
        reward_token: rewardToken,
        created_at: createdAt,
        claimed: 0,
        claimed_at: null,
      };
      const index = this.db.rows.findIndex((r) => r.github_user === githubUser);
      if (index >= 0) {
        this.db.rows[index] = row;
      } else {
        this.db.rows.push(row);
      }
      return { rows: [], changes: 1 };
    }

    if (this.query.startsWith('UPDATE')) {
      const [token, claimedAt] = this.values as [string, string];
      const row = this.db.rows.find((r) => r.reward_token === token && r.claimed === 0);
      if (!row) {
        return { rows: [], changes: 0 };
      }
      row.claimed = 1;
      row.claimed_at = claimedAt;
      return { rows: [{ tier: row.tier }], changes: 1 };
    }

    if (this.query.startsWith('DELETE')) {
      const [githubUser] = this.values as [string];
      const before = this.db.rows.length;
      this.db.rows = this.db.rows.filter((r) => r.github_user !== githubUser);
      return { rows: [], changes: before - this.db.rows.length };
    }

    if (this.query.includes('reward_token = ?1')) {
      const [token] = this.values as [string];
      return { rows: this.db.rows.filter((r) => r.reward_token === token), changes: 0 };
    }

    if (this.query.includes('github_user = ?1')) {
      const [githubUser] = this.values as [string];
      return { rows: this.db.rows.filter((r) => r.github_user === githubUser), changes: 0 };
    }

    return {
      rows: [...this.db.rows].sort((a, b) => b.created_at.localeCompare(a.created_at)),
      changes: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Shared contract — every SponsorStore implementation must satisfy this.
// ---------------------------------------------------------------------------

function describeSponsorStore(name: string, create: () => SponsorStore) {
  describe(`${name} (SponsorStore contract)`, () => {
    it('persists a sponsor and reads it back by token and by user', async () => {
      const store = create();
      await store.save({ githubUser: 'octocat', tier: 1000, rewardToken: 'tok-a' });

      const byToken = await store.findByToken('tok-a');
      const byUser = await store.findByGitHubUser('octocat');

      expect(byToken).toMatchObject({ githubUser: 'octocat', tier: 1000, claimed: false });
      expect(byUser).toMatchObject({ githubUser: 'octocat', rewardToken: 'tok-a' });
      expect(byToken?.createdAt).toBeInstanceOf(Date);
    });

    it('returns null for unknown tokens and users', async () => {
      const store = create();

      expect(await store.findByToken('nope')).toBeNull();
      expect(await store.findByGitHubUser('nobody')).toBeNull();
    });

    it('claims a reward once and records the claim', async () => {
      const store = create();
      await store.save({ githubUser: 'octocat', tier: 2500, rewardToken: 'tok-a' });

      expect(await store.claim('tok-a')).toEqual({ success: true, tier: 2500 });

      const record = await store.findByToken('tok-a');
      expect(record?.claimed).toBe(true);
      expect(record?.claimedAt).toBeInstanceOf(Date);
    });

    it('rejects a second claim of the same token', async () => {
      const store = create();
      await store.save({ githubUser: 'octocat', tier: 500, rewardToken: 'tok-a' });

      await store.claim('tok-a');

      expect(await store.claim('tok-a')).toEqual({
        success: false,
        error: ALREADY_CLAIMED_ERROR,
      });
    });

    it('rejects an unknown token', async () => {
      const store = create();

      expect(await store.claim('tok-missing')).toEqual({
        success: false,
        error: INVALID_TOKEN_ERROR,
      });
    });

    it('lets exactly one of many concurrent claims succeed', async () => {
      const store = create();
      await store.save({ githubUser: 'octocat', tier: 500, rewardToken: 'tok-a' });

      const results = await Promise.all(
        Array.from({ length: 10 }, () => store.claim('tok-a'))
      );

      expect(results.filter((r) => r.success)).toHaveLength(1);
      expect(results.filter((r) => r.error === ALREADY_CLAIMED_ERROR)).toHaveLength(9);
    });

    it('replaces the record on re-sponsor, invalidating the old token', async () => {
      const store = create();
      await store.save({ githubUser: 'octocat', tier: 500, rewardToken: 'tok-old' });
      await store.claim('tok-old');

      await store.save({ githubUser: 'octocat', tier: 5000, rewardToken: 'tok-new' });

      expect(await store.findByToken('tok-old')).toBeNull();
      expect(await store.claim('tok-new')).toEqual({ success: true, tier: 5000 });
      expect(await store.list()).toHaveLength(1);
    });

    it('does not let callers mutate stored state through returned records', async () => {
      const store = create();
      await store.save({ githubUser: 'octocat', tier: 500, rewardToken: 'tok-a' });

      const record = await store.findByToken('tok-a');
      record!.claimed = true;

      expect((await store.findByToken('tok-a'))?.claimed).toBe(false);
      expect(await store.claim('tok-a')).toEqual({ success: true, tier: 500 });
    });

    it('lists and removes sponsors', async () => {
      const store = create();
      await store.save({ githubUser: 'octocat', tier: 500, rewardToken: 'tok-a' });
      await store.save({ githubUser: 'hubot', tier: 1500, rewardToken: 'tok-b' });

      expect(await store.list()).toHaveLength(2);
      expect(await store.remove('octocat')).toBe(true);
      expect(await store.remove('octocat')).toBe(false);

      const remaining = await store.list();
      expect(remaining.map((r) => r.githubUser)).toEqual(['hubot']);
      expect(await store.findByToken('tok-a')).toBeNull();
    });
  });
}

describeSponsorStore('InMemorySponsorStore', () => new InMemorySponsorStore());
describeSponsorStore('D1SponsorStore', () => new D1SponsorStore(new FakeD1()));

// ---------------------------------------------------------------------------
// D1-specific expectations
// ---------------------------------------------------------------------------

describe('D1SponsorStore', () => {
  it('guards the claim UPDATE with claimed = 0 so it is a compare-and-set', async () => {
    const db = new FakeD1();
    const store = new D1SponsorStore(db);
    await store.save({ githubUser: 'octocat', tier: 500, rewardToken: 'tok-a' });

    await store.claim('tok-a');

    const update = db.queries.find((q) => q.trim().startsWith('UPDATE'));
    expect(update).toBeDefined();
    expect(update).toContain('claimed = 0');
    expect(update).toContain('RETURNING tier');
  });

  it('maps stored 0/1 and ISO timestamps back to booleans and Dates', async () => {
    const db = new FakeD1();
    db.rows.push({
      github_user: 'octocat',
      tier: 1000,
      reward_token: 'tok-a',
      created_at: '2026-01-02T03:04:05.000Z',
      claimed: 1,
      claimed_at: '2026-01-03T00:00:00.000Z',
    });

    const record = await new D1SponsorStore(db).findByToken('tok-a');

    expect(record).toEqual({
      githubUser: 'octocat',
      tier: 1000,
      rewardToken: 'tok-a',
      createdAt: new Date('2026-01-02T03:04:05.000Z'),
      claimed: true,
      claimedAt: new Date('2026-01-03T00:00:00.000Z'),
    });
  });
});

// ---------------------------------------------------------------------------
// Module facade
// ---------------------------------------------------------------------------

describe('rewards module', () => {
  afterEach(() => {
    resetSponsorStore();
  });

  it('defaults to the in-memory store', () => {
    expect(getSponsorStore().kind).toBe('memory');
  });

  it('routes every helper through the configured store', async () => {
    const db = new FakeD1();
    configureSponsorStore(new D1SponsorStore(db));

    await createSponsor('octocat', 1000, 'tok-a');

    expect(getSponsorStore().kind).toBe('d1');
    expect(db.rows).toHaveLength(1);
    expect(await getSponsorByToken('tok-a')).toMatchObject({ githubUser: 'octocat' });
    expect(await getSponsorByGitHubUser('octocat')).toMatchObject({ tier: 1000 });
    expect(await getAllSponsors()).toHaveLength(1);
    expect(await claimReward('tok-a')).toEqual({ success: true, tier: 1000 });
    expect(await claimReward('tok-a')).toEqual({
      success: false,
      error: ALREADY_CLAIMED_ERROR,
    });
    expect(await removeSponsor('octocat')).toBe(true);
  });

  it('resolves a D1 store when the binding is present, otherwise in-memory', () => {
    expect(resolveSponsorStore({ SPONSORS_DB: new FakeD1() }).kind).toBe('d1');
    expect(resolveSponsorStore({}).kind).toBe('memory');
    expect(resolveSponsorStore().kind).toBe('memory');
  });

  it('generates unique 64-character hex tokens', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => generateRewardToken()));

    expect(tokens.size).toBe(100);
    for (const token of tokens) {
      // The claim page validates against this exact shape.
      expect(token).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});
