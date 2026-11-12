// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { SiteSkill } from '../api';

/**
 * Site Skills page tests (#712): list, create, lifecycle, the active-edit
 * warning, verbatim server errors, version restore and the match preview,
 * plus the version guard on save/activate and archive-not-delete for skills
 * that were ever live.
 */

const api = vi.hoisted(() => ({
  skills: vi.fn(),
  createSkill: vi.fn(),
  updateSkill: vi.fn(),
  deleteSkill: vi.fn(),
  setSkillStatus: vi.fn(),
  skillVersions: vi.fn(),
  restoreSkillVersion: vi.fn(),
  matchSkills: vi.fn(),
}));

vi.mock('../api', () => ({ missionControlApi: api }));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={String(to)} {...rest}>
      {children}
    </a>
  ),
  useRouterState: () => ({ location: { pathname: '/mission-control/skills', search: {} } }),
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
}));

import { SkillsPage } from '../skills-page';

function skill(overrides: Partial<SiteSkill> = {}): SiteSkill {
  return {
    id: 'skill_1',
    slug: 'house-style',
    name: 'House style',
    description: 'Voice and tone',
    status: 'draft',
    riskClass: 'low',
    priority: 10,
    triggers: [],
    surfaces: [],
    tools: [],
    collections: [],
    requiredCapabilities: [],
    body: '# House style',
    version: 2,
    hash: 'sha256:aaaaaaaaaaaaaaaaaaaa',
    source: 'studio',
    sourceRef: null,
    activatedAt: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z',
    ...overrides,
  };
}

const DRAFT = skill();
const ACTIVE = skill({
  id: 'skill_2',
  slug: 'legal-review',
  name: 'Legal review',
  status: 'active',
  riskClass: 'high',
  priority: 50,
  surfaces: ['copilot'],
  collections: ['articles'],
  triggers: ['contract'],
  version: 4,
  activatedAt: '2026-11-03T00:00:00.000Z',
});

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <SkillsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  api.skills.mockResolvedValue([DRAFT, ACTIVE]);
  api.skillVersions.mockResolvedValue([]);
  api.createSkill.mockResolvedValue(DRAFT);
  api.updateSkill.mockResolvedValue(DRAFT);
  api.deleteSkill.mockResolvedValue({ id: DRAFT.id });
  api.setSkillStatus.mockResolvedValue({ ...DRAFT, status: 'active' });
  api.restoreSkillVersion.mockResolvedValue({ ...DRAFT, version: 3 });
  api.matchSkills.mockResolvedValue({ skills: [], skipped: [], prompt: '' });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SkillsPage list', () => {
  it('renders skills with status, risk, version, priority and scope', async () => {
    renderPage();

    const draftRow = (await screen.findByRole('button', { name: 'House style' })).closest('tr')!;
    expect(within(draftRow).getByText('house-style')).toBeInTheDocument();
    expect(within(draftRow).getByText('draft')).toBeInTheDocument();
    expect(within(draftRow).getByText('v2')).toBeInTheDocument();
    expect(within(draftRow).getByText('Everywhere')).toBeInTheDocument();

    const activeRow = screen.getByRole('button', { name: 'Legal review' }).closest('tr')!;
    expect(within(activeRow).getByText('active')).toBeInTheDocument();
    expect(within(activeRow).getByText('high')).toBeInTheDocument();
    expect(within(activeRow).getByText('50')).toBeInTheDocument();
    expect(
      within(activeRow).getByText('copilot · collections: articles · on: contract'),
    ).toBeInTheDocument();

    // The Skills section is the active Mission Control tab.
    expect(screen.getByRole('link', { name: 'Skills' })).toHaveAttribute('aria-current', 'page');
  });

  it('filters by status', async () => {
    renderPage();
    await screen.findByRole('button', { name: 'House style' });

    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'active' } });

    expect(screen.queryByRole('button', { name: 'House style' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Legal review' })).toBeInTheDocument();
  });

  it('offers the house-style template from the empty state', async () => {
    api.skills.mockResolvedValue([]);
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /start from house-style template/i }));

    expect(screen.getByLabelText('Slug *')).toHaveValue('house-style');
    expect(screen.getByLabelText('Name *')).toHaveValue('House style');
    expect((screen.getByLabelText('Body (Markdown) *') as HTMLTextAreaElement).value).toContain(
      '# House style',
    );
  });
});

