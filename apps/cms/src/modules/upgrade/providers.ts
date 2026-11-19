import { hmacHex } from '../../services/deployment/providers/http';
import { hookUrlAllowed, type UpgradeConfig } from './config';

/**
 * Upgrade provider contract (#898) — the same shape as the
 * deployment-integrations providers (`services/deployment/providers`): the
 * service talks only to this interface, and a new way to roll a deployment
 * (a control-plane API, a specific CI) is one adapter plus `registerUpgradeProvider`.
 *
 * A provider ASKS something outside the process to upgrade. It never
 * replaces code itself, and must not hold a credential that could.
 */

export interface UpgradeHookRequest {
  readonly requestId: string;
  readonly fromVersion: string;
  readonly targetVersion: string;
  readonly channel: string;
  readonly instanceId: string | null;
  readonly runtime: 'docker' | 'cloudflare';
  readonly migrationsRunner: 'startup' | 'pipeline';
  readonly requestedAt: string;
}

export type UpgradeHookResult =
  | { readonly ok: true; readonly status: number; readonly reference: string | null }
  | { readonly ok: false; readonly status: number | null; readonly error: string };

export interface UpgradeProvider {
  readonly key: string;
  trigger(request: UpgradeHookRequest, config: UpgradeConfig, fetchImpl?: typeof fetch): Promise<UpgradeHookResult>;
}

const registry = new Map<string, UpgradeProvider>();

export function registerUpgradeProvider(provider: UpgradeProvider): void {
  registry.set(provider.key, provider);
}

export function getUpgradeProvider(key: string): UpgradeProvider | undefined {
  return registry.get(key);
}

const HOOK_TIMEOUT_MS = 10_000;

/**
 * Signature the receiver checks: `X-LumiBase-Signature: sha256=<hex>` over
 * `<X-LumiBase-Timestamp>.<raw body>`, keyed by `LUMIBASE_UPGRADE_WEBHOOK_SECRET`.
 * The timestamp lets the receiver refuse replays older than a few minutes.
 */
export async function signUpgradeHook(secret: string, timestamp: string, body: string): Promise<string> {
  return `sha256=${await hmacHex(secret, `${timestamp}.${body}`, 'SHA-256')}`;
}

/**
 * Generic signed webhook: a CI relay (e.g. a small function that dispatches a
 * GitHub Actions workflow), an updater service next to the container, or the
 * LumiBase control plane for hosted instances. 2xx = accepted; the body may
 * carry `{ "reference": "<run id>" }`. Redirects are refused.
 */
export const webhookUpgradeProvider: UpgradeProvider = {
  key: 'webhook',
  async trigger(request, config, fetchImpl = fetch) {
    const url = hookUrlAllowed(config.webhookUrl);
    if (!url || !config.webhookSecret) return { ok: false, status: null, error: 'NOT_CONFIGURED' };
    const body = JSON.stringify({ event: 'lumibase.upgrade.requested', ...request });
    const timestamp = String(Math.floor(Date.parse(request.requestedAt) / 1000));
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-lumibase-event': 'lumibase.upgrade.requested',
          'x-lumibase-timestamp': timestamp,
          'x-lumibase-signature': await signUpgradeHook(config.webhookSecret, timestamp, body),
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(HOOK_TIMEOUT_MS),
      });
      if (res.status >= 300 && res.status < 400) return { ok: false, status: res.status, error: 'REDIRECT_REFUSED' };
      if (!res.ok) return { ok: false, status: res.status, error: `HTTP_${res.status}` };
      let reference: string | null = null;
      try {
        const parsed = (await res.json()) as { reference?: unknown };
        if (typeof parsed?.reference === 'string' && parsed.reference.length <= 500) reference = parsed.reference;
      } catch {
        // A 2xx without a JSON body is still accepted.
      }
      return { ok: true, status: res.status, reference };
    } catch {
      return { ok: false, status: null, error: 'HOOK_UNREACHABLE' };
    }
  },
};

registerUpgradeProvider(webhookUpgradeProvider);
