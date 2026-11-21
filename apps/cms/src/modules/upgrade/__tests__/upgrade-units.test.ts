import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { resolveUpgradeConfig, upgradeConfigured } from '../config';
import { webhookUpgradeProvider, type UpgradeHookRequest } from '../providers';
import { compareVersions, fetchLatestRelease } from '../releases';

const RELEASES = {
  stable: {
    version: '2.3.0',
    releaseDate: '2026-12-01',
    changelogUrl: 'https://docs.example.test/changelog',
    minimumSafeUpgradeVersion: '2.0.0',
    migrationWarning: true,
  },
  edge: {
    version: '2.4.0-rc.1',
    releaseDate: '2026-12-05',
    changelogUrl: 'https://docs.example.test/changelog',
    minimumSafeUpgradeVersion: '2.2.0',
    migrationWarning: false,
  },
};

describe('compareVersions', () => {
  it('orders releases, pre-releases and v-prefixes; refuses non-versions', () => {
    expect(compareVersions('2.10.0', '2.9.9')).toBe(1);
    expect(compareVersions('v2.2.0', '2.2.0')).toBe(0);
    expect(compareVersions('2.2.0-rc.1', '2.2.0')).toBe(-1);
    expect(compareVersions('2.2.0-rc.10', '2.2.0-rc.2')).toBe(1);
    expect(compareVersions('2.2.0-beta', '2.2.0-alpha')).toBe(1);
    expect(compareVersions('unknown', '2.2.0')).toBeNull();
  });
});

describe('resolveUpgradeConfig', () => {
  it('defaults to no provider, stable channel, migrations at startup on Docker and in the pipeline on Workers', () => {
    expect(resolveUpgradeConfig({})).toMatchObject({
      provider: 'none',
      channel: 'stable',
      migrationsRunner: 'startup',
      runtime: 'docker',
    });
    expect(resolveUpgradeConfig({ LUMIBASE_RUNTIME: 'cloudflare' }).migrationsRunner).toBe('pipeline');
    expect(resolveUpgradeConfig({ LUMIBASE_MIGRATIONS_RUNNER: 'pipeline' }).migrationsRunner).toBe('pipeline');
  });

  it('needs a provider, a URL and a secret to be configured', () => {
    const base = { LUMIBASE_UPGRADE_PROVIDER: 'webhook', LUMIBASE_UPGRADE_WEBHOOK_URL: 'https://ci.example.test/hook' };
    expect(upgradeConfigured(resolveUpgradeConfig(base))).toBe(false);
    expect(upgradeConfigured(resolveUpgradeConfig({ ...base, LUMIBASE_UPGRADE_WEBHOOK_SECRET: 's' }))).toBe(true);
    expect(
      upgradeConfigured(resolveUpgradeConfig({ ...base, LUMIBASE_UPGRADE_WEBHOOK_URL: 'ftp://x', LUMIBASE_UPGRADE_WEBHOOK_SECRET: 's' })),
    ).toBe(false);
  });
});

describe('fetchLatestRelease', () => {
  it('reads the requested channel and reports failures as unknown', async () => {
    const ok = async () => new Response(JSON.stringify(RELEASES));
    expect(await fetchLatestRelease('https://x/releases.json', 'stable', ok)).toMatchObject({
      ok: true,
      release: { version: '2.3.0', migrationWarning: true },
    });
    expect(await fetchLatestRelease('https://x/releases.json', 'edge', ok)).toMatchObject({
      ok: true,
      release: { version: '2.4.0-rc.1' },
    });
    expect(await fetchLatestRelease('https://x', 'stable', async () => new Response('nope', { status: 500 }))).toEqual({
      ok: false,
      reason: 'HTTP_500',
    });
    expect(await fetchLatestRelease('https://x', 'stable', async () => new Response('{"stable":{}}'))).toEqual({
      ok: false,
      reason: 'MALFORMED_RELEASES',
    });
    expect(
      await fetchLatestRelease('https://x', 'stable', async () => {
        throw new Error('offline');
      }),
    ).toEqual({ ok: false, reason: 'FETCH_FAILED' });
  });
});

describe('webhook upgrade provider', () => {
  const request: UpgradeHookRequest = {
    requestId: 'req-1',
    fromVersion: '2.2.0',
    targetVersion: '2.3.0',
    channel: 'stable',
    instanceId: 'lumibase-staging',
    runtime: 'docker',
    migrationsRunner: 'startup',
    requestedAt: '2026-12-02T10:00:00.000Z',
  };
  const config = resolveUpgradeConfig({
    LUMIBASE_UPGRADE_PROVIDER: 'webhook',
    LUMIBASE_UPGRADE_WEBHOOK_URL: 'https://ci.example.test/hook',
    LUMIBASE_UPGRADE_WEBHOOK_SECRET: 'hook-secret',
  });

  it('POSTs a signed request the receiver can verify, and reads the reference', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const result = await webhookUpgradeProvider.trigger(request, config, async (url, init) => {
      seen = { url: String(url), init: init! };
      return new Response(JSON.stringify({ reference: 'run-42' }), { status: 202 });
    });
    expect(result).toEqual({ ok: true, status: 202, reference: 'run-42' });
    const headers = seen!.init.headers as Record<string, string>;
    const body = String(seen!.init.body);
    expect(seen!.url).toBe('https://ci.example.test/hook');
    expect(seen!.init.redirect).toBe('manual');
    expect(JSON.parse(body)).toMatchObject({ event: 'lumibase.upgrade.requested', targetVersion: '2.3.0', requestId: 'req-1' });
    // What a receiver does: HMAC-SHA256 over "<timestamp>.<body>".
    const expected = createHmac('sha256', 'hook-secret').update(`${headers['x-lumibase-timestamp']}.${body}`).digest('hex');
    expect(headers['x-lumibase-signature']).toBe(`sha256=${expected}`);
    expect(headers['x-lumibase-timestamp']).toBe(String(Date.parse(request.requestedAt) / 1000));
    expect(JSON.stringify(seen)).not.toContain('hook-secret');
  });

  it('reports a refusal, a redirect and an unreachable hook as failures', async () => {
    expect(await webhookUpgradeProvider.trigger(request, config, async () => new Response('no', { status: 403 }))).toEqual({
      ok: false,
      status: 403,
      error: 'HTTP_403',
    });
    expect(
      await webhookUpgradeProvider.trigger(request, config, async () => new Response(null, { status: 302, headers: { location: 'x' } })),
    ).toEqual({ ok: false, status: 302, error: 'REDIRECT_REFUSED' });
    expect(
      await webhookUpgradeProvider.trigger(request, config, async () => {
        throw new Error('ECONNREFUSED');
      }),
    ).toEqual({ ok: false, status: null, error: 'HOOK_UNREACHABLE' });
    expect(await webhookUpgradeProvider.trigger(request, resolveUpgradeConfig({}))).toEqual({
      ok: false,
      status: null,
      error: 'NOT_CONFIGURED',
    });
  });
});
