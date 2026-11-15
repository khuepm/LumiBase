// @vitest-environment jsdom
/**
 * Folder-mode permissions (#749): without `delete` the item editor renders no
 * Delete action at all (it used to render a disabled one); with `delete` it is
 * there. Editing (update) is unaffected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

const granted = new Set<string>();

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ collection: 'folders', id: 'root' }),
  useNavigate: () => vi.fn(),
  useSearch: () => ({}),
  Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
}));
vi.mock('@/lib/api', () => ({
  getApiClient: () => ({
    schema: {
      listFields: async () => ({ data: [] }),
      getCollection: async () => ({ data: { name: 'folders', meta: { tree: { enabled: true } } } }),
    },
    settings: { get: async () => ({ data: null }) },
    items: () => ({
      detail: async () => ({
        data: { id: 'root', status: 'draft', data: {}, sort: 0, updatedAt: '2026-11-15T00:00:00Z', createdAt: '2026-11-15T00:00:00Z' },
      }),
      listPins: async () => ({ data: { pinnedFields: [] } }),
      listRevisions: async () => ({ data: [] }),
    }),
  }),
}));
vi.mock('@/lib/use-permissions', () => ({
  usePermissions: () => ({
    isLoading: false,
    isAdmin: false,
    can: (_c: string, action: string) => granted.has(action),
    fieldAllowed: () => true,
    filterFields: (_c: string, _a: string, f: string[]) => f,
  }),
}));
vi.mock('@/lib/extension-loader', () => ({ getExtension: () => undefined }));
vi.mock('@/lib/keybindings/use-keybindings', () => ({ useSaveHandler: () => undefined }));
vi.mock('@/components/presence-chip', () => ({ PresenceStack: () => null }));
vi.mock('@/components/co-editing-banner', () => ({ CoEditingBanner: () => null }));
vi.mock('@/hooks/use-presence', () => ({ useCoEditors: () => ({ coEditors: [] }) }));
vi.mock('../revisions-panel', () => ({ RevisionsPanel: () => null }));
vi.mock('../raw-json-panel', () => ({ RawJsonPanel: () => null }));
vi.mock('../version-panel', () => ({ VersionPanel: () => null }));
vi.mock('../translation-mode', () => ({ TranslationMode: () => null }));
vi.mock('../editorial-actions', () => ({ EditorialActions: () => null }));
vi.mock('../draft-review-panel', () => ({ DraftReviewPanel: () => null }));
vi.mock('../provenance-badge', () => ({ ProvenanceBadge: () => null }));
vi.mock('../use-site-locales', () => ({ useSiteLocales: () => ['en'] }));
vi.mock('../use-review-pilot', () => ({
  useReviewRollout: () => 'off',
  useReviewSession: () => ({ finish: () => undefined }),
}));
vi.mock('../use-save-action', () => ({
  useSaveAction: () => ({ effective: 'save', set: () => undefined }),
  saveActionLabel: () => 'Save',
}));

import { ItemDetailPage } from '../item-detail';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ItemDetailPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => granted.clear());
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('item editor — folder mode', () => {
  it('hides Delete when the policy denies delete', async () => {
    granted.add('read').add('update');
    renderPage();
    expect(await screen.findByRole('button', { name: /Share/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete$/ })).toBeNull();
  });

  it('shows Delete when delete is granted', async () => {
    granted.add('read').add('update').add('delete');
    renderPage();
    expect(await screen.findByRole('button', { name: /^Delete$/ })).toBeInTheDocument();
  });
});
