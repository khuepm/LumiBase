/**
 * Webhook event processor — projects a verified event payload onto the cached
 * `git_pull_requests` / `git_ci_runs` rows. Idempotent: re-processing the same
 * event (replay) upserts to the same row rather than duplicating.
 */
import type { Database } from '@lumibase/database';
import { gitCiRuns, gitPullRequests } from '@lumibase/database';
import { sql } from 'drizzle-orm';
import type { WebhookProvider } from './verify';

export interface ProcessEventArgs {
  db: Database;
  siteId: string;
  integrationId: string;
  provider: WebhookProvider;
  event: string;
  payload: Record<string, unknown>;
}

function ghPrState(pr: Record<string, unknown>): string {
  if (pr.merged_at) return 'merged';
  return pr.state === 'open' ? 'open' : 'closed';
}

function glMrState(state: string): string {
  if (state === 'merged') return 'merged';
  return state === 'opened' ? 'open' : 'closed';
}

/** Apply one verified event. Returns true when it touched a cache row. */
export async function processEvent(args: ProcessEventArgs): Promise<boolean> {
  const { db, siteId, integrationId, provider, event, payload } = args;

  if (provider === 'github') {
    if (event === 'pull_request') {
      const pr = payload.pull_request as Record<string, unknown> | undefined;
      if (!pr) return false;
      await upsertPr(db, {
        siteId,
        integrationId,
        number: Number(pr.number),
        title: String(pr.title ?? ''),
        state: ghPrState(pr),
        headSha: String((pr.head as Record<string, unknown>)?.sha ?? ''),
        author: ((pr.user as Record<string, unknown>)?.login as string) ?? null,
        raw: pr,
      });
      return true;
    }
    if (event === 'workflow_run') {
      const run = payload.workflow_run as Record<string, unknown> | undefined;
      if (!run) return false;
      await upsertCiRun(db, {
        siteId,
        integrationId,
        providerRunId: String(run.id),
        status: mapGhRun(String(run.status), run.conclusion as string | null),
      });
      return true;
    }
    return false;
  }

  // GitLab
  if (event.toLowerCase().includes('merge request')) {
    const attrs = payload.object_attributes as Record<string, unknown> | undefined;
    if (!attrs) return false;
    await upsertPr(db, {
      siteId,
      integrationId,
      number: Number(attrs.iid),
      title: String(attrs.title ?? ''),
      state: glMrState(String(attrs.state ?? '')),
      headSha: String(
        (attrs.last_commit as Record<string, unknown>)?.id ?? attrs.sha ?? '',
      ),
      author: null,
      raw: attrs,
    });
    return true;
  }
  if (event.toLowerCase().includes('pipeline')) {
    const attrs = payload.object_attributes as Record<string, unknown> | undefined;
    if (!attrs) return false;
    await upsertCiRun(db, {
      siteId,
      integrationId,
      providerRunId: String(attrs.id),
      status: mapGlPipeline(String(attrs.status ?? '')),
    });
    return true;
  }
  return false;
}

async function upsertPr(
  db: Database,
  row: {
    siteId: string;
    integrationId: string;
    number: number;
    title: string;
    state: string;
    headSha: string;
    author: string | null;
    raw: Record<string, unknown>;
  },
): Promise<void> {
  await db
    .insert(gitPullRequests)
    .values({
      siteId: row.siteId,
      integrationId: row.integrationId,
      number: row.number,
      title: row.title,
      state: row.state,
      headSha: row.headSha,
      author: row.author,
      raw: row.raw,
    })
    .onConflictDoUpdate({
      target: [gitPullRequests.integrationId, gitPullRequests.number],
      set: {
        title: row.title,
        state: row.state,
        headSha: row.headSha,
        author: row.author,
        raw: row.raw,
        updatedAt: sql`now()`,
      },
    });
}

async function upsertCiRun(
  db: Database,
  row: {
    siteId: string;
    integrationId: string;
    providerRunId: string;
    status: string;
  },
): Promise<void> {
  await db
    .insert(gitCiRuns)
    .values({
      siteId: row.siteId,
      integrationId: row.integrationId,
      providerRunId: row.providerRunId,
      status: row.status,
    })
    .onConflictDoUpdate({
      target: [gitCiRuns.integrationId, gitCiRuns.providerRunId],
      set: { status: row.status, updatedAt: sql`now()` },
    });
}

function mapGhRun(status: string, conclusion: string | null): string {
  if (status === 'queued') return 'queued';
  if (status === 'in_progress') return 'in_progress';
  if (conclusion === 'success') return 'success';
  if (conclusion === 'cancelled') return 'cancelled';
  if (conclusion === 'failure' || conclusion === 'timed_out') return 'failure';
  return 'in_progress';
}

function mapGlPipeline(status: string): string {
  switch (status) {
    case 'success':
      return 'success';
    case 'failed':
      return 'failure';
    case 'canceled':
      return 'cancelled';
    case 'running':
      return 'in_progress';
    default:
      return 'queued';
  }
}
