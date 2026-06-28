/**
 * Resolve Git-integration configuration from the runtime environment.
 *
 * Reads from `c.env` (Cloudflare) falling back to `process.env` (Node/Docker),
 * mirroring the pattern used across the CMS. Secrets are read on demand and
 * never logged.
 */
import type { Context } from 'hono';
import type { AppEnv } from '../../env';
import type { GitHubAppConfig } from './providers/app-token';

function readEnv(c: Context<AppEnv>, key: string): string | undefined {
  const fromBindings = (c.env as unknown as Record<string, unknown>)[key];
  if (typeof fromBindings === 'string' && fromBindings.length > 0) {
    return fromBindings;
  }
  const fromProcess =
    typeof process !== 'undefined' ? process.env?.[key] : undefined;
  return fromProcess && fromProcess.length > 0 ? fromProcess : undefined;
}

export interface GitOAuthConfig {
  clientId: string;
  clientSecret: string;
}

export interface GitIntegrationConfig {
  encryptionKey: string | undefined;
  publicBaseUrl: string;
  github: GitOAuthConfig | undefined;
  gitlab: GitOAuthConfig | undefined;
  githubApp: GitHubAppConfig | undefined;
}

/** Public origin: explicit env, else derived from the incoming request. */
export function resolvePublicBaseUrl(c: Context<AppEnv>): string {
  const explicit = readEnv(c, 'LUMIBASE_PUBLIC_URL');
  if (explicit) return explicit.replace(/\/+$/, '');
  try {
    return new URL(c.req.url).origin;
  } catch {
    return '';
  }
}

export function getGitConfig(c: Context<AppEnv>): GitIntegrationConfig {
  const githubId = readEnv(c, 'GITHUB_CLIENT_ID');
  const githubSecret = readEnv(c, 'GITHUB_CLIENT_SECRET');
  const gitlabId = readEnv(c, 'GITLAB_CLIENT_ID');
  const gitlabSecret = readEnv(c, 'GITLAB_CLIENT_SECRET');
  const appId = readEnv(c, 'GITHUB_APP_ID');
  const appKey = readEnv(c, 'GITHUB_APP_PRIVATE_KEY');

  return {
    encryptionKey: readEnv(c, 'ENCRYPTION_KEY'),
    publicBaseUrl: resolvePublicBaseUrl(c),
    github:
      githubId && githubSecret
        ? { clientId: githubId, clientSecret: githubSecret }
        : undefined,
    gitlab:
      gitlabId && gitlabSecret
        ? { clientId: gitlabId, clientSecret: gitlabSecret }
        : undefined,
    githubApp:
      appId && appKey ? { appId, privateKeyPem: appKey } : undefined,
  };
}
