import {
  DeploymentEnvironmentsSchema,
  type DeploymentEnvironment,
} from '@lumibase/contracts';
import type { Database } from '@lumibase/database';
import { ConfigService } from '../config-service';
import {
  satisfiesCapability,
  UNLIMITED_CAPABILITY_TOKENS,
} from '../effective-capability-service';
import { DeploymentError } from './deployment-service';

/**
 * Deployment environments and the capabilities that govern them (#743).
 *
 * An environment (`preview`, `staging`, `production`, or any slug a site
 * defines) maps to one or more deployment targets. Triggering an environment
 * deploys every target it maps; promoting an environment ships its latest
 * ready build into the environment named by `promotesTo`. An environment with
 * `requiresApproval` never dispatches on request: it parks a pending approval
 * that a different human holding `deploy:approve:<env>` must accept.
 *
 * Config lives in the per-site settings key {@link ENVIRONMENTS_SETTINGS_KEY}
 * (settings writes are site-admin only). Absent → {@link DEFAULT_ENVIRONMENTS};
 * present but malformed → every deploy path refuses (`ENVIRONMENTS_INVALID`)
 * rather than falling back to defaults, because a fallback could un-map a
 * production target from its approval gate.
 */

export type { DeploymentEnvironment };

export const ENVIRONMENTS_SETTINGS_KEY = 'deployment.environments';

/** Defaults: no targets mapped yet, so nothing changes until an admin maps one. */
export const DEFAULT_ENVIRONMENTS: readonly DeploymentEnvironment[] = Object.freeze([
  { key: 'preview', name: 'Preview', targetIds: [], requiresApproval: false, promotesTo: null },
  { key: 'staging', name: 'Staging', targetIds: [], requiresApproval: false, promotesTo: 'production' },
  { key: 'production', name: 'Production', targetIds: [], requiresApproval: true, promotesTo: null },
]);

// ── Capabilities ─────────────────────────────────────────────────────────────

export const DEPLOY_TRIGGER_PREFIX = 'deploy:trigger:';
export const DEPLOY_APPROVE_PREFIX = 'deploy:approve:';
export const DEPLOY_TRIGGER_WILDCARD = `${DEPLOY_TRIGGER_PREFIX}*`;
export const DEPLOY_APPROVE_WILDCARD = `${DEPLOY_APPROVE_PREFIX}*`;

/** Whether a capability is one this feature reads (or an unlimited marker). */
export function isDeployCapability(capability: string): boolean {
  return (
    UNLIMITED_CAPABILITY_TOKENS.includes(capability) ||
    capability.startsWith(DEPLOY_TRIGGER_PREFIX) ||
    capability.startsWith(DEPLOY_APPROVE_PREFIX)
  );
}

/** Any deploy grant at all: enough to read targets, deployments and approvals. */
export function hasDeployAccess(capabilities: readonly string[]): boolean {
  return capabilities.some(isDeployCapability);
}

/**
 * May trigger every target of `env`: the wildcard, the environment key, or a
 * per-target grant on each of its targets.
 */
export function canTriggerEnvironment(
  capabilities: readonly string[],
  env: Pick<DeploymentEnvironment, 'key' | 'targetIds'>,
): boolean {
  if (satisfiesCapability(capabilities, DEPLOY_TRIGGER_WILDCARD)) return true;
  if (satisfiesCapability(capabilities, `${DEPLOY_TRIGGER_PREFIX}${env.key}`)) return true;
  return (
    env.targetIds.length > 0 &&
    env.targetIds.every((id) => satisfiesCapability(capabilities, `${DEPLOY_TRIGGER_PREFIX}${id}`))
  );
}

/**
 * May trigger one target directly: the wildcard, the target id, or the key of
 * any environment the target belongs to.
 */
export function canTriggerTarget(
  capabilities: readonly string[],
  targetId: string,
  governing: readonly Pick<DeploymentEnvironment, 'key'>[],
): boolean {
  if (satisfiesCapability(capabilities, DEPLOY_TRIGGER_WILDCARD)) return true;
  if (satisfiesCapability(capabilities, `${DEPLOY_TRIGGER_PREFIX}${targetId}`)) return true;
  return governing.some((env) => satisfiesCapability(capabilities, `${DEPLOY_TRIGGER_PREFIX}${env.key}`));
}

/** May decide a pending approval gating `envKey`. */
export function canApproveEnvironment(capabilities: readonly string[], envKey: string): boolean {
  return (
    satisfiesCapability(capabilities, DEPLOY_APPROVE_WILDCARD) ||
    satisfiesCapability(capabilities, `${DEPLOY_APPROVE_PREFIX}${envKey}`)
  );
}

/** Environments that contain `targetId`, in config order. */
export function environmentsForTarget(
  environments: readonly DeploymentEnvironment[],
  targetId: string,
): DeploymentEnvironment[] {
  return environments.filter((env) => env.targetIds.includes(targetId));
}

/**
 * The environment whose approval gate a direct target trigger falls under: the
 * first governing environment that requires approval. The strictest rule wins,
 * so a target shared by staging and production is gated like production.
 */
export function gatingEnvironmentForTarget(
  environments: readonly DeploymentEnvironment[],
  targetId: string,
): DeploymentEnvironment | null {
  return environmentsForTarget(environments, targetId).find((env) => env.requiresApproval) ?? null;
}

// ── Store ────────────────────────────────────────────────────────────────────

export class DeploymentEnvironmentStore {
  constructor(private readonly deps: { db: Database; siteId: string }) {}

  private config(): ConfigService {
    return new ConfigService({ db: this.deps.db, siteId: this.deps.siteId });
  }

  async read(): Promise<DeploymentEnvironment[]> {
    const rows = await this.config().listSettings();
    const row = rows.find((r) => r.key === ENVIRONMENTS_SETTINGS_KEY);
    if (!row) return DEFAULT_ENVIRONMENTS.map((env) => ({ ...env, targetIds: [...env.targetIds] }));
    const raw = (row.value as { environments?: unknown } | null)?.environments;
    const parsed = DeploymentEnvironmentsSchema.safeParse(raw);
    if (!parsed.success) {
      throw new DeploymentError(
        'ENVIRONMENTS_INVALID',
        'The deployment environments configuration is invalid; deploys are refused until an admin fixes it.',
      );
    }
    return parsed.data;
  }

  async write(environments: DeploymentEnvironment[]): Promise<DeploymentEnvironment[]> {
    await this.config().upsertSetting({
      key: ENVIRONMENTS_SETTINGS_KEY,
      value: { environments },
      scope: 'deployments',
    });
    return environments;
  }
}
