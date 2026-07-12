import { describe, it, expect } from 'vitest';
import { GitIntegrationService } from '../service';

/**
 * Tenant-isolation invariants for the integration resource mapping (DoD 2b).
 * `toResource` is pure given a row, so we exercise it without a DB: the
 * operator-facing webhook URL must embed the row's OWN siteId + id, so two
 * sites connecting the same repo get distinct, non-colliding webhook targets.
 * (The DB-backed list/query isolation is verified on staging — see
 * docs/en/features/git-integration.md §7.)
 */

// Minimal row shape accepted by toResource (db is never touched by it).
function row(siteId: string, id: string) {
  return {
    id,
    siteId,
    provider: 'github',
    repoFullName: 'acme/site',
    displayName: 'Acme',
    authMethod: 'pat',
    installationId: null,
    encryptedToken: 'enc',
    webhookSecretEnc: 'enc',
    status: 'connected',
    statusReason: null,
    scopes: [],
    syncConfig: {},
    lastSyncAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  } as unknown as Parameters<GitIntegrationService['toResource']>[0];
}

function service(siteId: string) {
  return new GitIntegrationService({
    // db is unused by toResource; cast a stub.
    db: {} as never,
    siteId,
    encryptionKey: 'k',
    publicBaseUrl: 'https://api.example.com',
  });
}

describe('GitIntegrationService tenant isolation (resource mapping)', () => {
  it('embeds the row\'s own siteId + id in the webhook URL', () => {
    const a = service('site_a').toResource(row('site_a', 'int_a'));
    expect(a.webhookUrl).toBe(
      'https://api.example.com/api/v1/integrations/git/webhook/github/site_a/int_a',
    );
  });

  it('produces distinct webhook URLs for two sites connecting the same repo', () => {
    const a = service('site_a').toResource(row('site_a', 'int_a'));
    const b = service('site_b').toResource(row('site_b', 'int_b'));
    expect(a.webhookUrl).not.toBe(b.webhookUrl);
    expect(a.webhookUrl).toContain('/site_a/');
    expect(b.webhookUrl).toContain('/site_b/');
  });

  it('never leaks the encrypted token, only a hasToken flag', () => {
    const r = service('site_a').toResource(row('site_a', 'int_a'));
    expect(r.hasToken).toBe(true);
    expect(JSON.stringify(r)).not.toContain('enc');
  });
});
