/**
 * Integration tests for the Lumibase Docs Viewer.
 *
 * Tests end-to-end flows:
 * - Full app render with test markdown files
 * - Sidebar navigation triggers correct page loads
 * - Search indexes documents and returns results
 * - Internal link navigation works without page reload
 *
 * Requirements: 3.2, 5.2, 7.4, 8.2
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { Layout } from '../components/Layout';
import { LocaleGuard } from '../components/LocaleGuard';
import { LegacyRedirect } from '../components/LegacyRedirect';
import { DocPage } from '../pages/DocPage';
import { NotFoundPage } from '../pages/NotFoundPage';

// Mock IntersectionObserver for jsdom (used by TableOfContents)
beforeAll(() => {
  const mockIntersectionObserver = vi.fn().mockImplementation(() => ({
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
    root: null,
    rootMargin: '',
    thresholds: [],
    takeRecords: () => [],
  }));
  vi.stubGlobal('IntersectionObserver', mockIntersectionObserver);

  // Patch global Request to handle AbortSignal compatibility issue
  // React Router v7 creates Request objects with AbortSignal for navigation,
  // but jsdom's Request doesn't accept vitest's AbortSignal instances.
  const OriginalRequest = globalThis.Request;
  vi.stubGlobal(
    'Request',
    class PatchedRequest extends OriginalRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        if (init?.signal) {
          // Remove signal to avoid the AbortSignal compatibility issue
          const { signal: _signal, ...rest } = init;
          super(input, rest);
        } else {
          super(input, init);
        }
      }
    },
  );
});

afterEach(() => {
  cleanup();
});

// Mock the virtual:docs-registry module with test data
vi.mock('virtual:docs-registry', () => {
  const testDocIndex: Record<string, {
    slug: string;
    locale: string;
    title: string;
    filePath: string;
    content: string;
    lastModified?: string;
  }> = {
    README: {
      slug: 'README',
      locale: 'en',
      title: 'Lumibase Documentation',
      filePath: 'en/README.md',
      content: '# Welcome\n\nThis is the main documentation page.\n\n## Getting Started\n\nRead the [Collections Guide](./features/collections.md) to begin.\n\nVisit [External Site](https://example.com) for more info.',
      lastModified: '2024-06-15T10:00:00Z',
    },
    'features/collections': {
      slug: 'features/collections',
      locale: 'en',
      title: 'Collections Builder',
      filePath: 'en/features/collections.md',
      content: '# Collections Builder\n\n## Overview\n\nCreate and manage collections with the visual builder.\n\n## Configuration\n\nSee [Relations](./relations.md) for linking collections.\n\nSee [README](../README.md) for the main docs.',
      lastModified: '2024-07-01T14:30:00Z',
    },
    'features/relations': {
      slug: 'features/relations',
      locale: 'en',
      title: 'Relations',
      filePath: 'en/features/relations.md',
      content: '# Relations\n\n## Defining Relations\n\nDefine relationships between collections using foreign keys.\n\n## Examples\n\nLink to [nonexistent](./nonexistent.md) doc.',
    },
  };

  const testDocTree = [
    {
      type: 'directory' as const,
      name: 'features',
      children: [
        { type: 'file' as const, name: 'Collections Builder', slug: 'features/collections' },
        { type: 'file' as const, name: 'Relations', slug: 'features/relations' },
      ],
    },
    { type: 'file' as const, name: 'Lumibase Documentation', slug: 'README' },
  ];

  const testDocList = Object.values(testDocIndex);

  return {
    locales: ['en', 'vi'],
    defaultLocale: 'en',
    localeNames: { en: 'English', vi: 'Tiếng Việt' },
    docTree: testDocTree,
    docTreeUnion: testDocTree,
    docTreeByLocale: { en: testDocTree, vi: [] },
    docIndex: testDocIndex,
    docIndexByLocale: { en: testDocIndex, vi: {} },
    docList: testDocList,
    docSlugsByLocale: { en: ['README', 'features/collections', 'features/relations'], vi: [] },
  };
});

// Mock shiki/rehype-shiki to avoid loading WASM in tests
vi.mock('@shikijs/rehype', () => ({
  default: () => () => { },
}));

/**
 * Helper to render the app with a memory router at a given initial path.
 * Uses the same route structure as the real app (locale-prefixed).
 */
function renderApp(initialPath: string) {
  const router = createMemoryRouter(
    [
      {
        path: '/docs/*',
        element: <LegacyRedirect />,
      },
      {
        path: '/:locale',
        element: <LocaleGuard><Layout /></LocaleGuard>,
        children: [
          {
            path: 'docs/*',
            element: <DocPage />,
          },
          {
            path: '*',
            element: <NotFoundPage />,
          },
        ],
      },
      {
        path: '*',
        element: <NotFoundPage />,
      },
    ],
    { initialEntries: [initialPath] },
  );

  return render(<RouterProvider router={router} />);
}

