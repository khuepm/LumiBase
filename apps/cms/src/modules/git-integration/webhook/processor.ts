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

/** What the event touched, so the caller can drive preview / incident side-effects. */
export interface ProcessEventResult {
  pr?: { id: string; number: number; state: string; action: string };
  ci?: { providerRunId: string; status: string };
}

function ghPrState(pr: Record<string, unknown>): string {
  if (pr.merged_at) return 'merged';
  return pr.state === 'open' ? 'open' : 'closed';
}

function glMrState(state: string): string {
  if (state === 'merged') return 'merged';
  return state === 'opened' ? 'open' : 'closed';
}

/** Apply one verified event. Returns a descriptor of what it touched. */
export async function processEvent(
  args: ProcessEventArgs,
): Promise<ProcessEventResult> {
  const { db, siteId, integrationId, provider, event, payload } = args;

  if (provider === 'github') {
    if (event === 'pull_request') {
      const pr = payload.pull_request as Record<string, unknown> | undefined;
      if (!pr) return {};
      const state = ghPrState(pr);
      const id = await upsertPr(db, {
        siteId,
        integrationId,
        number: Number(pr.number),
        title: String(pr.title ?? ''),
        state,
        headSha: String((pr.head as Record<string, unknown>)?.sha ?? ''),
        author: ((pr.user as Record<string, unknown>)?.login as string) ?? null,
        raw: pr,
      });
      return {
        pr: { id, number: Number(pr.number), state, action: String(payload.action ?? '') },
      };
    }
    if (event === 'workflow_run') {
      const run = payload.workflow_run as Record<string, unknown> | undefined;
      if (!run) return {};
      const status = mapGhRun(String(run.status), run.conclusion as string | null);
      await upsertCiRun(db, {
        siteId,
        integrationId,
        providerRunId: String(run.id),
        status,
      });
      return { ci: { providerRunId: String(run.id), status } };
    }
    return {};
  }

  // GitLab
  if (event.toLowerCase().includes('merge request')) {
    const attrs = payload.object_attributes as Record<string, unknown> | undefined;
    if (!attrs) return {};
    const state = glMrState(String(attrs.state ?? ''));
    const id = await upsertPr(db, {
      siteId,
      integrationId,
      number: Number(attrs.iid),
      title: String(attrs.title ?? ''),
      state,
      headSha: String(
        (attrs.last_commit as Record<string, unknown>)?.id ?? attrs.sha ?? '',
      ),
      author: null,
      raw: attrs,
    });
    return {
      pr: { id, number: Number(attrs.iid), state, action: String(attrs.action ?? '') },
    };
  }
  if (event.toLowerCase().includes('pipeline')) {
    const attrs = payload.object_attributes as Record<string, unknown> | undefined;
    if (!attrs) return {};
    const status = mapGlPipeline(String(attrs.status ?? ''));
    await upsertCiRun(db, {
      siteId,
      integrationId,
      providerRunId: String(attrs.id),
      status,
    });
    return { ci: { providerRunId: String(attrs.id), status } };
  }
  return {};
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
): Promise<string> {
  const [out] = await db
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
    })
    .returning({ id: gitPullRequests.id });
  return out!.id;
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
