import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../env';
import { ConfigService } from '../../services/config-service';
import { DeploymentService } from '../../services/deployment/deployment-service';
import { hmacHex } from '../../services/deployment/providers/http';
import { deploymentsWebhookRouter } from '../deployments';

/**
 * Inbound deployment webhook tenant resolution (B163, issue #569).
 *
 * Vercel and Netlify outgoing webhooks configure only a URL and a signing
 * secret, never custom headers (`X-Lumi-Site`). On the shared API host
 * (`api.lumibase.dev`), `withTenant` skips the `api` label and returns
 * `400 TENANT_REQUIRED` unless the path itself carries `:siteId`.
 */

const SECRETS_BY_SITE: Record<string, Record<string, string>> = {
  site_a: { vercel: 'secret_site_a' },
  site_b: { vercel: 'secret_site_b' },
};

function buildWebhookApp(applied: Array<{ siteId: string; providerDeploymentId: string }>) {
  vi.spyOn(ConfigService.prototype, 'listSettings').mockImplementation((async function (this: {
    deps?: { siteId: string };
  }) {
    const siteId = this.deps?.siteId ?? '';
    const byProvider = SECRETS_BY_SITE[siteId] ?? {};
    return Object.entries(byProvider).map(([provider, secret]) => ({
      id: `set_${siteId}_${provider}`,
      siteId,
      key: `deployment.webhook.${provider}`,
      value: { secret },
      group: 'deployment',
      isPublic: false,
      updatedBy: null,
      updatedAt: new Date(),
    }));
  }) as unknown as typeof ConfigService.prototype.listSettings);

  vi.spyOn(DeploymentService.prototype, 'applyWebhookRef').mockImplementation(async function (
    this: { deps?: { siteId: string } },
    ref,
  ) {
    const siteId = this.deps?.siteId ?? '';
    applied.push({ siteId, providerDeploymentId: ref.providerDeploymentId });
  });

  const app = new Hono<AppEnv>();
  app.use('/api/v1/deployments/webhook/*', async (c, next) => {
    c.set('db', {} as never);
    c.set('runtime', { keys: {}, rateLimiter: undefined, cache: undefined } as never);
    await next();
  });
  app.route('/api/v1/deployments/webhook', deploymentsWebhookRouter);
  return app;
}

