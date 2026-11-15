import {
  EXTENSION_DEV_DEFAULT_PORT,
  EXTENSION_DEV_MIN_TOKEN_LENGTH,
  isLoopbackUrl,
} from '@lumibase/contracts/extensions';

/**
 * Guard for the CMS side of extension hot reload (#754).
 *
 * The dev-reload client makes the CMS import code pushed by `lumibase-ext dev`
 * — remote code execution by design — so it is fenced on every axis and fails
 * closed:
 *   1. opt-in: `LUMIBASE_EXTENSION_DEV=1` (or `true`);
 *   2. never production: refused when `NODE_ENV` or `LUMIBASE_ENV` is
 *      `production`, and `NODE_ENV` must explicitly be `development` or `test`;
 *   3. loopback only: the hub URL must point at localhost / 127.0.0.0/8 / ::1;
 *   4. authenticated: the per-session token printed by the CLI (env, or the
 *      0600 token file the CLI writes), at least 32 characters.
 * Additionally `validateProductionConfig` fails the production start when
 * the flag is set, and the registry itself refuses to activate in production.
 *
 * Node/Docker only: `serve.ts` is the only caller. The Workers entry never
 * starts the client, so a Workers deployment cannot hot-reload.
 */

export const EXTENSION_DEV_FLAG = 'LUMIBASE_EXTENSION_DEV';

export type ExtensionDevRefusal =
  | 'not-requested'
  | 'production'
  | 'node-env'
  | 'non-loopback-url'
  | 'weak-token';

export type ExtensionDevConfig =
  | {
      enabled: true;
      hubUrl: string;
      /** Token from env; when null the client reads `tokenFile` on every connect. */
      token: string | null;
      /** Explicit token file, or null to use the CLI's default per-port path. */
      tokenFile: string | null;
      hubPort: number;
    }
  | { enabled: false; reason: ExtensionDevRefusal; message: string };

type Env = Record<string, string | undefined>;

export function isExtensionDevRequested(env: Env): boolean {
  const raw = env[EXTENSION_DEV_FLAG]?.trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

export function resolveExtensionDevConfig(env: Env): ExtensionDevConfig {
  if (!isExtensionDevRequested(env)) {
    return { enabled: false, reason: 'not-requested', message: `${EXTENSION_DEV_FLAG} is not set` };
  }
  if (env.NODE_ENV === 'production' || env.LUMIBASE_ENV === 'production') {
    return {
      enabled: false,
      reason: 'production',
      message: 'extension hot reload is refused in production (NODE_ENV/LUMIBASE_ENV=production)',
    };
  }
  if (env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test') {
    return {
      enabled: false,
      reason: 'node-env',
      message: `extension hot reload requires NODE_ENV=development (got ${env.NODE_ENV ? `"${env.NODE_ENV}"` : 'unset'})`,
    };
  }
  const hubUrl = (env.LUMIBASE_EXTENSION_DEV_URL?.trim() || `http://127.0.0.1:${EXTENSION_DEV_DEFAULT_PORT}`).replace(/\/+$/, '');
  if (!isLoopbackUrl(hubUrl)) {
    return {
      enabled: false,
      reason: 'non-loopback-url',
      message: 'LUMIBASE_EXTENSION_DEV_URL must be a loopback http(s) URL (localhost, 127.0.0.1 or ::1)',
    };
  }
  const token = env.LUMIBASE_EXTENSION_DEV_TOKEN?.trim() || null;
  if (token !== null && token.length < EXTENSION_DEV_MIN_TOKEN_LENGTH) {
    return {
      enabled: false,
      reason: 'weak-token',
      message: `LUMIBASE_EXTENSION_DEV_TOKEN must be at least ${EXTENSION_DEV_MIN_TOKEN_LENGTH} characters`,
    };
  }
  const url = new URL(hubUrl);
  const hubPort = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  return {
    enabled: true,
    hubUrl,
    token,
    tokenFile: env.LUMIBASE_EXTENSION_DEV_TOKEN_FILE?.trim() || null,
    hubPort,
  };
}
