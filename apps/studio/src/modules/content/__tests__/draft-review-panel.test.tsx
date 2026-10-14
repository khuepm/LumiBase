// @vitest-environment jsdom
/**
 * Draft review in the Studio editor (Jev J08, #515).
 *
 * The page-level tests render the real `ItemDetailPage` / new-item form with
 * a mocked API client, so they exercise the wiring the editor ships with:
 * review → accept → edit → the existing draft save, while publish stays a
 * separate action. SDK commands run for real against `client.rawRequest`,
 * which each test routes by path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { LumiError, type FieldResource, type ReviewProfile, type ReviewRun } from '@lumibase/sdk';
import type { PermissionHelpers } from '@/lib/use-permissions';

type Init = { method?: string; body?: string; signal?: AbortSignal };
type Route = (path: string, init: Init) => Promise<unknown>;

let route: Route;
const rawRequest = vi.fn((path: string, init: Init = {}) => route(path, init));
const patch = vi.fn();
const params = { collection: 'posts', id: 'item_1' };

let bundle: Record<string, unknown> = { admin: true, byKey: {} };
let pins: string[] = [];

const client = {
  rawRequest,
  // Like the real Studio client (`legacyRest()`), `request` is `rawRequest`.
  request: rawRequest,
  schema: {
    listFields: async () => ({ data: FIELDS }),
    getCollection: async () => ({ data: { meta: { editorialWorkflow: false } } }),
  },
  settings: { get: async () => ({ data: null }) },
  permissions: { me: async () => ({ data: bundle }) },
  roles: { list: async () => ({ data: [] }) },
  tm: { upsert: vi.fn() },
  items: () => ({
    detail: async () => ({ data: ITEM }),
    listPins: async () => ({ data: { pinnedFields: pins } }),
    listRevisions: async () => ({ data: [] }),
    releasePin: vi.fn(),
    patch,
    create: vi.fn(),
  }),
};

vi.mock('@/lib/api', () => ({ getApiClient: () => client }));
vi.mock('@/lib/extension-loader', () => ({ getExtension: () => undefined }));
vi.mock('@/hooks/use-presence', () => ({ useCoEditors: () => ({ coEditors: [], connected: false }) }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  useNavigate: () => vi.fn(),
  useParams: () => params,
}));

import { ItemDetailPage } from '../item-detail';
import { DraftReviewPanel } from '../draft-review-panel';
import { registerContentBundles } from '../draft-review-i18n';

function field(name: string, sortOrder: number): FieldResource {
  return { id: `f_${name}`, name, type: 'string', interface: 'input', sortOrder } as unknown as FieldResource;
}

const FIELDS = [field('title', 1), field('body', 2), field('category', 3)];

const ITEM = {
  id: 'item_1',
  siteId: 'site_1',
  collectionId: 'c1',
  status: 'draft',
  data: { title: 'Hello', body: 'World', category: '' },
  sort: 0,
  editorialState: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  publishAt: null,
  unpublishAt: null,
};

const PROFILE: ReviewProfile = {
  id: 'prof_1',
  key: 'taxonomy',
  version: 2,
  status: 'active',
  collection: 'posts',
  preset: null,
  fields: ['title', 'body'],
  questions: {
    category: {
      type: 'choice',
      instructions: 'Which category?',
      criteria: { news: 'Current events', sport: 'Matches and athletes', other: null, unknown: null },
    },
    tone_match: { type: 'score', instructions: 'Tone?', criteria: ['Not at all', 'Slightly', 'Partly', 'Mostly', 'Fully'] },
    needs_review: { type: 'noul', instructions: 'Needs an editor?', criteria: { true: 'Needs an editor', false: 'Fine as is' } },
  },
  sourceField: null,
  minConfidence: null,
  note: null,
  createdBy: 'u1',
  createdAt: '2026-01-01T00:00:00Z',
};

function reviewRun(overrides: Partial<ReviewRun> = {}): ReviewRun {
  return {
    id: 'run_1',
    profileId: 'prof_1',
    profileKey: 'taxonomy',
    profileVersion: 2,
    collection: 'posts',
    itemId: 'item_1',
    revisionId: 'rev_1',
    contentHash: `sha256:${'0'.repeat(64)}`,
    source: 'item',
    omittedFields: [],
    status: 'success',
    provider: 'typesafe',
    model: 'jev-1',
    calibrated: true,
    answers: {
      category: { type: 'choice', choice: 'sport', probabilities: { news: 0.1, sport: 0.8, other: 0.05, unknown: 0.05 }, confidence: 0.8 },
      tone_match: {
        type: 'score',
        score: 2.1,
        legend: { 0: 'Not at all', 1: 'Slightly', 2: 'Partly', 3: 'Mostly', 4: 'Fully' },
        probabilities: { 0: 0.05, 1: 0.15, 2: 0.5, 3: 0.2, 4: 0.1 },
        confidence: 0.5,
      },
      needs_review: { type: 'noul', noul: 0.2 },
    },
    usage: { inputTokens: 10, outputTokens: 2 },
    latencyMs: 120,
    errorCode: null,
    createdAt: '2026-01-01T00:00:00Z',
    completedAt: '2026-01-01T00:00:01Z',
    stale: false,
    staleReason: null,
    note: null,
    ...overrides,
  };
}

function lumiError(status: number, code: string, retryAfter?: string): LumiError {
  return new LumiError(
    status,
    { errors: [{ code, message: code }] },
    new Headers(retryAfter ? { 'retry-after': retryAfter } : {}),
  );
}

/** Routes the editor's ambient calls; `reviews` / `feedback` handle the review endpoints. */
function routes(handlers: { profiles?: () => Promise<unknown>; reviews?: Route; feedback?: Route } = {}): void {
  route = async (path, init) => {
    if (path.startsWith('/api/v1/ai/review-profiles')) {
      return handlers.profiles ? handlers.profiles() : { data: [PROFILE] };
    }
    if (path === '/api/v1/ai/reviews') {
      return handlers.reviews ? handlers.reviews(path, init) : { data: reviewRun() };
    }
    if (/^\/api\/v1\/ai\/reviews\/[^/]+\/feedback$/.test(path)) {
      return handlers.feedback ? handlers.feedback(path, init) : { data: [] };
    }
    return { data: {} };
  };
}

