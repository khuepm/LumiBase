/**
 * Earned-autonomy baseline for the `git-sync` agent role.
 *
 * Seeds conservative L1 (PROPOSE) grants for git-sync's write capabilities so
 * any autonomous action it later performs starts fully human-gated — matching
 * the Content-OS baseline (every (role, capability) starts at L1; operators
 * promote based on evidence). Idempotent via AutonomyService.setGrant (upsert).
 */
import type { Database } from '@lumibase/database';
import {
  AUTONOMY_LEVELS,
  AutonomyService,
} from '../../services/autonomy-service';

export const GIT_SYNC_ROLE = 'git-sync';

/** Capabilities git-sync may exercise that warrant an explicit autonomy grant. */
export const GIT_SYNC_GRANT_CAPABILITIES = ['items:write'] as const;

export async function ensureGitSyncAutonomyBaseline(
  db: Database,
  siteId: string,
): Promise<void> {
  const autonomy = new AutonomyService({ db, siteId });
  for (const capability of GIT_SYNC_GRANT_CAPABILITIES) {
    const existing = await autonomy.getGrantLevel(GIT_SYNC_ROLE, capability);
    if (existing !== null) continue; // don't override operator-set levels
    await autonomy.setGrant(GIT_SYNC_ROLE, capability, AUTONOMY_LEVELS.PROPOSE, {
      evidence: { source: 'git_integration_bootstrap' },
    });
  }
}
