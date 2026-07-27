import {
  ALREADY_CLAIMED_ERROR,
  INVALID_TOKEN_ERROR,
  type ClaimResult,
  type SponsorInput,
  type SponsorRecord,
  type SponsorStore,
} from './types';

/**
 * Structural subset of Cloudflare D1 that this store needs.
 *
 * Declared locally so the landing app does not have to depend on
 * `@cloudflare/workers-types`; a real `D1Database` binding satisfies it.
 */
export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results?: T[] }>;
  run(): Promise<{ meta?: { changes?: number } }>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1StatementLike;
}

export const SPONSORS_TABLE = 'sponsors';

/** DDL for the backing table — kept in sync with `migrations/0001_sponsors.sql`. */
export const SPONSORS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS ${SPONSORS_TABLE} (
  github_user  TEXT    PRIMARY KEY,
  tier         INTEGER NOT NULL,
  reward_token TEXT    NOT NULL UNIQUE,
  created_at   TEXT    NOT NULL,
  claimed      INTEGER NOT NULL DEFAULT 0,
  claimed_at   TEXT
);
`.trim();

interface SponsorRow {
  github_user: string;
  tier: number;
  reward_token: string;
  created_at: string;
  claimed: number;
  claimed_at: string | null;
}

const SELECT_COLUMNS =
  'github_user, tier, reward_token, created_at, claimed, claimed_at';

function toRecord(row: SponsorRow): SponsorRecord {
  return {
    githubUser: row.github_user,
    tier: Number(row.tier),
    rewardToken: row.reward_token,
    createdAt: new Date(row.created_at),
    claimed: Boolean(row.claimed),
    claimedAt: row.claimed_at ? new Date(row.claimed_at) : undefined,
  };
}

/**
 * Cloudflare D1 (SQLite) backed store — the persistent option for deployed
 * environments. Records survive restarts and are shared across instances.
 */
export class D1SponsorStore implements SponsorStore {
  readonly kind = 'd1' as const;

  constructor(private readonly db: D1DatabaseLike) {}

  async save(input: SponsorInput): Promise<SponsorRecord> {
    const createdAt = new Date();

    // GitHub re-sends `sponsorship` events (e.g. on tier changes) and the
    // webhook mints a fresh token each time, so an existing row is replaced
    // and its claim state reset — the previous token stops working.
    await this.db
      .prepare(
        `INSERT INTO ${SPONSORS_TABLE} (${SELECT_COLUMNS})
         VALUES (?1, ?2, ?3, ?4, 0, NULL)
         ON CONFLICT(github_user) DO UPDATE SET
           tier = excluded.tier,
           reward_token = excluded.reward_token,
           created_at = excluded.created_at,
           claimed = 0,
           claimed_at = NULL`
      )
      .bind(input.githubUser, input.tier, input.rewardToken, createdAt.toISOString())
      .run();

    return {
      githubUser: input.githubUser,
      tier: input.tier,
      rewardToken: input.rewardToken,
      createdAt,
      claimed: false,
    };
  }

  async findByToken(token: string): Promise<SponsorRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM ${SPONSORS_TABLE} WHERE reward_token = ?1 LIMIT 1`
      )
      .bind(token)
      .first<SponsorRow>();

    return row ? toRecord(row) : null;
  }

  async findByGitHubUser(githubUser: string): Promise<SponsorRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM ${SPONSORS_TABLE} WHERE github_user = ?1 LIMIT 1`
      )
      .bind(githubUser)
      .first<SponsorRow>();

    return row ? toRecord(row) : null;
  }

  async claim(token: string): Promise<ClaimResult> {
    // The `claimed = 0` guard makes this a compare-and-set inside a single
    // SQL statement: of N concurrent claims for the same token, only one can
    // match an unclaimed row, so only one gets a RETURNING row back.
    const claimed = await this.db
      .prepare(
        `UPDATE ${SPONSORS_TABLE}
            SET claimed = 1, claimed_at = ?2
          WHERE reward_token = ?1 AND claimed = 0
       RETURNING tier`
      )
      .bind(token, new Date().toISOString())
      .first<{ tier: number }>();

    if (claimed) {
      return { success: true, tier: Number(claimed.tier) };
    }

    // No row updated: either the token does not exist, or it was already
    // claimed (possibly by the request that raced us).
    const existing = await this.findByToken(token);

    return existing
      ? { success: false, error: ALREADY_CLAIMED_ERROR }
      : { success: false, error: INVALID_TOKEN_ERROR };
  }

  async list(): Promise<SponsorRecord[]> {
    const { results } = await this.db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM ${SPONSORS_TABLE} ORDER BY created_at DESC`)
      .all<SponsorRow>();

    return (results ?? []).map(toRecord);
  }

  async remove(githubUser: string): Promise<boolean> {
    const { meta } = await this.db
      .prepare(`DELETE FROM ${SPONSORS_TABLE} WHERE github_user = ?1`)
      .bind(githubUser)
      .run();

    return (meta?.changes ?? 0) > 0;
  }
}