function calls(path: RegExp | string) {
  return rawRequest.mock.calls.filter(([p]) => (typeof path === 'string' ? p === path : path.test(p)));
}

function bodyOf(call: [string, Init?] | undefined): Record<string, unknown> {
  return JSON.parse(call?.[1]?.body ?? '{}') as Record<string, unknown>;
}

function wrap(children: ReactNode, i18n?: typeof i18next) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const tree = <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return i18n ? <I18nextProvider i18n={i18n}>{tree}</I18nextProvider> : tree;
}

function renderPage(id = 'item_1') {
  params.id = id;
  return render(wrap(<ItemDetailPage />));
}

function perms(overrides: Partial<PermissionHelpers> = {}): PermissionHelpers {
  return {
    bundle: undefined,
    isLoading: false,
    isAdmin: true,
    can: () => true,
    get: () => null,
    fieldAllowed: () => true,
    filterFields: (_c, _a, f) => f,
    ...overrides,
  };
}

function renderPanel(props: Partial<Parameters<typeof DraftReviewPanel>[0]> = {}, i18n?: typeof i18next) {
  return render(
    wrap(
      <DraftReviewPanel
        collection="posts"
        itemId="item_1"
        values={ITEM.data}
        savedValues={ITEM.data}
        fields={FIELDS}
        writeAction="update"
        perms={perms()}
        pinnedFields={[]}
        onApply={vi.fn()}
        {...props}
      />,
      i18n,
    ),
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const suggestion = (key: string) => within(screen.getByTestId(`suggestion-${key}`));

beforeEach(() => {
  bundle = { admin: true, byKey: {} };
  pins = [];
  params.id = 'item_1';
  routes();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('draft review in the item editor', () => {
  it('reviews, accepts and edits suggestions, then saves the draft without publishing', async () => {
    patch.mockResolvedValue({ data: ITEM });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Review draft' }));
    expect(await screen.findByText('Suggested: sport')).toBeInTheDocument();

    // Saved, unchanged item → item mode: the CMS reads it under the caller's RBAC.
    const review = bodyOf(calls('/api/v1/ai/reviews')[0]);
    expect(review).toMatchObject({ profile: 'taxonomy', profileVersion: 2, collection: 'posts', itemId: 'item_1' });
    expect(review).not.toHaveProperty('snapshot');
    expect(String(review.idempotencyKey)).toMatch(/^studio-[0-9a-f]{40}$/);
    expect(screen.getByText('Calibrated (provider claim)')).toBeInTheDocument();
    expect(screen.getByText('Answered by typesafe · jev-1')).toBeInTheDocument();

    // Accept writes the category field of the draft — after feedback is stored.
    fireEvent.click(suggestion('category').getByRole('button', { name: 'Accept the suggestion for Category' }));
    await waitFor(() => expect(screen.getAllByRole('textbox')[2]).toHaveValue('sport'));
    expect(bodyOf(calls(/\/feedback$/)[0])).toEqual({ entries: [{ questionKey: 'category', verdict: 'accept' }] });
    expect(calls(/\/feedback$/)[0]![0]).toBe('/api/v1/ai/reviews/run_1/feedback');

    // Edit on a score question records the editor's level only.
    fireEvent.click(suggestion('tone_match').getByRole('button', { name: 'Choose a different value for Tone match' }));
    fireEvent.change(suggestion('tone_match').getByLabelText('Your value for Tone match'), { target: { value: '4' } });
    fireEvent.click(suggestion('tone_match').getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(calls(/\/feedback$/)).toHaveLength(2));
    expect(bodyOf(calls(/\/feedback$/)[1])).toEqual({
      entries: [{ questionKey: 'tone_match', verdict: 'edit', editedValue: 4 }],
    });

    // Nothing was saved by the review. The editor's own Save persists the draft.
    expect(patch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save & stay' }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch).toHaveBeenCalledWith('item_1', {
      data: { title: 'Hello', body: 'World', category: 'sport' },
      publishAt: null,
      unpublishAt: null,
    });

    // Publish stays its own action: no status change, no editorial transition.
    expect(patch).not.toHaveBeenCalledWith('item_1', expect.objectContaining({ status: 'published' }));
    expect(calls(/\/api\/v1\/editorial\//)).toHaveLength(0);
    expect(calls('/api/v1/ai/reviews')).toHaveLength(1);
  });

  it('marks the result stale when the draft changes while the review runs', async () => {
    const pending = deferred<unknown>();
    routes({ reviews: () => pending.promise });
    renderPage('new');

    const title = (await screen.findAllByRole('textbox'))[0]!;
    fireEvent.change(title, { target: { value: 'First' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Review draft' }));
    await waitFor(() => expect(calls('/api/v1/ai/reviews')).toHaveLength(1));

    // Unsaved form → snapshot mode with only the profile's fields.
    expect(bodyOf(calls('/api/v1/ai/reviews')[0]).snapshot).toEqual({ title: 'First' });

    fireEvent.change(title, { target: { value: 'First, edited' } });
    await act(async () => pending.resolve({ data: reviewRun({ itemId: null, revisionId: null, source: 'snapshot' }) }));

    expect(await screen.findByText(/The draft changed after this review/)).toBeInTheDocument();
    expect(suggestion('category').getByRole('button', { name: 'Accept the suggestion for Category' })).toBeDisabled();
    expect(suggestion('category').getByRole('button', { name: 'Choose a different value for Category' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Run again' })).toBeEnabled();
    expect(title).toHaveValue('First, edited');
    expect(calls(/\/feedback$/)).toHaveLength(0);
  });

  it('turns a 409 REVIEW_STALE on feedback into the stale state without applying', async () => {
    const onApply = vi.fn();
    routes({ feedback: async () => Promise.reject(lumiError(409, 'REVIEW_STALE')) });
    renderPanel({ onApply });

    fireEvent.click(await screen.findByRole('button', { name: 'Review draft' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Accept the suggestion for Category' }));

    expect(await screen.findByText(/The draft changed after this review/)).toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Accept the suggestion for Category' })).toBeDisabled();
  });

  it('sends the current draft hash with snapshot feedback', async () => {
    const onApply = vi.fn();
    routes({ reviews: async () => ({ data: reviewRun({ itemId: null, revisionId: null, source: 'snapshot' }) }) });
    renderPanel({ itemId: undefined, savedValues: undefined, writeAction: 'create', onApply });

    fireEvent.click(await screen.findByRole('button', { name: 'Review draft' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Accept the suggestion for Category' }));

    await waitFor(() => expect(onApply).toHaveBeenCalledWith('category', 'sport'));
    expect(String(bodyOf(calls(/\/feedback$/)[0]).contentHash)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('fields the editor may not change', () => {
  it('shows a non-writable field read-only with Apply disabled', async () => {
    bundle = {
      admin: false,
      byKey: {
        'posts::read': { collection: 'posts', action: 'read', rule: null, fields: ['*'], presets: {}, validation: {}, sources: [] },
        'posts::update': { collection: 'posts', action: 'update', rule: null, fields: ['title', 'body'], presets: {}, validation: {}, sources: [] },
      },
    };
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Review draft' }));
    await screen.findByText('Suggested: sport');
    expect(suggestion('category').getByText('Read-only: you cannot change category.')).toBeInTheDocument();
    expect(suggestion('category').getByRole('button', { name: 'Accept the suggestion for Category' })).toBeDisabled();
    expect(suggestion('category').getByRole('button', { name: 'Choose a different value for Category' })).toBeDisabled();
    expect(suggestion('category').getByRole('button', { name: 'Reject the suggestion for Category' })).toBeEnabled();
  });

  it('shows a pinned field read-only with Apply disabled', async () => {
    pins = ['category'];
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Review draft' }));
    await screen.findByText('Suggested: sport');
    expect(suggestion('category').getByText('Pinned: category is locked by a human edit.')).toBeInTheDocument();
    expect(suggestion('category').getByRole('button', { name: 'Accept the suggestion for Category' })).toBeDisabled();
  });

  it('lets a reviewer without write permission review and give feedback, but not apply', async () => {
    bundle = {
      admin: false,
      byKey: {
        'posts::read': { collection: 'posts', action: 'read', rule: null, fields: ['*'], presets: {}, validation: {}, sources: [] },
      },
    };
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Review draft' }));
    await screen.findByText('Suggested: sport');
    // Item mode: no snapshot, so no write permission is needed to review.
    expect(bodyOf(calls('/api/v1/ai/reviews')[0])).not.toHaveProperty('snapshot');
    expect(suggestion('category').getByRole('button', { name: 'Accept the suggestion for Category' })).toBeDisabled();

    // A feedback-only suggestion can still be judged.
    fireEvent.click(suggestion('needs_review').getByRole('button', { name: 'Accept the suggestion for Needs review' }));
    await waitFor(() => expect(calls(/\/feedback$/)).toHaveLength(1));
    expect(bodyOf(calls(/\/feedback$/)[0])).toEqual({ entries: [{ questionKey: 'needs_review', verdict: 'accept' }] });
    expect(screen.getByRole('button', { name: 'Saved' })).toBeDisabled();
    expect(patch).not.toHaveBeenCalled();
  });

  it('records a rejection as feedback only', async () => {
    const onApply = vi.fn();
    renderPanel({ onApply });

    fireEvent.click(await screen.findByRole('button', { name: 'Review draft' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reject the suggestion for Category' }));

    await waitFor(() => expect(calls(/\/feedback$/)).toHaveLength(1));
    expect(bodyOf(calls(/\/feedback$/)[0])).toEqual({ entries: [{ questionKey: 'category', verdict: 'reject' }] });
    expect(await screen.findByText('Rejected')).toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
    // One verdict per run and question.
    expect(screen.getByRole('button', { name: 'Accept the suggestion for Category' })).toBeDisabled();
  });
});

describe('cancel', () => {
  it('aborts the request when the editor clicks Cancel', async () => {
    let signal: AbortSignal | undefined;
    routes({
      reviews: (_path, init) => {
        signal = init.signal;
        return new Promise(() => { });
      },
    });
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Review draft' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel review' }));

    expect(signal?.aborted).toBe(true);
    expect(await screen.findByRole('button', { name: 'Run again' })).toBeEnabled();
    expect(screen.queryByText('Reviewing…')).toBeNull();
  });

  it('aborts the request when the editor unmounts', async () => {
    let signal: AbortSignal | undefined;
    routes({
      reviews: (_path, init) => {
        signal = init.signal;
        return new Promise(() => { });
      },
    });
    const view = renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Review draft' }));
    await waitFor(() => expect(signal).toBeDefined());
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });
});

describe('explicit states, never a pass', () => {
  async function runWith(error: LumiError) {
    routes({ reviews: async () => Promise.reject(error) });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Review draft' }));
  }

  afterEach(() => {
    expect(screen.queryByText(/pass/i)).toBeNull();
    expect(screen.queryByText(/Suggested:/)).toBeNull();
  });

  it('503 provider unavailable', async () => {
    await runWith(lumiError(503, 'DECISION_UNAVAILABLE'));
    expect(await screen.findByRole('alert')).toHaveTextContent('The review provider is unavailable right now. Nothing was checked.');
  });

  it('429 quota with Retry-After', async () => {
    await runWith(lumiError(429, 'DECISION_QUOTA_EXCEEDED', '30'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Try again in 30 s.');
  });

  it('504 timeout', async () => {
    await runWith(lumiError(504, 'DECISION_TIMEOUT'));
    expect(await screen.findByRole('alert')).toHaveTextContent('The review timed out. Nothing was checked.');
  });

  it('403 disabled for the site', async () => {
    await runWith(lumiError(403, 'DECISION_DISABLED'));
    expect(await screen.findByText('Draft review is turned off for this site.')).toBeInTheDocument();
  });

  it('503 provider not configured', async () => {
    await runWith(lumiError(503, 'DECISION_NOT_CONFIGURED'));
    expect(await screen.findByText('Draft review is not set up for this collection yet.')).toBeInTheDocument();
  });

  it('no review profile for the collection', async () => {
    routes({ profiles: async () => ({ data: [] }) });
    renderPanel();
    expect(await screen.findByText('Draft review is not set up for this collection yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review draft' })).toBeNull();
  });

  it('403 without the ai:decide capability', async () => {
    routes({ profiles: async () => Promise.reject(lumiError(403, 'FORBIDDEN')) });
    renderPanel();
    expect(await screen.findByRole('alert')).toHaveTextContent('You do not have permission to run draft reviews.');
  });

  it('a replayed run that failed upstream', async () => {
    routes({ reviews: async () => ({ data: reviewRun({ status: 'error', answers: null, errorCode: 'DECISION_TIMEOUT' }) }) });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Review draft' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The review timed out.');
  });

  it('abstained: not enough information, Accept of a field value disabled', async () => {
    routes({
      reviews: async () => ({
        data: reviewRun({
          status: 'abstained',
          answers: {
            ...reviewRun().answers!,
            category: { type: 'choice', choice: 'unknown', probabilities: { news: 0.1, sport: 0.1, other: 0.1, unknown: 0.7 }, confidence: 0.7 },
          },
        }),
      }),
    });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Review draft' }));
    expect(await screen.findByText('Not enough information')).toBeInTheDocument();
    expect(screen.getByText(/Not enough information for a confident suggestion/)).toBeInTheDocument();
  });
});

describe('Vietnamese', () => {
  it('renders the panel in the active VI locale', async () => {
    const i18n = i18next.createInstance();
    await i18n.use(initReactI18next).init({ lng: 'vi', fallbackLng: 'en', resources: {}, interpolation: { escapeValue: false } });
    registerContentBundles(i18n);

    renderPanel({}, i18n);
    fireEvent.click(await screen.findByRole('button', { name: 'Kiểm tra bản nháp' }));
    expect(await screen.findByText('Gợi ý: sport')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Chấp nhận gợi ý cho Category' })).toBeEnabled();
    expect(screen.getByText('Đã hiệu chỉnh (theo nhà cung cấp)')).toBeInTheDocument();
  });

  it('ships the same keys in EN and VI', async () => {
    const en = (await import('@/locales/en/content.json')).default;
    const vi = (await import('@/locales/vi/content.json')).default;
    const keys = (node: unknown, prefix = ''): string[] =>
      node && typeof node === 'object'
        ? Object.entries(node).flatMap(([k, v]) => keys(v, `${prefix}${k}.`))
        : [prefix];
    expect(keys(vi).sort()).toEqual(keys(en).sort());
  });
});
