/**
 * Deployment provider adapter contract (spec: deployment-integrations,
 * design §4). Each external hosting platform (Vercel, Netlify, …) implements
 * this interface; the DeploymentService talks only to the interface so adding
 * a provider is a single new adapter + a `registerProvider` call.
 *
 * All outbound HTTP from adapters MUST pass through the SSRF guard
 * (`validateOutboundUrl`) and use a timeout, identical to the Flow `http`
 * operation policy.
 */

/** LumiBase-normalized deployment status (design §3.3). */
export type DeploymentStatus = 'queued' | 'building' | 'ready' | 'error' | 'canceled';

export const TERMINAL_STATUSES: ReadonlySet<DeploymentStatus> = new Set<DeploymentStatus>([
  'ready',
  'error',
  'canceled',
]);

/** Minimal view of a target the adapter needs (no secrets). */
export interface ProviderTarget {
  provider: string;
  projectId: string;
  defaultBranch?: string | null;
}

/** Normalized reference to a Provider deployment. */
export interface DeploymentRef {
  providerDeploymentId: string;
  status: DeploymentStatus;
  url?: string;
  branch?: string;
  commitSha?: string;
  commitMessage?: string;
  errorMessage?: string;
  completedAt?: Date;
}

export interface TriggerOptions {
  branch?: string;
  reason?: string;
  /**
   * Pin the build to this commit (#743 promotion fallback). Adapters that can
   * build a specific commit honour it; the others build `branch`.
   */
  commitSha?: string;
}

export interface InboundRequest {
  headers: Record<string, string>;
  rawBody: string;
}

export interface DeploymentProvider {
  readonly key: string;
  /** Read-only call to verify a token/project pair when creating a target. */
  verifyToken(token: string, target: ProviderTarget): Promise<{ ok: boolean; reason?: string }>;
  /** Trigger a build/deploy; returns a ref if the Provider assigns an id now. */
  trigger(token: string, target: ProviderTarget, opts: TriggerOptions): Promise<DeploymentRef>;
  /** Current status of a single deployment (for poller / refresh). */
  getStatus(token: string, target: ProviderTarget, providerDeploymentId: string): Promise<DeploymentRef>;
  /** Build log (for debug). */
  getLogs(token: string, target: ProviderTarget, providerDeploymentId: string): Promise<string>;
  /**
   * Verify an inbound status-webhook signature against `secret` (the per-site
   * configured webhook secret). Performs real HMAC/JWS verification over the
   * raw body via Web Crypto, so it is async. A missing/invalid signature or an
   * empty secret returns `false`.
   */
  verifyWebhook(req: InboundRequest, secret: string): Promise<boolean>;
  /** Parse an inbound status-webhook payload into a normalized ref. */
  parseWebhook(rawBody: string): DeploymentRef | null;
  /**
   * Promote an existing, already-built deployment of the SAME project to its
   * production slot without rebuilding (#743). Optional: a provider without it
   * is promoted by re-triggering the same ref instead.
   */
  promote?(token: string, target: ProviderTarget, providerDeploymentId: string): Promise<DeploymentRef>;
}

const registry = new Map<string, DeploymentProvider>();

export function registerProvider(provider: DeploymentProvider): void {
  registry.set(provider.key, provider);
}

export function getProvider(key: string): DeploymentProvider | undefined {
  return registry.get(key);
}

export function listProviders(): string[] {
  return [...registry.keys()];
}
