// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';

/** Page composer screen (epic #667, V06 #684). */

const rawRequest = vi.fn();
const listFields = vi.fn();
const listCollections = vi.fn();
const getSettings = vi.fn();
const getSetting = vi.fn();
vi.mock('@/lib/api', () => ({
  getApiClient: () => ({
    rawRequest,
    schema: { listFields, listCollections },
    preview: { getSettings },
    settings: { get: getSetting },
  }),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
  useParams: () => ({ id: 'pg_1' }),
  useNavigate: () => vi.fn(),
}));

import { PageComposer } from '../page-composer';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const blocks = [
  { name: 'hero', label: 'Hero', note: null, icon: null, fields: [] },
  { name: 'cta', label: 'Call to action', note: null, icon: null, fields: [] },
];

function field(name: string, extra: Record<string, unknown> = {}) {
  return { id: `f_${name}`, collectionId: 'c', name, type: 'string', interface: 'input', hidden: false, system: false, required: false, sortOrder: 0, ...extra };
}

function setup(layoutConfig: unknown, opts: { saveError?: unknown } = {}) {
  getSetting.mockResolvedValue({ data: { supported: ['en', 'vi'] } });
  listCollections.mockResolvedValue({ data: [{ name: 'posts' }, { name: 'lumibase_users' }] });
  listFields.mockImplementation(async (name: string) => ({
    data: name === 'hero' ? [field('title', { required: true }), field('secret', { encrypted: true })] : [field('label')],
  }));
  getSettings.mockResolvedValue({ data: { allowedOrigins: [], ttlSeconds: 900, pageUrl: 'https://www.example.com/{slug}' } });
  rawRequest.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
    if (path === '/api/v1/pages/blocks') return { data: blocks };
    if (init?.method === 'PATCH') {
      if (opts.saveError) throw opts.saveError;
      const body = JSON.parse(init.body ?? '{}') as { layoutConfig: unknown };
      return { data: { id: 'pg_1', slug: 'home', title: 'Home', layoutConfig: body.layoutConfig, updatedAt: '2030-01-02' } };
    }
    return { data: { id: 'pg_1', slug: 'home', title: 'Home', layoutConfig, updatedAt: '2030-01-01' } };
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PageComposer id="pg_1" />
    </QueryClientProvider>,
  );
}

const patchBody = () => {
  const call = rawRequest.mock.calls.find((c) => (c[1] as { method?: string } | undefined)?.method === 'PATCH');
  return JSON.parse((call![1] as { body: string }).body) as {
    layoutConfig: { version: number; regions: Array<{ key: string }>; sections: Array<{ component: string; data: Record<string, unknown>; styleConfig: Record<string, unknown> }> };
  };
};

