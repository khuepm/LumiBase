/**
 * In-app upgrade configuration (#898). Operator-controlled environment only:
 * nothing here is editable from Studio, because the hook decides what code the
 * deployment runs next.
 *
 *   LUMIBASE_UPGRADE_PROVIDER      `webhook` | `none` (default `none`)
 *   LUMIBASE_UPGRADE_WEBHOOK_URL   where the request is POSTed (CI relay,
 *                                  updater service, LumiBase control plane)
 *   LUMIBASE_UPGRADE_WEBHOOK_SECRET HMAC-SHA256 key the receiver verifies
 *   LUMIBASE_RELEASES_URL          release manifest (default docs.lumibase.dev)
 *   LUMIBASE_UPGRADE_CHANNEL       `stable` | `edge` (default `stable`)
 *   LUMIBASE_MIGRATIONS_RUNNER     `startup` | `pipeline` — who applies
 *                                  migrations (default: `startup` on Docker,
 *                                  `pipeline` on Workers)
 *
 * The CMS never holds a credential that can replace its own code: the webhook
 * secret only proves the request came from this instance. On Workers the
 * recommended receiver is the operator's CI (a workflow that runs migrations
 * and `wrangler deploy`), not a stored Cloudflare deploy token.
 */

export const DEFAULT_RELEASES_URL = 'https://docs.lumibase.dev/releases.json';

export type UpgradeProviderKey = 'webhook' | 'none';
export type MigrationsRunner = 'startup' | 'pipeline';
export type ReleaseChannel = 'stable' | 'edge';

export interface UpgradeConfig {
  readonly provider: UpgradeProviderKey;
  readonly webhookUrl: string | null;
  readonly webhookSecret: string | null;
  readonly releasesUrl: string;
  readonly channel: ReleaseChannel;
  readonly migrationsRunner: MigrationsRunner;
  readonly runtime: 'docker' | 'cloudflare';
  readonly instanceId: string | null;
}

export const UPGRADE_ENV_KEYS = [
  'LUMIBASE_UPGRADE_PROVIDER',
  'LUMIBASE_UPGRADE_WEBHOOK_URL',
  'LUMIBASE_UPGRADE_WEBHOOK_SECRET',
  'LUMIBASE_RELEASES_URL',
  'LUMIBASE_UPGRADE_CHANNEL',
  'LUMIBASE_MIGRATIONS_RUNNER',
  'LUMIBASE_RUNTIME',
  'LUMIBASE_INSTANCE_ID',
] as const;

type UpgradeEnv = Partial<Record<(typeof UPGRADE_ENV_KEYS)[number], unknown>>;

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** `https:` anywhere; `http:` too — the URL is operator configuration, not tenant input. */
export function hookUrlAllowed(raw: string | null): URL | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

export function resolveUpgradeConfig(env: UpgradeEnv): UpgradeConfig {
  const runtime = str(env.LUMIBASE_RUNTIME) === 'cloudflare' ? 'cloudflare' : 'docker';
  const provider = str(env.LUMIBASE_UPGRADE_PROVIDER) === 'webhook' ? 'webhook' : 'none';
  const runner = str(env.LUMIBASE_MIGRATIONS_RUNNER);
  return {
    provider,
    webhookUrl: str(env.LUMIBASE_UPGRADE_WEBHOOK_URL),
    webhookSecret: str(env.LUMIBASE_UPGRADE_WEBHOOK_SECRET),
    releasesUrl: str(env.LUMIBASE_RELEASES_URL) ?? DEFAULT_RELEASES_URL,
    channel: str(env.LUMIBASE_UPGRADE_CHANNEL) === 'edge' ? 'edge' : 'stable',
    migrationsRunner:
      runner === 'startup' || runner === 'pipeline' ? runner : runtime === 'cloudflare' ? 'pipeline' : 'startup',
    runtime,
    instanceId: str(env.LUMIBASE_INSTANCE_ID),
  };
}

/** Bindings first (Workers), then `process.env` (Docker). */
export function upgradeEnvFrom(bindings: unknown): UpgradeEnv {
  const source = (bindings && typeof bindings === 'object' ? bindings : {}) as Record<string, unknown>;
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  const out: Record<string, unknown> = {};
  for (const key of UPGRADE_ENV_KEYS) out[key] = typeof source[key] === 'string' ? source[key] : proc[key];
  return out as UpgradeEnv;
}

/** Whether the button can ask anything to upgrade this deployment. */
export function upgradeConfigured(config: UpgradeConfig): boolean {
  return config.provider === 'webhook' && hookUrlAllowed(config.webhookUrl) !== null && config.webhookSecret !== null;
}