describe('Integration: Full app render', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the layout with sidebar and content area', async () => {
    renderApp('/en/docs/README');

    // Sidebar should show the doc tree
    await waitFor(() => {
      expect(screen.getByLabelText('Documentation navigation')).toBeInTheDocument();
    });

    // Should show the document title
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: 'Lumibase Documentation' })).toBeInTheDocument();
    });
  });

  it('renders the correct document content for a given slug', async () => {
    renderApp('/en/docs/features/collections');

    // The DocPage renders the title in a header section
    await waitFor(() => {
      // Find the title in the page header (not the markdown-rendered one)
      const headings = screen.getAllByRole('heading', { level: 1, name: 'Collections Builder' });
      expect(headings.length).toBeGreaterThanOrEqual(1);
    });

    // Should display last-modified date in DD/MM/YYYY format
    await waitFor(() => {
      expect(screen.getByText(/01\/07\/2024/)).toBeInTheDocument();
    });
  });

  it('sets the browser title to "{title} — Lumibase Docs"', async () => {
    renderApp('/en/docs/README');

    await waitFor(() => {
      expect(document.title).toBe('Lumibase Documentation — Lumibase Docs');
    });
  });

  it('shows 404 page for unknown slugs', async () => {
    // Navigate to a path that doesn't match /docs/* — goes directly to catch-all
    renderApp('/unknown-path');

    await waitFor(() => {
      expect(screen.getByText('404 — Document Not Found')).toBeInTheDocument();
    });

    // Should have a link back to home
    expect(screen.getByRole('link', { name: /back to documentation home/i })).toHaveAttribute('href', '/docs/README');
  });
});

describe('Integration: Sidebar navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders sidebar with all documents from the doc tree', async () => {
    renderApp('/en/docs/README');

    const nav = await waitFor(() => screen.getByLabelText('Documentation navigation'));

    // Should show directory group (features directory is expanded by default)
    expect(screen.getByText('features')).toBeInTheDocument();

    // Should show file entries within the nav (features is expanded by default in the mock)
    expect(nav.querySelector('button span')).not.toBeNull();

    // Check that all expected items are in the sidebar nav
    const navButtons = Array.from(nav.querySelectorAll('button'));
    const navTexts = navButtons.map((btn) => btn.textContent?.trim());
    expect(navTexts).toContain('Collections Builder');
    expect(navTexts).toContain('Relations');
    expect(navTexts.some((t) => t?.includes('Lumibase Documentation'))).toBe(true);
  });

  it('navigates to a document when clicking a sidebar link', async () => {
    renderApp('/en/docs/README');

    // Wait for initial render
    await waitFor(() => {
      expect(screen.getByLabelText('Documentation navigation')).toBeInTheDocument();
    });

    // The features directory should be expanded by default (useSidebarState defaults to expanded)
    // Find the "Collections Builder" button in the sidebar nav
    const nav = screen.getByLabelText('Documentation navigation');
    const collectionsButton = Array.from(nav.querySelectorAll('button')).find(
      (btn) => btn.textContent?.includes('Collections Builder'),
    );
    expect(collectionsButton).toBeDefined();

    // Click on "Collections Builder" in the sidebar
    await act(async () => {
      fireEvent.click(collectionsButton!);
    });

    // Should navigate to the collections page without full page reload
    // The page title in the header should update
    await waitFor(() => {
      const headings = screen.getAllByRole('heading', { level: 1, name: 'Collections Builder' });
      expect(headings.length).toBeGreaterThanOrEqual(1);
    });

    // Browser title should update
    await waitFor(() => {
      expect(document.title).toBe('Collections Builder — Lumibase Docs');
    });
  });

  it('highlights the active document in the sidebar', async () => {
    renderApp('/en/docs/README');

    await waitFor(() => {
      expect(screen.getByLabelText('Documentation navigation')).toBeInTheDocument();
    });

    // The README entry should be marked as current page
    const activeButton = screen.getByRole('button', { current: 'page' });
    expect(activeButton).toBeInTheDocument();
    expect(activeButton).toHaveTextContent('Lumibase Documentation');
  });

  it('toggles directory expanded/collapsed state', async () => {
    renderApp('/en/docs/README');

    await waitFor(() => {
      expect(screen.getByText('features')).toBeInTheDocument();
    });

    const featuresButton = screen.getByText('features').closest('button')!;

    // Initially the directory might be expanded or collapsed depending on localStorage state
    // Click to toggle
    await act(async () => {
      fireEvent.click(featuresButton);
    });

    // Check aria-expanded attribute toggles
    const isExpanded = featuresButton.getAttribute('aria-expanded');

    await act(async () => {
      fireEvent.click(featuresButton);
    });

    const isExpandedAfter = featuresButton.getAttribute('aria-expanded');
    expect(isExpanded).not.toBe(isExpandedAfter);
  });
});

