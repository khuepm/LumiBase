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
  /** Verify an inbound status-webhook signature. */
  verifyWebhook(req: InboundRequest, secret: string): boolean;
  /** Parse an inbound status-webhook payload into a normalized ref. */
  parseWebhook(rawBody: string): DeploymentRef | null;
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
