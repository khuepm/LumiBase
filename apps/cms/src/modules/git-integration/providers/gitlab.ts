/**
 * GitLab adapter for {@link GitProvider}.
 *
 * Uses the GitLab REST API v4 (gitlab.com or self-managed). Merge requests are
 * normalised to the same PullRequest shape so callers never branch on provider.
 */
import {
  type CheckRun,
  type CommitStatus,
  type GitProvider,
  type ListPullRequestsOpts,
  ProviderApiError,
  ProviderUnsupportedError,
  type RepoRef,
  type WebhookVerifyInput,
  type WebhookVerifyResult,
} from './types';
import type {
  CiRunResource,
  PullRequestResource,
} from '@lumibase/shared/schemas';
import { constantTimeEqualStr } from '../webhook/constant-time';

const API_BASE = 'https://gitlab.com/api/v4';

export interface GitLabProviderOptions {
  token: string;
  fetchFn?: typeof fetch;
  baseUrl?: string;
}

/** GitLab addresses a project by URL-encoded `owner/repo` path. */
function projectId(repo: RepoRef): string {
  return encodeURIComponent(`${repo.owner}/${repo.repo}`);
}

export class GitLabProvider implements GitProvider {
  readonly name = 'gitlab' as const;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;

  constructor(opts: GitLabProviderOptions) {
    this.token = opts.token;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.baseUrl = opts.baseUrl ?? API_BASE;
  }

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        'PRIVATE-TOKEN': this.token,
        'Content-Type': 'application/json',
        'User-Agent': 'LumiBase',
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      throw new ProviderApiError(
        `GitLab API ${path} -> ${res.status}`,
        res.status,
      );
    }
    return (await res.json()) as T;
  }

  async listPullRequests(
    repo: RepoRef,
    opts?: ListPullRequestsOpts,
  ): Promise<PullRequestResource[]> {
    const state =
      opts?.state === 'closed'
        ? 'closed'
        : opts?.state === 'all'
          ? 'all'
          : 'opened';
    const perPage = Math.min(opts?.limit ?? 30, 100);
    const rows = await this.api<GitLabMr[]>(
      `/projects/${projectId(repo)}/merge_requests?state=${state}&per_page=${perPage}`,
    );
    return rows.map((r) => mapMr(r));
  }

  async getPullRequest(
    repo: RepoRef,
    number: number,
  ): Promise<PullRequestResource> {
    const r = await this.api<GitLabMr>(
      `/projects/${projectId(repo)}/merge_requests/${number}`,
    );
    return mapMr(r);
  }

  async listCheckRuns(repo: RepoRef, ref: string): Promise<CheckRun[]> {
    const statuses = await this.api<GitLabCommitStatus[]>(
      `/projects/${projectId(repo)}/repository/commits/${ref}/statuses`,
    );
    return statuses.map((s) => ({
      name: s.name,
      status: s.status,
      conclusion: s.status,
    }));
  }

  async getCiRun(repo: RepoRef, runId: string): Promise<CiRunResource> {
    const pipeline = await this.api<GitLabPipeline>(
      `/projects/${projectId(repo)}/pipelines/${runId}`,
    );
    const jobs = await this.api<GitLabJob[]>(
      `/projects/${projectId(repo)}/pipelines/${runId}/jobs`,
    );
    return {
      id: String(pipeline.id),
      providerRunId: String(pipeline.id),
      status: mapPipelineStatus(pipeline.status),
      jobs: jobs.map((j) => ({
        name: j.name,
        status: j.status,
        startedAt: j.started_at,
        completedAt: j.finished_at,
        durationMs: j.duration != null ? Math.round(j.duration * 1000) : null,
      })),
      durationMs: pipeline.duration != null ? pipeline.duration * 1000 : null,
      hasStoredLog: false,
    };
  }

  async getJobLogs(
    repo: RepoRef,
    _runId: string,
    jobId?: string,
  ): Promise<string> {
    if (!jobId) {
      // GitLab exposes logs (traces) per job, not per pipeline.
      throw new ProviderUnsupportedError('getJobLogs without jobId', this.name);
    }
    const res = await this.fetchFn(
      `${this.baseUrl}/projects/${projectId(repo)}/jobs/${jobId}/trace`,
      { headers: { 'PRIVATE-TOKEN': this.token, 'User-Agent': 'LumiBase' } },
    );
    if (!res.ok) {
      throw new ProviderApiError(
        `GitLab trace ${jobId} -> ${res.status}`,
        res.status,
      );
    }
    return await res.text();
  }

  async postCommitStatus(
    repo: RepoRef,
    sha: string,
    status: CommitStatus,
  ): Promise<void> {
    const state =
      status.state === 'success'
        ? 'success'
        : status.state === 'failure'
          ? 'failed'
          : 'pending';
    const params = new URLSearchParams({
      state,
      name: status.context,
      ...(status.description ? { description: status.description } : {}),
      ...(status.targetUrl ? { target_url: status.targetUrl } : {}),
    });
    await this.api(
      `/projects/${projectId(repo)}/statuses/${sha}?${params.toString()}`,
      { method: 'POST' },
    );
  }

  async getFileContents(
    repo: RepoRef,
    path: string,
    ref?: string,
  ): Promise<string | null> {
    const branch = ref ?? 'HEAD';
    try {
      const data = await this.api<{ content?: string; encoding?: string }>(
        `/projects/${projectId(repo)}/repository/files/${encodeURIComponent(
          path,
        )}?ref=${encodeURIComponent(branch)}`,
      );
      if (!data.content) return null;
      return data.encoding === 'base64'
        ? atob(data.content.replace(/\n/g, ''))
        : data.content;
    } catch (e) {
      if (e instanceof ProviderApiError && e.status === 404) return null;
      throw e;
    }
  }

  async verifyWebhook(input: WebhookVerifyInput): Promise<WebhookVerifyResult> {
    // GitLab uses a shared secret token (not an HMAC signature).
    const token =
      input.headers['x-gitlab-token'] ?? input.headers['X-Gitlab-Token'] ?? '';
    const valid = constantTimeEqualStr(token, input.secret);
    return {
      valid,
      event:
        input.headers['x-gitlab-event'] ??
        input.headers['X-Gitlab-Event'] ??
        null,
      deliveryId:
        input.headers['x-gitlab-event-uuid'] ??
        input.headers['X-Gitlab-Event-UUID'] ??
        null,
    };
  }
}

