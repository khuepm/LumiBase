/**
 * A persisted GitHub Sponsors reward record.
 *
 * `tier` is the sponsorship's monthly price in cents, exactly as GitHub sends
 * it on the `sponsorship` webhook payload.
 */
export interface SponsorRecord {
  githubUser: string;
  tier: number;
  rewardToken: string;
  createdAt: Date;
  claimed: boolean;
  claimedAt?: Date;
}

/** The fields a caller supplies when recording a new sponsorship. */
export interface SponsorInput {
  githubUser: string;
  tier: number;
  rewardToken: string;
}

export interface ClaimResult {
  success: boolean;
  tier?: number;
  error?: string;
}

/**
 * Storage contract for sponsor reward tokens.
 *
 * Every read and write in the rewards module goes through one of these, so
 * swapping the backing store (in-memory for dev, D1 for production) never
 * changes call sites.
 */
export interface SponsorStore {
  /** Identifies the backing implementation — used for diagnostics/logging. */
  readonly kind: 'memory' | 'd1';

  /**
   * Records a sponsorship, replacing any existing record for the same GitHub
   * user (GitHub re-sends `sponsorship` events on tier changes, and the
   * webhook mints a fresh token each time). The replacement resets the claim
   * state, since the old token is no longer valid.
   */
  save(input: SponsorInput): Promise<SponsorRecord>;

  findByToken(token: string): Promise<SponsorRecord | null>;

  findByGitHubUser(githubUser: string): Promise<SponsorRecord | null>;

  /**
   * Atomically flips `claimed` from false to true.
   *
   * Implementations MUST guarantee that, given N concurrent calls with the
   * same valid token, exactly one resolves with `success: true` — a reward can
   * never be claimed twice.
   */
  claim(token: string): Promise<ClaimResult>;

  list(): Promise<SponsorRecord[]>;

  /** Removes a sponsorship (cancellation). Returns false if it was unknown. */
  remove(githubUser: string): Promise<boolean>;
}

export const INVALID_TOKEN_ERROR = 'Invalid reward token';
export const ALREADY_CLAIMED_ERROR = 'Reward already claimed';
