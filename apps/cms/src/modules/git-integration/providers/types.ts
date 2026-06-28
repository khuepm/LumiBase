/**
 * Provider abstraction for Git hosts (GitHub / GitLab).
 *
 * Business logic depends ONLY on the {@link GitProvider} interface; concrete
 * adapters (`github.ts`, `gitlab.ts`) translate to each host's REST API.
 * See `.kiro/specs/git-integration/design.md` §5.
 */
import type {
  CiRunResource,
  PullRequestResource,
} from '@lumibase/shared/schemas';

/** A repository reference parsed from `owner/repo`. */
export interface RepoRef {
  /** Owner / org / group path, e.g. `acme` or `group/subgroup`. */
  owner: string;
  /** Repository (project) name. */
  repo: string;
}

/** Commit status / check-run posted back to the provider. */
export interface CommitStatus {
  state: 'pending' | 'success' | 'failure';
  /** Context / check name, e.g. `lumibase/content-validation`. */
  context: string;
  description?: string;
  targetUrl?: string;
}

export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface ListPullRequestsOpts {
  state?: 'open' | 'closed' | 'all';
  limit?: number;
}

/** Raw inbound request data handed to a provider for signature verification. */
export interface WebhookVerifyInput {
  /** Raw, unparsed request body (must be the exact bytes that were signed). */
  rawBody: string;
  headers: Record<string, string>;
  /** Decrypted webhook secret for the matched integration. */
  secret: string;
}

export interface WebhookVerifyResult {
  valid: boolean;
  /** Provider event name (`pull_request`, `workflow_run`, …). */
  event: string | null;
  /** Idempotency key from the provider, when present. */
  deliveryId: string | null;
}

/** Thrown by an adapter when a capability is not supported by that provider. */
export class ProviderUnsupportedError extends Error {
  readonly code = 'PROVIDER_UNSUPPORTED';
  constructor(method: string, provider: string) {
    super(`${provider} does not support ${method}`);
    this.name = 'ProviderUnsupportedError';
  }
}

/** Thrown when a provider API call fails (auth, rate-limit, network). */
export class ProviderApiError extends Error {
  readonly code = 'PROVIDER_API_ERROR';
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderApiError';
  }
}

/**
 * Uniform contract over GitHub / GitLab. Adapters normalise responses to the
 * shared resource shapes so the rest of the codebase never branches on
 * provider. `verifyWebhook` is synchronous-friendly (no network).
 */
export interface GitProvider {
  readonly name: 'github' | 'gitlab';
  listPullRequests(
    repo: RepoRef,
    opts?: ListPullRequestsOpts,
  ): Promise<PullRequestResource[]>;
  getPullRequest(repo: RepoRef, number: number): Promise<PullRequestResource>;
  listCheckRuns(repo: RepoRef, ref: string): Promise<CheckRun[]>;
  getCiRun(repo: RepoRef, runId: string): Promise<CiRunResource>;
  getJobLogs(repo: RepoRef, runId: string, jobId?: string): Promise<string>;
  postCommitStatus(
    repo: RepoRef,
    sha: string,
    status: CommitStatus,
  ): Promise<void>;
  getFileContents(
    repo: RepoRef,
    path: string,
    ref?: string,
  ): Promise<string | null>;
  verifyWebhook(input: WebhookVerifyInput): Promise<WebhookVerifyResult>;
}

/** Parse `owner/repo` (or `group/subgroup/repo`) into a {@link RepoRef}. */
export function parseRepoFullName(full: string): RepoRef {
  const trimmed = full.trim().replace(/^\/+|\/+$/g, '');
  const lastSlash = trimmed.lastIndexOf('/');
  if (lastSlash <= 0 || lastSlash === trimmed.length - 1) {
    throw new ProviderApiError(`Invalid repo "${full}"; expected owner/repo`);
  }
  return {
    owner: trimmed.slice(0, lastSlash),
    repo: trimmed.slice(lastSlash + 1),
  };
}