// ── provider payload shapes (only the fields we read) ─────────────────────

interface GitLabMr {
  iid: number;
  title: string;
  state: string;
  merge_status: string;
  sha: string;
  author: { username: string } | null;
  updated_at: string;
}

interface GitLabCommitStatus {
  name: string;
  status: string;
}

interface GitLabPipeline {
  id: number;
  status: string;
  duration: number | null;
}

interface GitLabJob {
  name: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  duration: number | null;
}

function mapMr(r: GitLabMr): PullRequestResource {
  return {
    id: String(r.iid),
    number: r.iid,
    title: r.title,
    state:
      r.state === 'merged' ? 'merged' : r.state === 'opened' ? 'open' : 'closed',
    ciStatus: 'unknown',
    mergeable: r.merge_status === 'can_be_merged',
    headSha: r.sha,
    author: r.author?.username ?? null,
    previewUrl: null,
    updatedAt: r.updated_at,
  };
}

function mapPipelineStatus(status: string): CiRunResource['status'] {
  switch (status) {
    case 'created':
    case 'waiting_for_resource':
    case 'preparing':
    case 'pending':
      return 'queued';
    case 'running':
      return 'in_progress';
    case 'success':
      return 'success';
    case 'canceled':
      return 'cancelled';
    case 'failed':
      return 'failure';
    default:
      return 'in_progress';
  }
}
