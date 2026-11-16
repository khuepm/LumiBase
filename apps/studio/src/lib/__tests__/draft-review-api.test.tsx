// @vitest-environment jsdom
/**
 * Shell contract for draft review (Jev J08, #515; `apps/shell/README.md`
 * "Contracts future work must not break", C1/C2).
 *
 * The bundled desktop/mobile shell serves the Studio from `tauri://localhost`,
 * with the CMS origin chosen at runtime and the session token in the OS
 * keychain. A panel that built its own URL or read the token from storage
 * would work in the browser and break there. This test renders the real panel
 * against the real `getApiClient()` and asserts every review call goes to
 * `getApiBaseUrl()` with the token-store bearer and the active site; a
 * source scan keeps the review files off raw `fetch`, storage and env.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { FieldResource } from '@lumibase/sdk';
import { setActiveSite, setActiveToken, clearActiveToken } from '@/lib/api';
import { RUNTIME_API_BASE_KEY, getApiBaseUrl } from '@/lib/api-base';
import { readToken } from '@/lib/token-store';
import type { PermissionHelpers } from '@/lib/use-permissions';
import { DraftReviewPanel } from '@/modules/content/draft-review-panel';

const BASE = 'https://cms.example.test';

const PROFILE = {
  id: 'prof_1',
  key: 'taxonomy',
  version: 1,
  status: 'active',
  collection: 'posts',
  preset: null,
  fields: ['title'],
  questions: { category: { type: 'choice', instructions: 'Which?', criteria: { news: null, other: null, unknown: null } } },
  sourceField: null,
  minConfidence: null,
  note: null,
  createdBy: null,
  createdAt: '2026-01-01T00:00:00Z',
};

const RUN = {
  id: 'run_1',
  profileId: 'prof_1',
  profileKey: 'taxonomy',
  profileVersion: 1,
  collection: 'posts',
  itemId: null,
  revisionId: null,
  contentHash: `sha256:${'0'.repeat(64)}`,
  source: 'snapshot',
  omittedFields: [],
  status: 'success',
  provider: 'typesafe',
  model: 'jev-1',
  calibrated: true,
  answers: { category: { type: 'choice', choice: 'news', probabilities: { news: 0.9, other: 0.05, unknown: 0.05 }, confidence: 0.9 } },
  usage: null,
  latencyMs: 1,
  errorCode: null,
  createdAt: '2026-01-01T00:00:00Z',
  completedAt: '2026-01-01T00:00:00Z',
  stale: false,
  staleReason: null,
  note: null,
};

const perms: PermissionHelpers = {
  bundle: undefined,
  isLoading: false,
  isAdmin: true,
  can: () => true,
  get: () => null,
  fieldAllowed: () => true,
  filterFields: (_c, _a, f) => f,
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(RUNTIME_API_BASE_KEY, BASE);
  setActiveSite('site_a');
  setActiveToken('tok_from_store');
});

afterEach(() => {
  cleanup();
  clearActiveToken();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('draft review API contract (web + shell)', () => {
  it('sends profile, review and feedback calls to getApiBaseUrl() with the token-store bearer', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/review-profiles')) return json([PROFILE]);
      if (url.endsWith('/api/v1/ai/reviews')) return json(RUN, 201);
      if (url.endsWith('/feedback')) return json([], 201);
      return json({});
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <DraftReviewPanel
          collection="posts"
          values={{ title: 'Hello' }}
          fields={[{ id: 'f1', name: 'title', type: 'string', interface: 'input' } as unknown as FieldResource]}
          writeAction="create"
          perms={perms}
          pinnedFields={[]}
          onApply={vi.fn()}
        />
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Review draft' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Accept the suggestion for Category' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    expect(getApiBaseUrl()).toBe(BASE);
    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls).toEqual([
      `${BASE}/api/v1/ai/review-profiles?collection=posts`,
      `${BASE}/api/v1/ai/reviews`,
      `${BASE}/api/v1/ai/reviews/run_1/feedback`,
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe(`Bearer ${readToken()}`);
      expect(headers.get('authorization')).toBe('Bearer tok_from_store');
      expect(headers.get('x-lumi-site')).toBe('site_a');
    }
  });

  it('keeps the review module off raw fetch, storage and build-time env', () => {
    const dir = resolve(__dirname, '../../modules/content');
    for (const file of ['draft-review-panel.tsx', 'use-draft-review.ts', 'draft-review-hash.ts', 'draft-review-i18n.ts']) {
      const source = readFileSync(resolve(dir, file), 'utf8');
      expect(source, file).not.toMatch(/\bfetch\s*\(/);
      expect(source, file).not.toMatch(/localStorage|sessionStorage/);
      expect(source, file).not.toMatch(/import\.meta\.env|VITE_API_URL/);
      expect(source, file).not.toMatch(/['"`]\/api\/v1/);
      // `legacyRest()` replaces `client.request` with `rawRequest`, so
      // `getApiClient().request(command)` would fetch `${base}${command}`.
      expect(source, file).not.toMatch(/\.request\(/);
    }
  });
});
