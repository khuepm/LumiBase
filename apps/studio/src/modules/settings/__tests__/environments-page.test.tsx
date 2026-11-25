// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * Settings → Environments (#853 tasks 5.5, 7.8): hidden while the release
 * flag is off, forks with the chosen scope, shows the schema and content
 * dry-run plans grouped by action, and refuses to manage environments from
 * inside one.
 */

const rawRequest = vi.hoisted(() => vi.fn());
const setActiveSite = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ getApiClient: () => ({ rawRequest }), setActiveSite }));

import { EnvironmentsSettingsPage } from '../environments-page';

const ENV = {
  id: 'env_1',
  key: 'staging',
  name: 'Staging',
  status: 'ready',
  statusReason: null,
  siteId: 'child_1',
  originSiteId: 'origin_1',
  contentScope: { mode: 'all' },
  progress: { phase: 'done', counts: { items: 3 } },
  forkedAt: '2026-11-20T00:00:00Z',
  mergedAt: null,
  createdAt: '2026-11-20T00:00:00Z',
};

let flagOn = true;
let insideEnvironment = false;

function route(path: string, init?: RequestInit) {
  if (path === '/api/v1/release-flags') return { data: flagOn ? [{ key: 'content-environments', enabled: true }] : [] };
  if (path === '/api/v1/settings/environment.origin') {
    if (insideEnvironment) return { data: { value: { originSiteId: 'origin_1', key: 'staging' } } };
    throw Object.assign(new Error('not found'), { status: 404 });
  }
  if (path === '/api/v1/collections') return { data: [{ name: 'posts' }, { name: 'lumibase_users', system: true }] };
  if (path === '/api/v1/environments' && !init) return { data: [ENV] };
  if (path === '/api/v1/environments' && init?.method === 'POST') return { data: { ...ENV, id: 'env_2', key: 'qa', status: 'forking' } };
  if (path.endsWith('/promote/schema')) {
    return {
      data: {
        plan: {
          entries: [
            { kind: 'field', key: 'posts.excerpt', collection: 'posts', action: 'rename', renameFrom: 'summary', risk: 'high', requires: ['confirmRiskyChange'] },
            { kind: 'field', key: 'posts.title', collection: 'posts', action: 'unchanged', risk: 'low' },
          ],
          counts: {},
          pendingCollections: ['posts'],
          clean: false,
        },
      },
    };
  }
  if (path.endsWith('/promote/content')) {
    return {
      data: {
        plan: {
          items: [
            { collection: 'posts', itemId: 'hello', action: 'promote', changedFields: ['title'] },
            { collection: 'posts', itemId: 'bye', action: 'conflict', reason: 'ORIGIN_CHANGED' },
            { collection: 'posts', itemId: 'same', action: 'unchanged' },
          ],
          counts: {},
          truncated: false,
        },
      },
    };
  }
  throw new Error(`unexpected ${path}`);
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <EnvironmentsSettingsPage />
    </QueryClientProvider>,
  );
}

describe('EnvironmentsSettingsPage', () => {
  beforeEach(() => {
    flagOn = true;
    insideEnvironment = false;
    rawRequest.mockImplementation(async (path: string, init?: RequestInit) => route(path, init));
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('says the feature is off while the release flag is off', async () => {
    flagOn = false;
    renderPage();
    expect(await screen.findByText('Environments are not enabled on this site.')).toBeTruthy();
    expect(rawRequest.mock.calls.some((c) => c[0] === '/api/v1/environments')).toBe(false);
  });

  it('forks with the chosen collections', async () => {
    renderPage();
    expect(await screen.findByText('Staging')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('staging'), { target: { value: 'qa' } });
    fireEvent.change(screen.getByPlaceholderText('Redesign 2027'), { target: { value: 'QA' } });
    fireEvent.change(screen.getByLabelText('Content'), { target: { value: 'collections' } });
    fireEvent.click(await screen.findByLabelText('posts'));
    expect(screen.queryByLabelText('lumibase_users')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Fork' }));
    await waitFor(() => expect(rawRequest.mock.calls.some((c) => c[1]?.method === 'POST' && c[0] === '/api/v1/environments')).toBe(true));
    const call = rawRequest.mock.calls.find((c) => c[1]?.method === 'POST' && c[0] === '/api/v1/environments')!;
    expect(JSON.parse(String(call[1].body))).toEqual({ key: 'qa', name: 'QA', contentScope: { mode: 'collections', collections: ['posts'] } });
  });

  it('shows the dry-run plans, hides unchanged rows and warns that a schema promote is final', async () => {
    renderPage();
    await screen.findByText('Staging');
    const [schemaPreview, contentPreview] = screen.getAllByRole('button', { name: 'Preview changes' });
    fireEvent.click(schemaPreview!);
    expect(await screen.findByText('posts.excerpt')).toBeTruthy();
    expect(screen.getByText(/rename \(from summary\)/)).toBeTruthy();
    expect(screen.queryByText('posts.title')).toBeNull();
    expect(screen.getByText(/cannot be undone/)).toBeTruthy();

    fireEvent.click(contentPreview!);
    expect(await screen.findByText('promote · 1')).toBeTruthy();
    expect(screen.getByText('conflict · 1')).toBeTruthy();
    expect(screen.getByText('ORIGIN_CHANGED')).toBeTruthy();
    expect(screen.queryByText(/posts\/same/)).toBeNull();
    // Dry-runs only: nothing was applied.
    expect(rawRequest.mock.calls.filter((c) => String(c[1]?.body ?? '').includes('"dryRun":false'))).toEqual([]);
  });

  it('switches Studio into the environment', async () => {
    const reload = vi.fn();
    Object.defineProperty(window, 'location', { value: { ...window.location, reload }, writable: true });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Open in Studio/ }));
    await waitFor(() => expect(setActiveSite).toHaveBeenCalledWith('child_1'));
    expect(reload).toHaveBeenCalled();
  });

  it('does not manage environments from inside one', async () => {
    insideEnvironment = true;
    renderPage();
    expect(await screen.findByText(/You are inside an environment/)).toBeTruthy();
    expect(rawRequest.mock.calls.some((c) => c[0] === '/api/v1/environments')).toBe(false);
  });
});
