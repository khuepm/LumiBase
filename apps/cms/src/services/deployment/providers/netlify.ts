import type {
  DeploymentProvider,
  DeploymentRef,
  DeploymentStatus,
  InboundRequest,
  TriggerOptions,
} from './provider';
import { bearer, guardedFetch, verifyJwsHs256 } from './http';

const API = 'https://api.netlify.com/api/v1';

/**
 * Netlify adapter (design §4). Trigger via the site builds API, status & logs
 * via the deploy id. Token is a Netlify personal access token; `projectId` is
 * the Netlify site id.
 *
 * NOTE(owner=dev): confirm the exact builds/deploys endpoints against the live
 * Netlify API at implementation time (design §11).
 */

/** Map Netlify `state` → normalized status (design §3.3). */
export function mapNetlifyStatus(state: string | undefined): DeploymentStatus {
  switch ((state ?? '').toLowerCase()) {
    case 'new':
    case 'enqueued':
    case 'pending_review':
      return 'queued';
    case 'building':
    case 'uploading':
    case 'uploaded':
    case 'preparing':
    case 'processing':
      return 'building';
    case 'ready':
    case 'current':
      return 'ready';
    case 'error':
    case 'failed':
      return 'error';
    case 'canceled':
    case 'cancelled':
      return 'canceled';
    default:
      return 'queued';
  }
}

function toRef(d: Record<string, unknown>): DeploymentRef {
  const status = mapNetlifyStatus(d['state'] as string | undefined);
  return {
    providerDeploymentId: String(d['id'] ?? ''),
    status,
    url: (d['deploy_ssl_url'] ?? d['ssl_url'] ?? d['url']) as string | undefined,
    branch: d['branch'] as string | undefined,
    commitSha: d['commit_ref'] as string | undefined,
    commitMessage: undefined,
    errorMessage: d['error_message'] as string | undefined,
    completedAt:
      status === 'ready' || status === 'error' || status === 'canceled' ? new Date() : undefined,
  };
}

export const netlifyProvider: DeploymentProvider = {
  key: 'netlify',

  async verifyToken(token, target) {
    const res = await guardedFetch(`${API}/sites/${encodeURIComponent(target.projectId)}`, {
      headers: bearer(token),
    });
    if (res.ok) return { ok: true };
    if (res.status === 401) return { ok: false, reason: 'Invalid Netlify token.' };
    if (res.status === 404) return { ok: false, reason: 'Netlify site not found.' };
    return { ok: false, reason: `Netlify verify failed (${res.status}).` };
  },

  async trigger(token, target, opts: TriggerOptions) {
    const body: Record<string, unknown> = {};
    if (opts.branch ?? target.defaultBranch) body['branch'] = opts.branch ?? target.defaultBranch;
    const res = await guardedFetch(`${API}/sites/${encodeURIComponent(target.projectId)}/builds`, {
      method: 'POST',
      headers: { ...bearer(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(`Netlify trigger failed (${res.status}).`);
    // A build references its deploy; surface the deploy id when present.
    const deployId = json['deploy_id'] ?? json['id'];
    return {
      providerDeploymentId: String(deployId ?? ''),
      status: 'queued',
    };
  },

  async getStatus(token, target, providerDeploymentId) {
    const res = await guardedFetch(
      `${API}/sites/${encodeURIComponent(target.projectId)}/deploys/${encodeURIComponent(providerDeploymentId)}`,
      { headers: bearer(token) },
    );
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(`Netlify status failed (${res.status}).`);
    return toRef(json);
  },

  async getLogs(token, _target, providerDeploymentId) {
    const res = await guardedFetch(
      `${API}/deploys/${encodeURIComponent(providerDeploymentId)}/log`,
      { headers: bearer(token) },
    );
    if (!res.ok) throw new Error(`Netlify logs failed (${res.status}).`);
    return res.text();
  },

  async verifyWebhook(req: InboundRequest, secret: string) {
    // Netlify signs outgoing notifications with a compact JWS (HS256) in
    // `x-webhook-signature`, keyed by the per-site configured secret. Verify
    // the signature fully. An empty secret or missing/invalid JWS is rejected.
    const sig = req.headers['x-webhook-signature'];
    return verifyJwsHs256(sig ?? '', secret);
  },

  parseWebhook(rawBody: string) {
    try {
      const d = JSON.parse(rawBody) as Record<string, unknown>;
      const id = String(d['id'] ?? '');
      if (!id) return null;
      return toRef(d);
    } catch {
      return null;
    }
  },
};
