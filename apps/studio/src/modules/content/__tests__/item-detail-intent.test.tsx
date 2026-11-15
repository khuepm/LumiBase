// @vitest-environment jsdom
/**
 * Acceptance for #759 at the editor level: a link with `?locale=&field=` opens
 * the real `ItemDetailPage` on the right locale and focuses the exact field.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { FieldResource } from '@lumibase/sdk';

const state = vi.hoisted(() => ({
  search: {} as Record<string, unknown>,
  locales: ['en', 'vi'] as string[],
}));

const FIELDS = [
  { id: 'f_slug', name: 'slug', type: 'string', interface: 'input', sortOrder: 1 },
  { id: 'f_title', name: 'title', type: 'json', interface: 'translatable-text', sortOrder: 2 },
] as unknown as FieldResource[];

const ITEM = {
  id: 'item_1',
  siteId: 'site_1',
  collectionId: 'c1',
  status: 'draft',
  data: { slug: 'hello', title: { en: 'Hello', vi: 'Xin chào' } },
  sort: 0,
  editorialState: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  publishAt: null,
  unpublishAt: null,
};

const rawRequest = vi.fn(async (path: string) => {
  if (path.startsWith('/api/v1/ai/reviews/rollout')) return { data: { collection: 'posts', mode: 'off' } };
  return { data: {} };
});

const client = {
  rawRequest,
  request: rawRequest,
  schema: {
    listFields: async () => ({ data: FIELDS }),
    getCollection: async () => ({ data: { meta: { editorialWorkflow: false } } }),
  },
  settings: {
    get: async (key: string) =>
      key === 'locales' ? { data: { value: { supported: state.locales } } } : { data: null },
  },
  site: { get: async () => ({ data: {} }) },
  permissions: { me: async () => ({ data: { admin: true, byKey: {} } }) },
  roles: { list: async () => ({ data: [] }) },
  tm: { upsert: vi.fn(), suggest: vi.fn(async () => ({ data: [] })) },
  items: () => ({
    detail: async () => ({ data: ITEM }),
    listPins: async () => ({ data: { pinnedFields: [] } }),
    listRevisions: async () => ({ data: [] }),
    releasePin: vi.fn(),
    patch: vi.fn(),
    create: vi.fn(),
  }),
};

vi.mock('@/lib/api', () => ({ getApiClient: () => client, hasActiveToken: () => true }));
vi.mock('@/lib/extension-loader', () => ({ getExtension: () => undefined }));
vi.mock('@/hooks/use-presence', () => ({ useCoEditors: () => ({ coEditors: [], connected: false }) }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  useNavigate: () => vi.fn(),
  useParams: () => ({ collection: 'posts', id: 'item_1' }),
  useSearch: () => state.search,
}));

import { ItemDetailPage } from '../item-detail';

function renderPage(search: Record<string, unknown>, locales = ['en', 'vi']) {
  state.search = search;
  state.locales = locales;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ItemDetailPage />
    </QueryClientProvider>,
  );
}

afterEach(() => cleanup());

describe('ItemDetailPage — intent locale + field', () => {
  it('opens Translation mode in the requested locale and focuses that field’s target editor', async () => {
    renderPage({ locale: 'vi', field: 'title' });
    const target = await screen.findByLabelText('title target (vi)');
    await waitFor(() => expect(document.activeElement).toBe(target));
    expect(screen.getByLabelText('Target locale')).toHaveValue('vi');
  });

  it('focuses a field on the Fields tab for the source locale', async () => {
    renderPage({ locale: 'en', field: 'slug' });
    await waitFor(() => {
      const anchor = document.querySelector('[data-field-anchor="slug"]');
      expect(anchor?.contains(document.activeElement)).toBe(true);
    });
  });

  it('explains a locale the site does not enable instead of silently dropping it', async () => {
    renderPage({ locale: 'fr', field: 'slug' });
    expect(await screen.findByText(/does not enable/)).toBeInTheDocument();
  });

  it('explains an unknown field', async () => {
    renderPage({ field: 'ghost' });
    expect(await screen.findByText(/The linked field “ghost” is not available/)).toBeInTheDocument();
  });
});
