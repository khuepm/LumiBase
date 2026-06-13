// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * Artifact evaluate action tests (content-os-ui task 19.2).
 *
 * `fetch` is stubbed per-path: the page's initial load gets empty
 * collections except artifacts; clicking Evaluate must POST to the
 * evaluate endpoint with the artifact's own runId as query.
 *
 * **Validates: Requirements 19.1, 19.2**
 */

vi.mock('@/lib/api', () => ({
  getActiveToken: () => 'token',
  getActiveSite: () => 'site_1',
}));

import { AgentHarnessPage } from '../agent-harness-page';

const ARTIFACT = {
  id: 'art_1',
  runId: 'run_9',
  type: 'page_spec',
  title: 'Landing page spec',
  status: 'draft',
  hash: 'abc123',
  createdAt: new Date().toISOString(),
};

const fetchMock = vi.fn();

function jsonResponse(data: unknown) {
  return {
    ok: true,
    json: () => Promise.resolve({ data }),
  } as Response;
}

beforeEach(() => {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/artifacts/art_1/evaluate')) {
      return Promise.resolve(jsonResponse({ verdict: 'pass', score: 0.92 }));
    }
    if (url.endsWith('/artifacts')) return Promise.resolve(jsonResponse([ARTIFACT]));
    if (url.endsWith('/memory')) {
      return Promise.resolve(jsonResponse({ memories: [], recentRuns: [], approvedArtifacts: [] }));
    }
    void init;
    return Promise.resolve(jsonResponse([]));
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Artifacts tab — evaluate', () => {
  it('POSTs to the evaluate endpoint with the artifact runId and renders the result (Req 19)', async () => {
    render(<AgentHarnessPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Artifacts' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Evaluate' }));

    await waitFor(() => {
      const calls = fetchMock.mock.calls.map(([input]) => String(input));
      expect(calls.some((u) => u.includes('/api/v1/agent/artifacts/art_1/evaluate?runId=run_9'))).toBe(true);
    });
    const evalCall = fetchMock.mock.calls.find(([input]) =>
      String(input).includes('/evaluate'),
    );
    expect((evalCall?.[1] as RequestInit).method).toBe('POST');

    expect(await screen.findByText(/evaluation result for/i)).toBeInTheDocument();
    expect(screen.getByText(/"verdict": "pass"/)).toBeInTheDocument();
  });
});
