// @vitest-environment jsdom
/**
 * Settings → AI decisions (Jev J09, #516): the site-admin toggle and kill
 * switch write the existing `aiDecisions` setting through the settings API,
 * keep the fields this page does not edit, and delete nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LumiError } from '@lumibase/sdk';

let stored: Record<string, unknown> | null;
const set = vi.fn();
const del = vi.fn();
const client = {
  settings: {
    get: vi.fn(async () => {
      if (stored === null) throw new LumiError(404, { errors: [{ code: 'NOT_FOUND' }] }, new Headers());
      return { data: { key: 'aiDecisions', value: stored } };
    }),
    set,
    delete: del,
  },
  schema: {
    listCollections: async () => ({
      data: [
        { name: 'posts', label: 'Posts', system: false },
        { name: 'pages', label: 'Pages', system: false },
        { name: 'lumibase_ai_decisions', system: true },
      ],
    }),
  },
};

vi.mock('@/lib/api', () => ({ getApiClient: () => client }));

import { AiDecisionsSettingsPage } from '../ai-decisions-settings';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AiDecisionsSettingsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  stored = {
    enabled: true,
    allowedStateFields: ['title', 'body'],
    requestsPerHour: 50,
    review: { enabled: false, pilotCollections: [], mode: 'baseline' },
  };
  set.mockResolvedValue({ data: {} });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AI decisions settings', () => {
  it('enables the pilot on chosen collections and keeps the fields it does not edit', async () => {
    renderPage();
    expect(await screen.findByTestId('ai-decisions-status')).toHaveTextContent('Draft-review pilot is off.');
    // System collections are not offered.
    expect(screen.queryByLabelText('lumibase_ai_decisions')).toBeNull();

    fireEvent.click(screen.getByLabelText(/Run the draft-review pilot/));
    fireEvent.click(screen.getByLabelText('Posts'));
    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'assisted' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set).toHaveBeenCalledWith('aiDecisions', {
      enabled: true,
      allowedStateFields: ['title', 'body'],
      requestsPerHour: 50,
      review: { enabled: true, pilotCollections: ['posts'], mode: 'assisted' },
    });
    expect(await screen.findByText('Settings saved.')).toBeInTheDocument();
  });

  it('refuses to save an enabled pilot with no collection', async () => {
    renderPage();
    fireEvent.click(await screen.findByLabelText(/Run the draft-review pilot/));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Choose at least one pilot collection');
    expect(set).not.toHaveBeenCalled();
  });

  it('the kill switch turns decisions and the pilot off in one write and deletes nothing', async () => {
    stored = { ...stored, review: { enabled: true, pilotCollections: ['posts'], mode: 'assisted' } };
    renderPage();
    expect(await screen.findByTestId('ai-decisions-status')).toHaveTextContent(
      'Decisions are on. Draft-review pilot: assisted on posts.',
    );

    fireEvent.click(screen.getByRole('button', { name: /Turn everything off/ }));

    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set).toHaveBeenCalledWith('aiDecisions', {
      enabled: false,
      allowedStateFields: ['title', 'body'],
      requestsPerHour: 50,
      // The pilot list is kept so turning it back on is one click.
      review: { enabled: false, pilotCollections: ['posts'], mode: 'assisted' },
    });
    expect(del).not.toHaveBeenCalled();
    expect(await screen.findByText(/Existing reviews, feedback and sessions are kept/)).toBeInTheDocument();
  });

  it('starts from everything off when the setting does not exist', async () => {
    stored = null;
    renderPage();
    expect(await screen.findByTestId('ai-decisions-status')).toHaveTextContent(
      'Decisions are off. Draft-review pilot is off.',
    );
    expect(screen.getByLabelText(/Send content to the decision provider/)).not.toBeChecked();
  });

  it('explains a 403 from a non-admin save', async () => {
    set.mockRejectedValue(new LumiError(403, { errors: [{ code: 'FORBIDDEN' }] }, new Headers()));
    renderPage();
    fireEvent.click(await screen.findByLabelText(/Send content to the decision provider/));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('requires site admin access');
  });

  it('is reachable from the settings nav on both route trees', () => {
    const src = resolve(__dirname, '../../..');
    const router = readFileSync(resolve(src, 'router.tsx'), 'utf8');
    const layout = readFileSync(resolve(src, 'modules/settings/layout.tsx'), 'utf8');
    expect(router.match(/path: 'ai-decisions',/g)).toHaveLength(2);
    expect(router).toContain('aiDecisionsSettingsRoute,');
    expect(router).toContain('adminPathAiDecisionsSettingsRoute,');
    expect(layout).toContain("{ id: 'ai-decisions', label: 'AI decisions', to: '/settings/ai-decisions' }");
  });
});
