import crypto from 'crypto';

import { D1SponsorStore, type D1DatabaseLike } from './d1-store';
import { InMemorySponsorStore } from './memory-store';
import type { ClaimResult, SponsorRecord, SponsorStore } from './types';

export type { ClaimResult, SponsorInput, SponsorRecord, SponsorStore } from './types';
export type { D1DatabaseLike, D1StatementLike } from './d1-store';
export { D1SponsorStore, SPONSORS_TABLE, SPONSORS_TABLE_DDL } from './d1-store';
export { InMemorySponsorStore } from './memory-store';
export { ALREADY_CLAIMED_ERROR, INVALID_TOKEN_ERROR } from './types';

/** Bindings the rewards module can persist to. */
export interface RewardsEnv {
  /** Cloudflare D1 binding holding the `sponsors` table. */
  SPONSORS_DB?: D1DatabaseLike;
}

let activeStore: SponsorStore | null = null;

/**
 * Picks a store from the environment: the D1 binding when present, otherwise a
 * process-local store. Call this once at boot and hand the result to
 * `configureSponsorStore()` — see `apps/landing/README.md` for the wiring.
 */
export function resolveSponsorStore(env?: RewardsEnv): SponsorStore {
  if (env?.SPONSORS_DB) {
    return new D1SponsorStore(env.SPONSORS_DB);
  }

  if (process.env.NODE_ENV === 'production') {
    console.warn(
      '[rewards] No SPONSORS_DB binding found — falling back to the in-memory store. ' +
        'Sponsor records will be lost on restart and are not shared across instances.'
    );
  }

  return new InMemorySponsorStore();
}

/** Installs the store every rewards function reads and writes through. */
export function configureSponsorStore(store: SponsorStore): void {
  activeStore = store;
}

/** Returns the configured store, defaulting to a process-local one. */
export function getSponsorStore(): SponsorStore {
  if (!activeStore) {
    activeStore = new InMemorySponsorStore();
  }

  return activeStore;
}

/** Drops the configured store so the next access creates a fresh default. */
export function resetSponsorStore(): void {
  activeStore = null;
}

export function generateRewardToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** Persists a sponsorship and its reward token. */
export function createSponsor(
  githubUser: string,
  tier: number,
  rewardToken: string
): Promise<SponsorRecord> {
  return getSponsorStore().save({ githubUser, tier, rewardToken });
}

export function getSponsorByToken(token: string): Promise<SponsorRecord | null> {
  return getSponsorStore().findByToken(token);
}

export function getSponsorByGitHubUser(githubUser: string): Promise<SponsorRecord | null> {
  return getSponsorStore().findByGitHubUser(githubUser);
}

/**
 * Claims a reward token. Atomic: concurrent calls with the same token yield
 * exactly one success, the rest `Reward already claimed`.
 */
export function claimReward(token: string): Promise<ClaimResult> {
  return getSponsorStore().claim(token);
}

export function getAllSponsors(): Promise<SponsorRecord[]> {
  return getSponsorStore().list();
}

/** Removes a sponsorship, e.g. when GitHub reports a cancellation. */
export function removeSponsor(githubUser: string): Promise<boolean> {
  return getSponsorStore().remove(githubUser);
}
