// @vitest-environment jsdom
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

import { clearRuntimeApiBaseUrl, setRuntimeApiBaseUrl } from '@/lib/api-base';
import { useCompleteSetup } from '../hooks/use-complete-setup';
import { useSetupCapabilities } from '../hooks/use-setup-capabilities';
import { setAccountDraft } from '../steps/step-account';
import { setPathDraft } from '../steps/step-path';
import { setPolicyDraft } from '../steps/step-security';
import { setProjectDraft } from '../steps/step-project';
import { STANDARD_PRESET, lockoutPolicySchema } from '../schemas/policy';

/**
 * Shell contract C2 (`apps/shell/README.md`): every Setup Wizard request
 * resolves the CMS origin through `getApiBaseUrl()`. In the bundled
 * desktop/mobile shell the SPA runs at `tauri://localhost`, so a same-origin
 * `/api/...` path never reaches the CMS and first-run setup cannot finish.
 */

const CMS = 'https://cms.example.test';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client }, children);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => setRuntimeApiBaseUrl(CMS));
afterEach(() => {
  clearRuntimeApiBaseUrl();
  vi.restoreAllMocks();
});

describe('Setup Wizard requests honour the runtime API base (C2)', () => {
  it('GET /setup/capabilities goes to the configured CMS origin', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}));
    renderHook(() => useSetupCapabilities(), { wrapper });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`${CMS}/api/v1/setup/capabilities`);
  });

  it('POST /setup/complete goes to the configured CMS origin', async () => {
    setAccountDraft({
      email: 'admin@example.com',
      password: 'CorrectHorse!Battery9',
      confirmPassword: 'CorrectHorse!Battery9',
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
    setPathDraft({ adminPath: '/lumi-quiet-otter' });
    setPolicyDraft(lockoutPolicySchema.parse({ ...STANDARD_PRESET }));
    setProjectDraft({
      defaultLanguage: 'en',
      siteUrl: 'https://example.com',
      displayTitle: 'LumiBase',
      theme: null,
    } as Parameters<typeof setProjectDraft>[0]);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(
        {
          user: { id: 'u1', email: 'admin@example.com', firstName: 'Ada', lastName: 'Lovelace' },
          adminPath: '/lumi-quiet-otter',
          backupCodes: ['a'],
          setupToken: null,
        },
        201,
      ),
    );
    const { result } = renderHook(() => useCompleteSetup(), { wrapper });
    result.current.mutate({});
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`${CMS}/api/v1/setup/complete`);
  });
});

describe('Setup module source tripwire (C2)', () => {
  it('no setup source calls fetch with a hardcoded same-origin /api path', () => {
    const root = resolve(__dirname, '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== '__tests__') walk(path);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(name)) continue;
        const src = readFileSync(path, 'utf8');
        if (/fetch\(\s*['"`]\/api\//.test(src)) offenders.push(relative(root, path));
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