describe('PageComposer', () => {
  it('composes a page from registered blocks, edits fields and locale visibility, and saves a v1 layout', async () => {
    setup({ version: 1, regions: [{ key: 'main' }], sections: [] });
    fireEvent.click(await screen.findByRole('button', { name: /Hero/ }));
    fireEvent.click(screen.getByRole('button', { name: /Call to action/ }));

    // The newly added section is selected; its form comes from the block's fields.
    const inspector = screen.getByRole('complementary', { name: 'Section settings' });
    expect(await within(inspector).findByText('label')).toBeTruthy();

    // Select the hero and fill its required title; encrypted fields are not offered.
    fireEvent.click(screen.getAllByRole('button', { name: /^Hero/ }).find((b) => b.getAttribute('aria-pressed') !== null)!);
    const title = await within(inspector).findByRole('textbox');
    expect(within(inspector).queryByText('secret')).toBeNull();
    fireEvent.change(title, { target: { value: 'Welcome' } });
    fireEvent.click(within(inspector).getByRole('checkbox', { name: 'vi' }));

    // Reorder with the keyboard-accessible buttons: hero moves below the CTA.
    fireEvent.click(screen.getByRole('button', { name: 'Move Hero down' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patchBody().layoutConfig.sections).toHaveLength(2));
    const saved = patchBody().layoutConfig;
    expect(saved.version).toBe(1);
    expect(saved.sections.map((s) => s.component)).toEqual(['cta', 'hero']);
    expect(saved.sections[1]!.data).toEqual({ title: 'Welcome' });
    expect(saved.sections[1]!.styleConfig).toEqual({ locales: ['vi'] });
    expect(await screen.findByRole('button', { name: 'Saved' })).toBeTruthy();
  });

  it('adds a region and moves a section into it', async () => {
    setup({ version: 1, regions: [{ key: 'main' }], sections: [{ id: 's1', component: 'hero', data: { title: 'x' } }] });
    fireEvent.change(await screen.findByLabelText('New region'), { target: { value: 'Side Bar' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('alert').textContent).toContain('lowercase');
    fireEvent.change(screen.getByLabelText('New region'), { target: { value: 'sidebar' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Region of Hero' }), { target: { value: 'sidebar' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patchBody().layoutConfig.regions.map((r) => r.key)).toEqual(['main', 'sidebar']));
    expect(patchBody().layoutConfig.sections[0]!.styleConfig).toEqual({ region: 'sidebar' });
  });

  it('shows server validation errors on the right section', async () => {
    setup(
      { version: 1, sections: [{ id: 's1', component: 'hero', data: {} }] },
      { saveError: Object.assign(new Error('400'), { body: { errors: [{ code: 'VALIDATION', message: 'Required', field: 'sections.0.data.title' }] } }) },
    );
    // Make the page dirty, then save.
    fireEvent.click(await screen.findByRole('button', { name: 'Duplicate Hero' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const alert = await screen.findByText('The page was not saved.');
    expect(alert.parentElement!.textContent).toContain('data.title — Required');
    expect((await screen.findAllByText('1 problem(s)')).length).toBeGreaterThan(0);
  });

  it('loads a pre-composer layout as-is and offers to save it as a composer layout', async () => {
    setup({ sections: [{ id: 'old', component: 'hero', data: { title: 'Legacy' } }] });
    expect(await screen.findByText(/built without the composer/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('previews the page at the configured page URL in a sandboxed frame', async () => {
    setup({ version: 1, sections: [] });
    fireEvent.click(await screen.findByRole('button', { name: /Preview/ }));
    const frame = (await screen.findByTitle('Preview of page home')) as HTMLIFrameElement;
    expect(frame.getAttribute('src')).toBe('https://www.example.com/home');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms allow-popups');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('keeps server errors on the submitted section after the editor reorders or deletes', async () => {
    setup(
      {
        version: 1,
        sections: [
          { id: 's1', component: 'cta', data: {} },
          { id: 's2', component: 'hero', data: {} },
        ],
      },
      { saveError: Object.assign(new Error('400'), { body: { errors: [{ code: 'VALIDATION', message: 'Required', field: 'sections.1.data.title' }] } }) },
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Move Hero up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('The page was not saved.');
    const hero = () => document.querySelector('[data-section="s2"]')!;
    const cta = () => document.querySelector('[data-section="s1"]')!;
    // Hero moved up before the save, so the submitted sections.1 is the CTA.
    expect(cta().textContent).toContain('1 problem(s)');
    expect(hero().textContent).not.toContain('problem');
    // Moving sections around afterwards must not move the marker.
    fireEvent.click(screen.getByRole('button', { name: 'Move Hero down' }));
    expect(cta().textContent).toContain('1 problem(s)');
    expect(hero().textContent).not.toContain('problem');
    // Deleting the failing section keeps the banner honest about it.
    fireEvent.click(screen.getByRole('button', { name: 'Remove Call to action' }));
    expect(screen.getByText('The page was not saved.').parentElement!.textContent).toContain('(removed since)');
  });

  it('adds to the main region after the selected target region is removed', async () => {
    setup({ version: 1, regions: [{ key: 'main' }], sections: [] });
    fireEvent.change(await screen.findByLabelText('New region'), { target: { value: 'sidebar' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.change(screen.getByLabelText('Add to region'), { target: { value: 'sidebar' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove region' }));
    expect((screen.getByLabelText('Add to region') as HTMLSelectElement).value).toBe('main');
    fireEvent.click(screen.getByRole('button', { name: /Hero/ }));
    expect(document.querySelector('[data-region="main"] [data-section]')).not.toBeNull();
  });

  it('names the keys a pre-composer layout loses on save', async () => {
    setup({ theme: 'dark', sections: [{ id: 'old', component: 'hero', data: {}, analyticsKey: 'h1' }] });
    const notice = await screen.findByText(/saving removes them/);
    expect(notice.textContent).toContain('theme');
    expect(notice.textContent).toContain('sections.0.analyticsKey');
  });

  it('lets the editor remove data the block does not define', async () => {
    setup({ version: 1, sections: [{ id: 's1', component: 'hero', data: { title: 'Hi', subtitle: 'legacy' } }] });
    fireEvent.click(await screen.findByRole('button', { name: /^Hero/, pressed: false }));
    const inspector = screen.getByRole('complementary', { name: 'Section settings' });
    fireEvent.click(await within(inspector).findByRole('button', { name: 'Remove subtitle' }));
    expect(within(inspector).queryByRole('button', { name: 'Remove subtitle' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patchBody().layoutConfig.sections[0]!.data).toEqual({ title: 'Hi' }));
  });

  it('keeps the slashes of a nested slug in the preview URL', async () => {
    const { buildPageUrl } = await import('../page-preview');
    expect(buildPageUrl('https://www.example.com/{slug}', 'about/team')).toBe('https://www.example.com/about/team');
    expect(buildPageUrl('https://www.example.com/p?s={slug}', 'a b')).toBe('https://www.example.com/p?s=a%20b');
    expect(buildPageUrl('javascript:alert(1)//{slug}', 'x')).toBeNull();
  });
});