describe('SkillsPage create', () => {
  it('posts the form as a new skill', async () => {
    api.skills.mockResolvedValue([]);
    renderPage();
    await screen.findByText('No skills yet');

    fireEvent.click(screen.getByRole('button', { name: /new skill/i }));
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'SEO rules' } });
    fireEvent.change(screen.getByLabelText('Slug *'), { target: { value: 'seo-rules' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Meta rules' } });
    fireEvent.change(screen.getByLabelText('Risk class'), { target: { value: 'medium' } });
    fireEvent.change(screen.getByLabelText('Priority'), { target: { value: '20' } });
    fireEvent.click(screen.getByLabelText('generation'));
    fireEvent.change(screen.getByLabelText('Tools'), { target: { value: 'generate_meta, ' } });
    fireEvent.change(screen.getByLabelText('Collections'), { target: { value: 'articles,pages' } });
    fireEvent.change(screen.getByLabelText(/^Triggers/), { target: { value: 'seo, meta title' } });
    fireEvent.change(screen.getByLabelText(/^Required capabilities/), {
      target: { value: 'items:update' },
    });
    fireEvent.change(screen.getByLabelText('Body (Markdown) *'), {
      target: { value: 'Keep titles short.' },
    });
    fireEvent.change(screen.getByLabelText('Change note (optional)'), {
      target: { value: 'first cut' },
    });
    expect(screen.getByTestId('skill-body-count')).toHaveTextContent('18 / 12,000 characters');

    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));

    await waitFor(() => expect(api.createSkill).toHaveBeenCalledTimes(1));
    expect(api.createSkill).toHaveBeenCalledWith({
      slug: 'seo-rules',
      name: 'SEO rules',
      description: 'Meta rules',
      riskClass: 'medium',
      priority: 20,
      triggers: ['seo', 'meta title'],
      surfaces: ['generation'],
      tools: ['generate_meta'],
      collections: ['articles', 'pages'],
      requiredCapabilities: ['items:update'],
      body: 'Keep titles short.',
      changeNote: 'first cut',
    });
  });

  it('rejects an invalid slug before calling the API', async () => {
    api.skills.mockResolvedValue([]);
    renderPage();
    await screen.findByText('No skills yet');

    fireEvent.click(screen.getByRole('button', { name: /new skill/i }));
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Bad' } });
    fireEvent.change(screen.getByLabelText('Slug *'), { target: { value: 'Not A Slug' } });
    fireEvent.change(screen.getByLabelText('Body (Markdown) *'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/slug must be lowercase/i);
    expect(api.createSkill).not.toHaveBeenCalled();
  });
});

describe('SkillsPage edit + lifecycle', () => {
  it('activates a draft through the activate endpoint', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'House style' }));

    fireEvent.click(screen.getByRole('button', { name: 'Activate' }));

    // The version on screen goes along, so an edit that landed meanwhile is not activated unseen.
    await waitFor(() => expect(api.setSkillStatus).toHaveBeenCalledWith('skill_1', 'activate', 2));
  });

  it('warns that saving an active skill changes agent behaviour immediately', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'House style' }));
    expect(screen.queryByText(/changes agent behaviour immediately/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Legal review' }));

    expect(screen.getByText(/changes agent behaviour immediately/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Slug *')).toBeDisabled();
    // Active skills offer the way back, not "Activate".
    expect(screen.getByRole('button', { name: 'Back to draft' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Activate' })).not.toBeInTheDocument();
  });

  it('patches an existing skill without the slug', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'House style' }));

    fireEvent.change(screen.getByLabelText('Body (Markdown) *'), { target: { value: 'New body' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(api.updateSkill).toHaveBeenCalledTimes(1));
    const [id, patch] = api.updateSkill.mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toBe('skill_1');
    expect(patch).toMatchObject({ name: 'House style', body: 'New body', priority: 10, expectedVersion: 2 });
    expect(patch).not.toHaveProperty('slug');
  });

  it('renders a server error verbatim', async () => {
    const message = 'The skill is at version 5, not 4; reload it and retry.';
    api.updateSkill.mockRejectedValue(new Error(message));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Legal review' }));

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
  });

  it('renders a lifecycle error verbatim', async () => {
    api.setSkillStatus.mockRejectedValue(new Error('Writing Site Skills requires a control-plane admin.'));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'House style' }));

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Writing Site Skills requires a control-plane admin.',
    );
  });

  it('deletes only after the confirm step', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'House style' }));

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(api.deleteSkill).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
    await waitFor(() => expect(api.deleteSkill).toHaveBeenCalledWith('skill_1'));
  });

  it('offers Archive instead of Delete for a skill that has ever been active', async () => {
    const wasActive = skill({ id: 'skill_3', slug: 'old-rules', name: 'Old rules', activatedAt: '2026-11-01T00:00:00.000Z' });
    api.skills.mockResolvedValue([wasActive, ACTIVE]);
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Old rules' }));
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    expect(screen.getByTestId('skill-delete-blocked')).toHaveTextContent(/archive it instead/i);
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(api.setSkillStatus).toHaveBeenCalledWith('skill_3', 'archive', 2));

    fireEvent.click(screen.getByRole('button', { name: 'Legal review' }));
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    expect(api.deleteSkill).not.toHaveBeenCalled();
  });
});

