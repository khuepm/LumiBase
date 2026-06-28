/**
 * Resolve a {@link GitProvider} for a stored integration row.
 *
 * Handles credential resolution: PAT/OAuth tokens are decrypted; GitHub App
 * installations mint a short-lived installation token. The rest of the module
 * only ever sees the {@link GitProvider} interface.
 */
import type { CacheProvider } from '@lumibase/runtime';
import { decryptSecretValue } from '../crypto';
import { GitHubProvider } from './github';
import { GitLabProvider } from './gitlab';
import { mintGitHubInstallationToken, type GitHubAppConfig } from './app-token';
import { type GitProvider, ProviderApiError } from './types';

/** The fields of a `git_integrations` row this resolver needs. */
export interface IntegrationCredential {
  id: string;
  siteId: string;
  provider: string;
  authMethod: string;
  installationId: string | null;
  encryptedToken: string | null;
}

export interface ProviderDeps {
  encryptionKey: string;
  fetchFn?: typeof fetch;
  cache?: CacheProvider;
  githubApp?: GitHubAppConfig;
}

async function resolveToken(
  integration: IntegrationCredential,
  deps: ProviderDeps,
): Promise<string> {
  // Stored token (PAT, OAuth, or GitLab group token) takes precedence.
  if (integration.encryptedToken) {
    return decryptSecretValue(
      deps.encryptionKey,
      integration.encryptedToken,
      { siteId: integration.siteId, integrationId: integration.id },
      'token',
    );
  }
  // GitHub App: mint an installation token on demand.
  if (integration.provider === 'github' && integration.authMethod === 'app') {
    if (!deps.githubApp) {
      throw new ProviderApiError(
        'GitHub App is not configured (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY)',
      );
    }
    if (!integration.installationId) {
      throw new ProviderApiError('Integration is missing installationId');
    }
    return mintGitHubInstallationToken(
      deps.githubApp,
      integration.installationId,
      { fetchFn: deps.fetchFn, cache: deps.cache },
    );
  }
  throw new ProviderApiError('No credential available for integration');
}

export async function getProvider(
  integration: IntegrationCredential,
  deps: ProviderDeps,
): Promise<GitProvider> {
  const token = await resolveToken(integration, deps);
  switch (integration.provider) {
    case 'github':
      return new GitHubProvider({ token, fetchFn: deps.fetchFn });
    case 'gitlab':
      return new GitLabProvider({ token, fetchFn: deps.fetchFn });
    default:
      throw new ProviderApiError(`Unknown provider "${integration.provider}"`);
  }
}