describe('Integration: Search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens search dialog and indexes documents', async () => {
    renderApp('/en/docs/README');

    // Find and click the search button
    const searchButton = await waitFor(() =>
      screen.getByLabelText(/search documentation/i),
    );

    await act(async () => {
      fireEvent.click(searchButton);
    });

    // Search dialog should open
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    // Type a search query
    const searchInput = screen.getByLabelText('Search query');
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: 'collections' } });
    });

    // Should show search results
    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument();
    });

    // Should find the collections document
    await waitFor(() => {
      const options = screen.getAllByRole('option');
      expect(options.length).toBeGreaterThan(0);
      expect(options.some((opt) => opt.textContent?.includes('Collections Builder'))).toBe(true);
    });
  });

  it('navigates to a document when selecting a search result', async () => {
    renderApp('/en/docs/README');

    // Open search
    const searchButton = await waitFor(() =>
      screen.getByLabelText(/search documentation/i),
    );
    await act(async () => {
      fireEvent.click(searchButton);
    });

    // Type query
    const searchInput = await waitFor(() => screen.getByLabelText('Search query'));
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: 'relations' } });
    });

    // Wait for results
    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument();
    });

    // Click on the first result
    const options = screen.getAllByRole('option');
    await act(async () => {
      fireEvent.click(options[0]!);
    });

    // Should navigate to the relations page
    await waitFor(() => {
      const headings = screen.getAllByRole('heading', { level: 1, name: 'Relations' });
      expect(headings.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('shows "no results" message for unmatched queries', async () => {
    renderApp('/en/docs/README');

    const searchButton = await waitFor(() =>
      screen.getByLabelText(/search documentation/i),
    );
    await act(async () => {
      fireEvent.click(searchButton);
    });

    const searchInput = screen.getByLabelText('Search query');
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: 'xyznonexistent' } });
    });

    await waitFor(() => {
      expect(screen.getByText(/no results found/i)).toBeInTheDocument();
    });
  });
});

describe('Integration: Internal link navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rewrites relative .md links to internal navigation links', async () => {
    renderApp('/en/docs/README');

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: 'Lumibase Documentation' })).toBeInTheDocument();
    });

    // The markdown content has a link to ./features/collections.md
    // It should be rewritten to /docs/features/collections
    await waitFor(() => {
      const link = screen.getByRole('link', { name: 'Collections Guide' });
      expect(link).toHaveAttribute('href', '/docs/features/collections');
    });
  });

  it('navigates to target page when clicking an internal link', async () => {
    renderApp('/en/docs/README');

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: 'Lumibase Documentation' })).toBeInTheDocument();
    });

    // Click the internal link
    const link = await waitFor(() => screen.getByRole('link', { name: 'Collections Guide' }));
    await act(async () => {
      fireEvent.click(link);
    });

    // Should navigate to the collections page without full page reload
    await waitFor(() => {
      const headings = screen.getAllByRole('heading', { level: 1, name: 'Collections Builder' });
      expect(headings.length).toBeGreaterThanOrEqual(1);
    });

    // Browser title should update
    await waitFor(() => {
      expect(document.title).toBe('Collections Builder — Lumibase Docs');
    });
  });

  it('renders external links with target="_blank" and rel="noopener noreferrer"', async () => {
    renderApp('/en/docs/README');

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: 'Lumibase Documentation' })).toBeInTheDocument();
    });

    await waitFor(() => {
      const externalLink = screen.getByRole('link', { name: 'External Site' });
      expect(externalLink).toHaveAttribute('href', 'https://example.com');
      expect(externalLink).toHaveAttribute('target', '_blank');
      expect(externalLink).toHaveAttribute('rel', 'noopener noreferrer');
    });
  });

  it('renders broken links with strikethrough style and prevents navigation', async () => {
    renderApp('/en/docs/features/relations');

    await waitFor(() => {
      const headings = screen.getAllByRole('heading', { level: 1, name: 'Relations' });
      expect(headings.length).toBeGreaterThanOrEqual(1);
    });

    // The relations doc has a link to ./nonexistent.md which should be broken
    await waitFor(() => {
      const brokenLink = screen.getByRole('link', { name: 'nonexistent' });
      expect(brokenLink).toHaveClass('line-through');
      expect(brokenLink).toHaveAttribute('aria-disabled', 'true');
    });
  });

  it('navigates between documents using internal links without page reload', async () => {
    renderApp('/en/docs/features/collections');

    // Wait for collections page
    await waitFor(() => {
      const headings = screen.getAllByRole('heading', { level: 1, name: 'Collections Builder' });
      expect(headings.length).toBeGreaterThanOrEqual(1);
    });

    // Click link to README (../README.md)
    const readmeLink = await waitFor(() => screen.getByRole('link', { name: 'README' }));
    await act(async () => {
      fireEvent.click(readmeLink);
    });

    // Should navigate to README page
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: 'Lumibase Documentation' })).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(document.title).toBe('Lumibase Documentation — Lumibase Docs');
    });
  });
});
