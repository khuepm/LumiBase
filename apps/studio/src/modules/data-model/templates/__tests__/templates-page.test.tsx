// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #908 (BT08) — the install review against a mocked CMS. Every request the
 * page sends is recorded, so each case asserts what actually goes over the
 * wire (site header, body, idempotency key), not only what is rendered.
 */

vi.mock('@/lib/api', () => ({
  getActiveSite: () => 'site_a',
  getActiveToken: () => 'tok',
  setActiveSite: vi.fn(),
  getApiClient: () => ({ orgs: { list: async () => [], sites: { list: async () => [] } } }),
}));
vi.mock('@/lib/api-base', () => ({ getApiBaseUrl: () => 'https://cms.test' }));

import { TemplatesPage } from '../page';
import { choicesKey, EMPTY_CHOICES, installKey, isPreviewCurrent, planRequest } from '../install-state';

type Sent = { url: string; method: string; site: string | null; body: any };
let sent: Sent[];
let routes: Array<{ match: (s: Sent) => boolean; reply: (s: Sent) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }> }>;

const official = [{ id: 'wordpress-alike', source: 'official', slug: 'wordpress-alike', displayName: 'WordPress alike', draftRevision: null, versions: ['1.0.0'] }];
const report = (over: Record<string, unknown> = {}) => ({
  template: { source: 'official', sourceSiteId: null, slug: 'wordpress-alike', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}`, displayName: 'WordPress alike' },
  targetSiteId: 'site_b',
  namespace: {},
  components: { collections: ['authors', 'categories', 'comments', 'pages', 'post_categories', 'post_tags', 'posts', 'tags'], fields: 37, relations: [{ from: 'posts.author', to: 'authors', type: 'm2o' }] },
  counts: { collections: 8, fields: 37, relations: 11, seedRecords: 0 },
  seedPack: null,
  storage: { modes: ['jsonb'], transactional: true },
  conflicts: [],
  unrelatedCollections: 0,
  warnings: [],
  ...over,
});
let planSeq = 0;
const planReply = (over: Record<string, unknown> = {}) => ({
  status: 201,
  body: { data: { id: `plan_${++planSeq}`, status: 'planned', expiresAt: new Date(Date.now() + 900_000).toISOString(), targetFingerprint: 'fp', report: report(over) } },
});

beforeEach(() => {
  sent = [];
  planSeq = 0;
  routes = [
    { match: (s) => s.url.endsWith('/backend-templates/official'), reply: () => ({ status: 200, body: { data: official } }) },
    { match: (s) => s.url.includes('/backend-templates/?limit'), reply: () => ({ status: 200, body: { data: [], meta: { total: 0 } } }) },
  ];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    const s: Sent = { url, method: init.method ?? 'GET', site: headers.get('X-Lumi-Site'), body: init.body ? JSON.parse(String(init.body)) : undefined };
    sent.push(s);
    const route = [...routes].reverse().find((r) => r.match(s));
    if (!route) return new Response(JSON.stringify({ errors: [{ code: 'NOT_MOCKED', message: url }] }), { status: 500 });
    const { status, body } = await route.reply(s);
    return new Response(JSON.stringify(body), { status });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const sites = async () => [{ id: 'site_a', name: 'Site A' }, { id: 'site_b', name: 'Site B' }];
function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><TemplatesPage loadSites={sites} /></QueryClientProvider>);
}
const plans = () => sent.filter((s) => s.url.endsWith('/backend-templates/plans'));
const installs = () => sent.filter((s) => s.url.endsWith('/backend-templates/installations'));

async function choose() {
  renderPage();
  await screen.findAllByText(/WordPress alike/);
  fireEvent.change(screen.getByLabelText('Template'), { target: { value: 'official:wordpress-alike' } });
  await waitFor(() => expect(screen.getByLabelText('Revision')).toHaveValue('1.0.0'));
  await waitFor(() => expect(within(screen.getByLabelText('Target site (required)')).getAllByRole('option').length).toBe(3));
}
const pickSite = (id: string) => fireEvent.change(screen.getByLabelText('Target site (required)'), { target: { value: id } });
const preview = async () => {
  fireEvent.click(screen.getByRole('button', { name: /Preview/ }));
  await screen.findByTestId('plan-preview');
};
const installButton = () => screen.getByRole('button', { name: /^Install$/ });

describe('#908 install review', () => {
  it('BT08-AC01 — selection: no default site; preview for site B shows digest, version, 8 collections and zero seed', async () => {
    await choose();
    expect(screen.getByLabelText('Target site (required)')).toHaveValue('');
    expect(screen.getByRole('button', { name: /Preview/ })).toBeDisabled();
    pickSite('site_b');
    routes.push({ match: (s) => s.url.endsWith('/plans'), reply: () => planReply() });
    await preview();
    const box = screen.getByTestId('plan-preview');
    expect(box).toHaveTextContent('1.0.0');
    expect(box).toHaveTextContent(`sha256:${'a'.repeat(64)}`);
    expect(box).toHaveTextContent('Collections: 8');
    expect(box).toHaveTextContent('Seed records: 0');
    // The plan goes to the TARGET site, schema only by default.
    expect(plans()[0]).toMatchObject({ site: 'site_b', body: { targetSiteId: 'site_b', seedMode: 'none' } });
    expect(plans()[0]!.body.seedPack).toBeUndefined();
  });

  it('BT08-AC02 — seed choice: demo then none; counts follow each preview and the install uses the last reviewed choice', async () => {
    await choose();
    pickSite('site_b');
    routes.push({ match: (s) => s.url.endsWith('/plans'), reply: (s) => planReply(s.body.seedPack ? { seedPack: 'demo', counts: { collections: 8, fields: 37, relations: 11, seedRecords: 17 } } : {}) });
    fireEvent.click(screen.getByLabelText(/demo content/));
    await preview();
    expect(screen.getByTestId('plan-preview')).toHaveTextContent('Seed records: 17');
    expect(plans()[0]!.body).toMatchObject({ seedMode: 'pack', seedPack: 'demo' });

    fireEvent.click(screen.getByLabelText(/demo content/));
    expect(installButton()).toBeDisabled();
    await preview();
    expect(screen.getByTestId('plan-preview')).toHaveTextContent('Seed records: 0');
    expect(plans()[1]!.body).toMatchObject({ seedMode: 'none' });

    routes.push({ match: (s) => s.url.endsWith('/installations'), reply: () => ({ status: 201, body: { data: installation('plan_2') } }) });
    fireEvent.click(installButton());
    await screen.findByText(/Installed in site_b/);
    expect(installs()[0]).toMatchObject({ site: 'site_b', body: { planId: 'plan_2', idempotencyKey: 'studio:plan_2' } });
  });

  it('BT08-AC03 — stale preview: changing site, version, prefix or seed disables Install; the old plan is never sent', async () => {
    await choose();
    pickSite('site_b');
    routes.push({ match: (s) => s.url.endsWith('/plans'), reply: () => planReply() });
    await preview();
    expect(installButton()).toBeEnabled();
    const changes: Array<() => void> = [
      () => pickSite('site_a'),
      () => fireEvent.change(screen.getByLabelText(/prefix/), { target: { value: 'blog_' } }),
      () => fireEvent.click(screen.getByLabelText(/demo content/)),
      () => fireEvent.change(screen.getByLabelText('Revision'), { target: { value: '' } }),
    ];
    for (const change of changes) {
      change();
      expect(installButton()).toBeDisabled();
      expect(screen.getByText(/choices changed since this preview/)).toBeInTheDocument();
      fireEvent.click(installButton());
    }
    expect(installs()).toEqual([]);
  });

  it('BT08-AC03 — the stale rule itself: any plan-affecting field changes the key', () => {
    const base = { ...EMPTY_CHOICES, slug: 'wordpress-alike', version: '1.0.0', targetSiteId: 'site_b' };
    const key = choicesKey(base);
    for (const patch of [{ targetSiteId: 'site_c' }, { version: '1.0.1' }, { prefix: 'x_' }, { seedPack: 'demo' }, { slug: 'other' }]) {
      expect(isPreviewCurrent(key, { ...base, ...patch })).toBe(false);
    }
    expect(isPreviewCurrent(key, { ...base })).toBe(true);
    expect(planRequest(base)).toMatchObject({ seedMode: 'none', targetSiteId: 'site_b' });
  });

  it('BT08-AC04 — conflict and errors: actionable messages with codes and paths; never a success', async () => {
    await choose();
    pickSite('site_b');
    const cases: Array<[number, Record<string, unknown>, RegExp]> = [
      [409, { code: 'NAME_CONFLICT', message: 'exists', conflicts: ['posts', 'tags'] }, /namespace prefix/],
      [409, { code: 'STALE_PLAN', message: 'expired' }, /Preview again/],
      [403, { code: 'FORBIDDEN', message: 'no' }, /not an admin/],
      [422, { code: 'INCOMPATIBLE_RUNTIME', message: 'tx' }, /one transaction/],
    ];
    for (const [status, error, text] of cases) {
      routes.push({ match: (s) => s.url.endsWith('/plans'), reply: () => ({ status, body: { errors: [error] } }) });
      fireEvent.click(screen.getByRole('button', { name: /Preview/ }));
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(text);
      expect(alert).toHaveTextContent(String(error['code']));
      if (error['conflicts']) expect(alert).toHaveTextContent('posts, tags');
      expect(screen.queryByText(/Installed in/)).toBeNull();
      expect(installButton()).toBeDisabled();
    }
    // Invalid JSON on import: the server's paths are listed.
    routes.push({
      match: (s) => s.url.endsWith('/backend-templates/') && s.method === 'POST',
      reply: () => ({ status: 422, body: { errors: [{ code: 'INVALID_TEMPLATE', message: 'slug must be kebab-case', path: '$.slug' }] } }),
    });
    fireEvent.change(screen.getByLabelText('Template JSON'), { target: { value: '{"slug":"Bad"}' } });
    fireEvent.click(screen.getByRole('button', { name: /Import as draft/ }));
    expect(await screen.findByText('$.slug')).toBeInTheDocument();
  });

  it('BT08-AC05 — double click and network retry reuse the install identity; result links target the installed site', async () => {
    await choose();
    pickSite('site_b');
    routes.push({ match: (s) => s.url.endsWith('/plans'), reply: () => planReply() });
    await preview();
    let attempts = 0;
    routes.push({
      match: (s) => s.url.endsWith('/installations'),
      reply: async () => {
        attempts += 1;
        if (attempts === 1) throw new TypeError('Failed to fetch');
        return { status: 200, body: { data: installation('plan_1'), meta: { replayed: true } } };
      },
    });
    fireEvent.click(installButton());
    fireEvent.click(installButton());
    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(screen.getByRole('alert')).toHaveTextContent(/Retrying is safe/);
    fireEvent.click(retry);
    await screen.findByText(/Installed in site_b/);
    expect(installs().map((s) => s.body.idempotencyKey)).toEqual(['studio:plan_1', 'studio:plan_1']);
    expect(installs().every((s) => s.site === 'site_b')).toBe(true);
    expect(installKey('plan_1')).toBe('studio:plan_1');
    expect(installButton()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Open posts' })).toBeInTheDocument();
  });

  it('BT08-AC06 — keyboard/labels: every control has an accessible name; errors are announced', async () => {
    await choose();
    for (const name of ['Template', 'Revision', 'Target site (required)', /prefix/, /demo content/, 'Template JSON']) {
      expect(screen.getByLabelText(name)).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: /Preview/ }).tagName).toBe('BUTTON');
    // Requests use the shell-safe origin and Studio token accessors (C1, C2).
    expect(sent.every((s) => s.url.startsWith('https://cms.test/api/v1/backend-templates'))).toBe(true);
  });
});

function installation(planId: string) {
  return {
    id: 'inst_1', planId, slug: 'wordpress-alike', templateVersion: '1.0.0', digest: `sha256:${'a'.repeat(64)}`, seedPack: null,
    resources: { collections: ['authors', 'posts'], fields: 37, relations: 11, seedRecords: 0 },
  };
}
