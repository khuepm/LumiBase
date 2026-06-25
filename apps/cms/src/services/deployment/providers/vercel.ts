import type {
  DeploymentProvider,
  DeploymentRef,
  DeploymentStatus,
  InboundRequest,
  ProviderTarget,
  TriggerOptions,
} from './provider';
import { bearer, guardedFetch } from './http';

const API = 'https://api.vercel.com';

/**
 * Vercel adapter (design §4). Trigger via the REST deployments API, status &
 * logs via the deployment id. Token is a Vercel access token; `projectId` is
 * the Vercel project id.
 *
 * NOTE(owner=dev): Vercel API versions move; confirm the exact deployment /
 * events endpoints against the live API at implementation time (design §11).
 */

/** Map Vercel `readyState` → normalized status (design §3.3). */
export function mapVercelStatus(readyState: string | undefined): DeploymentStatus {
  switch ((readyState ?? '').toUpperCase()) {
    case 'QUEUED':
    case 'INITIALIZING':
      return 'queued';
    case 'BUILDING':
      return 'building';
    case 'READY':
      return 'ready';
    case 'CANCELED':
      return 'canceled';
    case 'ERROR':
    default:
      return (readyState ?? '').toUpperCase() === 'ERROR' ? 'error' : 'queued';
  }
}

function toRef(d: Record<string, unknown>): DeploymentRef {
  const status = mapVercelStatus(d['readyState'] as string | undefined);
  const meta = (d['meta'] ?? {}) as Record<string, unknown>;
  return {
    providerDeploymentId: String(d['uid'] ?? d['id'] ?? ''),
    status,
    url: d['url'] ? `https://${String(d['url'])}` : undefined,
    branch: meta['githubCommitRef'] as string | undefined,
    commitSha: meta['githubCommitSha'] as string | undefined,
    commitMessage: meta['githubCommitMessage'] as string | undefined,
    completedAt:
      status === 'ready' || status === 'error' || status === 'canceled' ? new Date() : undefined,
  };
}

export const vercelProvider: DeploymentProvider = {
  key: 'vercel',

  async verifyToken(token, target) {
    const res = await guardedFetch(`${API}/v9/projects/${encodeURIComponent(target.projectId)}`, {
      headers: bearer(token),
    });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'Invalid Vercel token.' };
    if (res.status === 404) return { ok: false, reason: 'Vercel project not found.' };
    return { ok: false, reason: `Vercel verify failed (${res.status}).` };
  },

  async trigger(token, target, opts: TriggerOptions) {
    const body = {
      name: target.projectId,
      project: target.projectId,
      target: 'production',
      gitSource: {
        ref: opts.branch ?? target.defaultBranch ?? undefined,
      },
    };
    const res = await guardedFetch(`${API}/v13/deployments`, {
      method: 'POST',
      headers: { ...bearer(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(
        `Vercel trigger failed (${res.status}): ${String((json['error'] as Record<string, unknown>)?.['message'] ?? '')}`,
      );
    }
    return toRef(json);
  },

  async getStatus(token, _target, providerDeploymentId) {
    const res = await guardedFetch(`${API}/v13/deployments/${encodeURIComponent(providerDeploymentId)}`, {
      headers: bearer(token),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(`Vercel status failed (${res.status}).`);
    return toRef(json);
  },

  async getLogs(token, _target, providerDeploymentId) {
    const res = await guardedFetch(
      `${API}/v3/deployments/${encodeURIComponent(providerDeploymentId)}/events`,
      { headers: bearer(token) },
    );
    if (!res.ok) throw new Error(`Vercel logs failed (${res.status}).`);
    const events = (await res.json().catch(() => [])) as Array<Record<string, unknown>>;
    return events
      .map((e) => String((e['payload'] as Record<string, unknown>)?.['text'] ?? e['text'] ?? ''))
      .filter(Boolean)
      .join('\n');
  },

  verifyWebhook(req: InboundRequest, secret: string) {
    // Vercel signs webhooks with an HMAC SHA1 in `x-vercel-signature`.
    // The full HMAC verification is performed in the service layer where the
    // crypto subtle API is awaited; here we do a presence + secret guard so
    // adapters stay synchronous. A missing signature is always rejected.
    const sig = req.headers['x-vercel-signature'];
    return Boolean(secret) && Boolean(sig);
  },

  parseWebhook(rawBody: string) {
    try {
      const evt = JSON.parse(rawBody) as Record<string, unknown>;
      const payload = (evt['payload'] ?? {}) as Record<string, unknown>;
      const deployment = (payload['deployment'] ?? {}) as Record<string, unknown>;
      const id = String(deployment['id'] ?? payload['deploymentId'] ?? '');
      if (!id) return null;
      const type = String(evt['type'] ?? '');
      const status: DeploymentStatus =
        type === 'deployment.ready'
          ? 'ready'
          : type === 'deployment.error'
            ? 'error'
            : type === 'deployment.canceled'
              ? 'canceled'
              : 'building';
      return {
        providerDeploymentId: id,
        status,
        url: deployment['url'] ? `https://${String(deployment['url'])}` : undefined,
        completedAt: status === 'building' ? undefined : new Date(),
      };
    } catch {
      return null;
    }
  },
};
