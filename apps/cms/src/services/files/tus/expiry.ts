/**
 * Expired resumable uploads (#704, TUS `expiration`): an upload that made no
 * progress for 24 hours is aborted — its storage multipart upload and buffered
 * tail are dropped so abandoned parts do not accumulate (R2 and S3 bill for
 * them). Cross-site system job; the state flip is a guarded UPDATE, so two
 * overlapping passes (Workers' cron has no leader lock) abort a session once.
 */
import type { Database } from '@lumibase/database';
import type { StorageProvider } from '@lumibase/runtime';
import { abortExpiredSession, expiredSessionsAcrossSites, type UploadSession } from './session-repo';
import { cleanupSessionStorage } from './tus-service';

export interface UploadExpiryDeps {
  db: Database;
  storage: StorageProvider;
  now?: () => Date;
  limit?: number;
  /** Test seams. */
  findExpired?: (now: Date, limit: number) => Promise<UploadSession[]>;
  abort?: (siteId: string, id: string) => Promise<boolean>;
}

export async function sweepExpiredUploads(deps: UploadExpiryDeps): Promise<{ expired: number }> {
  const now = deps.now?.() ?? new Date();
  const limit = deps.limit ?? 200;
  const rows = deps.findExpired ? await deps.findExpired(now, limit) : await expiredSessionsAcrossSites(deps.db, now, limit);
  let expired = 0;
  for (const session of rows) {
    const won = deps.abort ? await deps.abort(session.siteId, session.id) : await abortExpiredSession(deps.db, session.siteId, session.id);
    if (!won) continue;
    // The row was active when read, so its multipart upload is still open.
    await cleanupSessionStorage(deps.storage, session, false);
    expired++;
  }
  return { expired };
}
