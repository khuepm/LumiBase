import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import {
  exportAccessManifest,
  formatImportResult,
  parseAccessArgs,
  runAccessCli,
  summarizeDiff,
} from '../../../scripts/access-cli';
import type { AccessExportManifest, AccessImportDiff, AccessImportDryRunResult } from '@lumibase/sdk';
import { resolve } from 'node:path';

describe('access-cli', () => {
  it('parses env-backed access import options', () => {
    expect(
      parseAccessArgs(['import', 'access.json', '--dry-run', '--mode', 'replace-managed'], {
        LUMIBASE_API_URL: 'https://cms.example.test',
        LUMIBASE_TOKEN: 'token',
        LUMIBASE_SITE: 'site_1',
      }),
    ).toMatchObject({
      command: 'import',
      url: 'https://cms.example.test',
      site: 'site_1',
      token: 'token',
      file: 'access.json',
      dryRun: true,
      mode: 'replace-managed',
    });
  });

  it('exports the access manifest with site and bearer headers', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ data: manifest() }));

    const result = await exportAccessManifest(
      { url: 'https://cms.example.test', site: 'site_1', token: 'secret' },
      fetcher,
    );

    expect(result.schema).toBe('lumibase.access@v1');
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://cms.example.test/api/v1/access/export');
    expect((init!.headers as Headers).get('x-lumi-site')).toBe('site_1');
    expect((init!.headers as Headers).get('authorization')).toBe('Bearer secret');
  });

  it('prints dry-run details and exits non-zero when conflicts block CI', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lumibase-access-'));
    const file = resolve(join(dir, 'access.json'));
    await writeFile(file, JSON.stringify(manifest()), 'utf8');
    const stdout = writer();
    const stderr = writer();
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ data: dryRunResult(false) }, 400));

    const code = await runAccessCli(
      {
        command: 'import',
        url: 'https://cms.example.test',
        site: 'site_1',
        file,
        dryRun: true,
        mode: 'merge',
      },
      { fetcher, stdout, stderr },
    );

    expect(code).toBe(1);
    expect(stdout.text()).toContain('[access] Dry-run blocked');
    expect(stdout.text()).toContain('Blocking conflicts: 1');
    expect(stderr.text()).toBe('');
    expect(String(fetcher.mock.calls[0]![0])).toBe('https://cms.example.test/api/v1/access/import?dryRun=true');
  });

  it('summarizes all entity and binding diff sections', () => {
    expect(summarizeDiff(diff())).toEqual({
      create: 2,
      update: 1,
      unchanged: 2,
      delete: 1,
    });
  });

  it('formats apply results for CI logs', () => {
    expect(formatImportResult({ ...dryRunResult(true), dryRun: false, mode: 'replace-all', applied: true, audit: {
      event: 'access_import_applied',
      summary: {
        mode: 'replace-all',
        roles: diff().roles,
        policies: diff().policies,
        apiKeys: diff().apiKeys,
        bindings: diff().bindings,
      },
    } })).toContain('mode=replace-all applied=true');
  });
});

function writer(): Pick<typeof process.stdout, 'write'> & { text: () => string } {
  const chunks: string[] = [];
  return {
    write: (chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    },
    text: () => chunks.join(''),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as Response;
}

function manifest(): AccessExportManifest {
  return {
    schema: 'lumibase.access@v1',
    exportedAt: '2026-06-05T00:00:00.000Z',
    roles: [],
    policies: [],
    bindings: {
      rolePolicies: [],
      userRoles: [],
      userPolicies: [],
      apiKeyRoles: [],
      apiKeyPolicies: [],
    },
    apiKeys: [],
  };
}

function dryRunResult(valid: boolean): AccessImportDryRunResult {
  return {
    dryRun: true,
    valid,
    errors: valid ? [] : [{ code: 'VALIDATION', message: 'blocked' }],
    diff: diff(),
    conflicts: {
      ok: valid,
      conflicts: valid
        ? []
        : [{
            severity: 'blocking',
            collection: 'posts',
            action: 'read',
            existingPolicy: 'policy:public',
            incomingPolicy: 'policy:editor',
            reason: 'UNCONDITIONAL_RULE_WIDENS_RESTRICTED_RULE',
          }],
      warnings: [],
    },
  };
}

function diff(): AccessImportDiff {
  return {
    roles: { create: 1, update: 0, unchanged: 0, delete: 0, entries: [] },
    policies: { create: 0, update: 1, unchanged: 0, delete: 0, entries: [] },
    apiKeys: { create: 0, update: 0, unchanged: 1, delete: 0, entries: [] },
    bindings: {
      rolePolicies: { create: 1, update: 0, unchanged: 0, delete: 0, entries: [] },
      userRoles: { create: 0, update: 0, unchanged: 1, delete: 0, entries: [] },
      userPolicies: { create: 0, update: 0, unchanged: 0, delete: 1, entries: [] },
      apiKeyRoles: { create: 0, update: 0, unchanged: 0, delete: 0, entries: [] },
      apiKeyPolicies: { create: 0, update: 0, unchanged: 0, delete: 0, entries: [] },
    },
  };
}