describe('POST /api/v1/deployments/webhook — tenant resolution (#569, B163)', () => {
  afterEach(() => vi.restoreAllMocks());

  const payload = JSON.stringify({
    type: 'deployment.ready',
    payload: { deployment: { id: 'dpl_shared_host_1', url: 'site-a.vercel.app' } },
  });

  it('resolves the tenant from /:provider/:siteId on the shared API host without X-Lumi-Site', async () => {
    const applied: Array<{ siteId: string; providerDeploymentId: string }> = [];
    const app = buildWebhookApp(applied);
    const sig = await hmacHex('secret_site_a', payload, 'SHA-1');

    const res = await app.request(
      'https://api.lumibase.dev/api/v1/deployments/webhook/vercel/site_a',
      {
        method: 'POST',
        headers: {
          host: 'api.lumibase.dev',
          'content-type': 'application/json',
          'x-vercel-signature': sig,
        },
        body: payload,
      },
      {} as never,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: null });
    expect(applied).toEqual([{ siteId: 'site_a', providerDeploymentId: 'dpl_shared_host_1' }]);
  });

  it('isolates webhook secrets per site on /:provider/:siteId (site_b secret rejected for site_a)', async () => {
    const applied: Array<{ siteId: string; providerDeploymentId: string }> = [];
    const app = buildWebhookApp(applied);
    const wrongSiteSig = await hmacHex('secret_site_b', payload, 'SHA-1');

    const res = await app.request(
      'https://api.lumibase.dev/api/v1/deployments/webhook/vercel/site_a',
      {
        method: 'POST',
        headers: {
          host: 'api.lumibase.dev',
          'content-type': 'application/json',
          'x-vercel-signature': wrongSiteSig,
        },
        body: payload,
      },
      {} as never,
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ errors: [{ code: 'INVALID_SIGNATURE' }] });
    expect(applied).toEqual([]);
  });

  it('rejects an invalid :siteId path parameter with 400 TENANT_INVALID', async () => {
    const applied: Array<{ siteId: string; providerDeploymentId: string }> = [];
    const app = buildWebhookApp(applied);
    const sig = await hmacHex('secret_site_a', payload, 'SHA-1');

    const res = await app.request(
      'https://api.lumibase.dev/api/v1/deployments/webhook/vercel/bad$site!',
      {
        method: 'POST',
        headers: { 'x-vercel-signature': sig },
        body: payload,
      },
      {} as never,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      errors: [{ code: 'TENANT_INVALID' }],
    });
    expect(applied).toEqual([]);
  });

  it('rejects a conflicting X-Lumi-Site header on /:provider/:siteId with 400 TENANT_MISMATCH', async () => {
    const applied: Array<{ siteId: string; providerDeploymentId: string }> = [];
    const app = buildWebhookApp(applied);
    const sig = await hmacHex('secret_site_a', payload, 'SHA-1');

    const res = await app.request(
      'https://api.lumibase.dev/api/v1/deployments/webhook/vercel/site_a',
      {
        method: 'POST',
        headers: {
          'x-lumi-site': 'site_b',
          'x-vercel-signature': sig,
        },
        body: payload,
      },
      {} as never,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      errors: [{ code: 'TENANT_MISMATCH' }],
    });
    expect(applied).toEqual([]);
  });

  it('keeps backward compatibility for /:provider when X-Lumi-Site is supplied', async () => {
    const applied: Array<{ siteId: string; providerDeploymentId: string }> = [];
    const app = buildWebhookApp(applied);
    const sig = await hmacHex('secret_site_a', payload, 'SHA-1');

    const okRes = await app.request(
      'https://api.lumibase.dev/api/v1/deployments/webhook/vercel',
      {
        method: 'POST',
        headers: {
          host: 'api.lumibase.dev',
          'x-lumi-site': 'site_a',
          'x-vercel-signature': sig,
        },
        body: payload,
      },
      {} as never,
    );

    expect(okRes.status).toBe(200);
    expect(applied).toEqual([{ siteId: 'site_a', providerDeploymentId: 'dpl_shared_host_1' }]);

    const missingTenantRes = await app.request(
      'https://api.lumibase.dev/api/v1/deployments/webhook/vercel',
      {
        method: 'POST',
        headers: {
          host: 'api.lumibase.dev',
          'x-vercel-signature': sig,
        },
        body: payload,
      },
      {} as never,
    );

    expect(missingTenantRes.status).toBe(400);
    expect(await missingTenantRes.json()).toMatchObject({
      errors: [{ code: 'TENANT_REQUIRED' }],
    });
  });

  it('returns 404 UNKNOWN_PROVIDER for an unsupported provider on both routes', async () => {
    const applied: Array<{ siteId: string; providerDeploymentId: string }> = [];
    const app = buildWebhookApp(applied);

    const byPath = await app.request(
      'https://api.lumibase.dev/api/v1/deployments/webhook/heroku/site_a',
      { method: 'POST', body: '{}' },
      {} as never,
    );
    expect(byPath.status).toBe(404);
    expect(await byPath.json()).toEqual({ errors: [{ code: 'UNKNOWN_PROVIDER' }] });

    const byHeader = await app.request(
      'https://api.lumibase.dev/api/v1/deployments/webhook/heroku',
      { method: 'POST', headers: { 'x-lumi-site': 'site_a' }, body: '{}' },
      {} as never,
    );
    expect(byHeader.status).toBe(404);
    expect(await byHeader.json()).toEqual({ errors: [{ code: 'UNKNOWN_PROVIDER' }] });
  });
});
