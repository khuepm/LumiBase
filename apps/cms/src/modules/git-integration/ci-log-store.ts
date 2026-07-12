/**
 * CI log store — fetches CI logs through the provider and persists them to
 * runtime blob storage so they remain viewable after the provider expires the
 * originals. Reads prefer the stored copy.
 */
import type { Database } from '@lumibase/database';
import { gitCiRuns } from '@lumibase/database';
import type { StorageProvider } from '@lumibase/runtime';
import { and, eq } from 'drizzle-orm';
import type { GitProvider, RepoRef } from './providers/types';

export interface CiLogStoreDeps {
  db: Database;
  storage: StorageProvider;
  siteId: string;
  integrationId: string;
}

function logKey(siteId: string, integrationId: string, runId: string): string {
  return `git-ci-logs/${siteId}/${integrationId}/${runId}.log`;
}

async function readBody(
  body: ReadableStream | Buffer,
): Promise<string> {
  if (typeof (body as Buffer).byteLength === 'number' && Buffer.isBuffer(body)) {
    return (body as Buffer).toString('utf-8');
  }
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const ch of chunks) {
    merged.set(ch, offset);
    offset += ch.length;
  }
  return new TextDecoder().decode(merged);
}

/**
 * Return the stored log for a run, fetching + persisting it on first access.
 * `provider` + `repo` are used only when a fetch is required.
 */
export async function getOrFetchLog(
  deps: CiLogStoreDeps,
  provider: GitProvider,
  repo: RepoRef,
  runId: string,
  jobId?: string,
): Promise<string> {
  const [run] = await deps.db
    .select()
    .from(gitCiRuns)
    .where(
      and(
        eq(gitCiRuns.siteId, deps.siteId),
        eq(gitCiRuns.integrationId, deps.integrationId),
        eq(gitCiRuns.providerRunId, runId),
      ),
    )
    .limit(1);

  if (run?.logRef) {
    const obj = await deps.storage.get(run.logRef);
    if (obj) return readBody(obj.body);
  }

  const text = await provider.getJobLogs(repo, runId, jobId);
  const key = logKey(deps.siteId, deps.integrationId, runId);
  await deps.storage.put(key, Buffer.from(text, 'utf-8'), {
    contentType: 'text/plain',
  });
  if (run) {
    await deps.db
      .update(gitCiRuns)
      .set({ logRef: key, updatedAt: new Date() })
      .where(eq(gitCiRuns.id, run.id));
  }
  return text;
}
