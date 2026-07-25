/**
 * GitHub adapter for {@link GitProvider}.
 *
 * Uses the GitHub REST API (api.github.com). Network I/O goes through an
 * injectable `fetchFn` (defaults to the global `fetch`) so unit tests can
 * exercise the adapter without real HTTP.
 */
import { hmacSha256Hex } from '../../notifications/webhook-channel';
import {
  type CheckRun,
  type CommitStatus,
  type GitProvider,
  type ListPullRequestsOpts,
  ProviderApiError,
  type RepoRef,
  type WebhookVerifyInput,
  type WebhookVerifyResult,
} from './types';
import type {
  CiRunResource,
  PullRequestResource,
} from '@lumibase/shared/schemas';
import { constantTimeEqualStr } from '../webhook/constant-time';

const API_BASE = 'https://api.github.com';

export interface GitHubProviderOptions {
  /** Resolved access token (PAT, OAuth, or installation token). */
  token: string;
  fetchFn?: typeof fetch;
  /** Override base URL (GitHub Enterprise). */
  baseUrl?: string;
}

export class GitHubProvider implements GitProvider {
  readonly name = 'github' as const;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;

  constructor(opts: GitHubProviderOptions) {
    this.token = opts.token;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.baseUrl = opts.baseUrl ?? API_BASE;
  }

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'LumiBase',
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      throw new ProviderApiError(
        `GitHub API ${path} -> ${res.status}`,
        res.status,
      );
    }
    return (await res.json()) as T;
  }

  async listPullRequests(
    repo: RepoRef,
    opts?: ListPullRequestsOpts,
  ): Promise<PullRequestResource[]> {
    const state = opts?.state ?? 'open';
    const perPage = Math.min(opts?.limit ?? 30, 100);
    const rows = await this.api<GitHubPull[]>(
      `/repos/${repo.owner}/${repo.repo}/pulls?state=${state}&per_page=${perPage}`,
    );
    return rows.map((r) => mapPull(r));
  }

  async getPullRequest(
    repo: RepoRef,
    number: number,
  ): Promise<PullRequestResource> {
    const r = await this.api<GitHubPull>(
      `/repos/${repo.owner}/${repo.repo}/pulls/${number}`,
    );
    return mapPull(r);
  }

  async listCheckRuns(repo: RepoRef, ref: string): Promise<CheckRun[]> {
    const data = await this.api<{ check_runs: GitHubCheckRun[] }>(
      `/repos/${repo.owner}/${repo.repo}/commits/${ref}/check-runs`,
    );
    return data.check_runs.map((c) => ({
      name: c.name,
      status: c.status,
      conclusion: c.conclusion,
    }));
  }

  async getCiRun(repo: RepoRef, runId: string): Promise<CiRunResource> {
    const run = await this.api<GitHubWorkflowRun>(
      `/repos/${repo.owner}/${repo.repo}/actions/runs/${runId}`,
    );
    const jobsData = await this.api<{ jobs: GitHubJob[] }>(
      `/repos/${repo.owner}/${repo.repo}/actions/runs/${runId}/jobs`,
    );
    return {
      id: String(run.id),
      providerRunId: String(run.id),
      status: mapRunStatus(run.status, run.conclusion),
      jobs: jobsData.jobs.map((j) => ({
        name: j.name,
        status: j.conclusion ?? j.status,
        startedAt: j.started_at,
        completedAt: j.completed_at,
        durationMs:
          j.started_at && j.completed_at
            ? new Date(j.completed_at).getTime() -
              new Date(j.started_at).getTime()
            : null,
      })),
      durationMs: null,
      hasStoredLog: false,
    };
  }

  async getJobLogs(repo: RepoRef, runId: string): Promise<string> {
    // GitHub returns a 302 to a signed log archive (zip). The default fetch
    // follows redirects; we surface the raw text so the caller can store it.
    const res = await this.fetchFn(
      `${this.baseUrl}/repos/${repo.owner}/${repo.repo}/actions/runs/${runId}/logs`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'User-Agent': 'LumiBase',
        },
      },
    );
    if (!res.ok) {
      throw new ProviderApiError(
        `GitHub logs ${runId} -> ${res.status}`,
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
    await this.api(`/repos/${repo.owner}/${repo.repo}/statuses/${sha}`, {
      method: 'POST',
      body: JSON.stringify({
        state: status.state,
        context: status.context,
        description: status.description,
        target_url: status.targetUrl,
      }),
    });
  }

  async getFileContents(
    repo: RepoRef,
    path: string,
    ref?: string,
  ): Promise<string | null> {
    const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    try {
      const data = await this.api<{ content?: string; encoding?: string }>(
        `/repos/${repo.owner}/${repo.repo}/contents/${path}${q}`,
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
    const header =
      input.headers['x-hub-signature-256'] ??
      input.headers['X-Hub-Signature-256'] ??
      '';
    const expected = `sha256=${await hmacSha256Hex(input.secret, input.rawBody)}`;
    const valid = constantTimeEqualStr(header, expected);
    return {
      valid,
      event:
        input.headers['x-github-event'] ??
        input.headers['X-GitHub-Event'] ??
        null,
      deliveryId:
        input.headers['x-github-delivery'] ??
        input.headers['X-GitHub-Delivery'] ??
        null,
    };
  }
}

// ── provider payload shapes (only the fields we read) ─────────────────────

interface GitHubPull {
  number: number;
  title: string;
  state: string;
  merged_at: string | null;
  mergeable: boolean | null;
  head: { sha: string };
  user: { login: string } | null;
  updated_at: string;
}

interface GitHubCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

interface GitHubWorkflowRun {
  id: number;
  status: string;
  conclusion: string | null;
}

interface GitHubJob {
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
}

function mapPull(r: GitHubPull): PullRequestResource {
  return {
    id: String(r.number),
    number: r.number,
    title: r.title,
    state: r.merged_at ? 'merged' : r.state === 'open' ? 'open' : 'closed',
    ciStatus: 'unknown',
    mergeable: r.mergeable,
    headSha: r.head.sha,
    author: r.user?.login ?? null,
    previewUrl: null,
    updatedAt: r.updated_at,
  };
}

function mapRunStatus(
  status: string,
  conclusion: string | null,
): CiRunResource['status'] {
  if (status === 'queued') return 'queued';
  if (status === 'in_progress') return 'in_progress';
  if (conclusion === 'success') return 'success';
  if (conclusion === 'cancelled') return 'cancelled';
  if (conclusion === 'failure' || conclusion === 'timed_out') return 'failure';
  return 'in_progress';
}
