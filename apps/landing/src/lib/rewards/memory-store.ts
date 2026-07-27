import {
  ALREADY_CLAIMED_ERROR,
  INVALID_TOKEN_ERROR,
  type ClaimResult,
  type SponsorInput,
  type SponsorRecord,
  type SponsorStore,
} from './types';

function clone(record: SponsorRecord): SponsorRecord {
  return {
    ...record,
    createdAt: new Date(record.createdAt),
    claimedAt: record.claimedAt ? new Date(record.claimedAt) : undefined,
  };
}

/**
 * Process-local store, used for local dev and tests.
 *
 * Records live only in this process: they are lost on restart and not shared
 * between instances. Production deployments must configure a persistent store
 * instead — see `resolveSponsorStore()`.
 */
export class InMemorySponsorStore implements SponsorStore {
  readonly kind = 'memory' as const;

  private readonly byUser = new Map<string, SponsorRecord>();
  private readonly userByToken = new Map<string, string>();

  async save(input: SponsorInput): Promise<SponsorRecord> {
    const previous = this.byUser.get(input.githubUser);
    if (previous) {
      this.userByToken.delete(previous.rewardToken);
    }

    const record: SponsorRecord = {
      githubUser: input.githubUser,
      tier: input.tier,
      rewardToken: input.rewardToken,
      createdAt: new Date(),
      claimed: false,
    };

    this.byUser.set(record.githubUser, record);
    this.userByToken.set(record.rewardToken, record.githubUser);

    return clone(record);
  }

  async findByToken(token: string): Promise<SponsorRecord | null> {
    const record = this.lookupByToken(token);
    return record ? clone(record) : null;
  }

  async findByGitHubUser(githubUser: string): Promise<SponsorRecord | null> {
    const record = this.byUser.get(githubUser);
    return record ? clone(record) : null;
  }

  async claim(token: string): Promise<ClaimResult> {
    // Read and write happen in the same synchronous block with no `await`
    // between them, so the event loop cannot interleave a second claim of the
    // same token — this is the atomicity the SponsorStore contract requires.
    const record = this.lookupByToken(token);

    if (!record) {
      return { success: false, error: INVALID_TOKEN_ERROR };
    }

    if (record.claimed) {
      return { success: false, error: ALREADY_CLAIMED_ERROR };
    }

    record.claimed = true;
    record.claimedAt = new Date();

    return { success: true, tier: record.tier };
  }

  async list(): Promise<SponsorRecord[]> {
    return Array.from(this.byUser.values(), clone);
  }

  async remove(githubUser: string): Promise<boolean> {
    const record = this.byUser.get(githubUser);
    if (!record) {
      return false;
    }

    this.byUser.delete(githubUser);
    this.userByToken.delete(record.rewardToken);

    return true;
  }

  private lookupByToken(token: string): SponsorRecord | undefined {
    const githubUser = this.userByToken.get(token);
    return githubUser ? this.byUser.get(githubUser) : undefined;
  }
}
