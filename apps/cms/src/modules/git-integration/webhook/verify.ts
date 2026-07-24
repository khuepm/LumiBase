/**
 * Webhook verification helpers.
 *
 * A verify-only provider instance (no token, no network) is enough to check the
 * inbound signature — GitHub uses an HMAC-SHA256 of the body, GitLab a shared
 * token. Repo extraction lets the handler confirm the payload targets the
 * integration's repository.
 */
import { GitHubProvider } from '../providers/github';
import { GitLabProvider } from '../providers/gitlab';
import type {
  GitProvider,
  WebhookVerifyInput,
  WebhookVerifyResult,
} from '../providers/types';

export type WebhookProvider = 'github' | 'gitlab';

export function isWebhookProvider(v: string): v is WebhookProvider {
  return v === 'github' || v === 'gitlab';
}

/** Construct a provider used solely for signature verification (no token). */
function verifier(provider: WebhookProvider): GitProvider {
  return provider === 'github'
    ? new GitHubProvider({ token: '' })
    : new GitLabProvider({ token: '' });
}

export async function verifyWebhookSignature(
  provider: WebhookProvider,
  input: WebhookVerifyInput,
): Promise<WebhookVerifyResult> {
  return verifier(provider).verifyWebhook(input);
}

/** Lower-case every header name so lookups are case-insensitive. */
export function normalizeHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/** Best-effort extraction of `owner/repo` from a webhook payload. */
export function extractRepoFullName(
  provider: WebhookProvider,
  payload: unknown,
): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (provider === 'github') {
    const repo = p.repository as { full_name?: string } | undefined;
    return repo?.full_name ?? null;
  }
  const project = p.project as { path_with_namespace?: string } | undefined;
  return project?.path_with_namespace ?? null;
}