describe('SkillVersions', () => {
  it('lists versions and restores an old one', async () => {
    api.skillVersions.mockResolvedValue([
      {
        id: 'ver_2',
        version: 2,
        hash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbb',
        snapshot: {},
        source: 'studio',
        sourceRef: null,
        changeNote: 'tightened tone',
        authorId: 'user_9',
        authorLabel: null,
        createdAt: '2026-11-02T00:00:00.000Z',
      },
      {
        id: 'ver_1',
        version: 1,
        hash: 'sha256:cccccccccccccccccccccccc',
        snapshot: {},
        source: 'cli',
        sourceRef: 'skills/house-style.md',
        changeNote: null,
        authorId: null,
        authorLabel: 'api_key:key_1',
        createdAt: '2026-11-01T00:00:00.000Z',
      },
    ]);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'House style' }));

    expect(await screen.findByText('tightened tone')).toBeInTheDocument();
    expect(screen.getByText('sha256:bbbbb')).toBeInTheDocument();
    expect(screen.getByText(/api_key:key_1 · via cli \(skills\/house-style\.md\)/)).toBeInTheDocument();
    // The current version cannot be restored onto itself.
    expect(screen.queryByRole('button', { name: 'Restore version 2' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Restore version 1' }));

    await waitFor(() => expect(api.restoreSkillVersion).toHaveBeenCalledWith('skill_1', 1));
  });
});

describe('SkillMatchPreview', () => {
  it('sends the context and shows applied, skipped and the prompt', async () => {
    api.matchSkills.mockResolvedValue({
      skills: [{ slug: 'legal-review', version: 4, hash: 'sha256:x' }],
      skipped: ['long-playbook'],
      prompt: 'SITE PLAYBOOKS\n\n## legal-review',
    });
    renderPage();
    await screen.findByRole('button', { name: 'House style' });

    fireEvent.change(screen.getByLabelText('Surface'), { target: { value: 'generation' } });
    fireEvent.change(screen.getByLabelText('Collection (optional)'), {
      target: { value: 'articles' },
    });
    fireEvent.change(screen.getByLabelText('Sample request text'), {
      target: { value: 'review this contract' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test match' }));

    await waitFor(() =>
      expect(api.matchSkills).toHaveBeenCalledWith({
        surface: 'generation',
        collection: 'articles',
        text: 'review this contract',
      }),
    );
    expect(await screen.findByText('legal-review@4')).toBeInTheDocument();
    expect(screen.getByText('long-playbook')).toBeInTheDocument();
    expect(screen.getByText(/SITE PLAYBOOKS/).tagName).toBe('PRE');
  });
});

describe('skills API fetchers', () => {
  it('go through agentFetch and stamp writes with source "studio"', async () => {
    const { missionControlApi: real } = await vi.importActual<typeof import('../api')>('../api');
    const fetchMock = vi.fn().mockImplementation(
      async () => new Response(JSON.stringify({ data: DRAFT }), { status: 201 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      await real.createSkill({
        slug: 'seo-rules',
        name: 'SEO rules',
        description: '',
        riskClass: 'low',
        priority: 0,
        triggers: [],
        surfaces: [],
        tools: [],
        collections: [],
        requiredCapabilities: [],
        body: 'Keep titles short.',
      });
      await real.updateSkill('skill_1', { body: 'New body' });
      await real.setSkillStatus('skill_1', 'activate');
      await real.updateSkill('skill_1', { body: 'Newer body', expectedVersion: 2 });
      await real.setSkillStatus('skill_1', 'activate', 3);

      const [createUrl, createInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(createUrl).toBe('/api/v1/agent/skills');
      expect(createInit.method).toBe('POST');
      expect(JSON.parse(String(createInit.body))).toMatchObject({
        slug: 'seo-rules',
        name: 'SEO rules',
        body: 'Keep titles short.',
        source: 'studio',
      });
      expect((createInit.headers as Record<string, string>)['X-Lumi-Client']).toBe('studio');

      const [patchUrl, patchInit] = fetchMock.mock.calls[1] as [string, RequestInit];
      expect(patchUrl).toBe('/api/v1/agent/skills/skill_1');
      expect(patchInit.method).toBe('PATCH');
      expect(JSON.parse(String(patchInit.body))).toEqual({ body: 'New body', source: 'studio' });

      const [activateUrl, activateInit] = fetchMock.mock.calls[2] as [string, RequestInit];
      expect(activateUrl).toBe('/api/v1/agent/skills/skill_1/activate');
      expect(activateInit.method).toBe('POST');
      expect(JSON.parse(String(activateInit.body))).toEqual({});

      const [, guardedPatch] = fetchMock.mock.calls[3] as [string, RequestInit];
      expect(JSON.parse(String(guardedPatch.body))).toEqual({
        body: 'Newer body',
        expectedVersion: 2,
        source: 'studio',
      });
      const [, guardedActivate] = fetchMock.mock.calls[4] as [string, RequestInit];
      expect(JSON.parse(String(guardedActivate.body))).toEqual({ version: 3 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('surfaces the server error message verbatim', async () => {
    const { missionControlApi: real } = await vi.importActual<typeof import('../api')>('../api');
    const message = 'The skill is at version 5, not 4; reload it and retry.';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        async () =>
          new Response(
            JSON.stringify({ errors: [{ code: 'VERSION_MISMATCH', message, currentVersion: 5 }] }),
            { status: 409 },
          ),
      ),
    );
    try {
      await expect(real.setSkillStatus('skill_2', 'activate', 4)).rejects.toThrow(message);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
