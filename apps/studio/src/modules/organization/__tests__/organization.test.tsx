// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Organization } from '@/lib/organization-api';
const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  createSite: vi.fn(),
  sites: vi.fn(),
  members: vi.fn(),
  updateMember: vi.fn(),
  keys: vi.fn(),
  createKey: vi.fn(),
  approvals: vi.fn(),
  decide: vi.fn(),
  receipt: vi.fn(),
  setSite: vi.fn(),
  reload: vi.fn(),
}));
vi.mock('@/lib/api', () => ({
  getActiveToken: () => 'studio-token',
  getSessionGeneration: () => 0,
  getActiveSite: () => 'site_current',
  setActiveSite: mocks.setSite,
  getApiClient: () => ({
    orgs: {
      list: mocks.list,
      get: mocks.get,
      update: mocks.update,
      sites: { list: mocks.sites, create: mocks.createSite },
      members: { list: mocks.members, update: mocks.updateMember },
      keys: { list: mocks.keys, create: mocks.createKey },
      approvals: {
        list: mocks.approvals,
        decide: mocks.decide,
        get: mocks.receipt,
      },
    },
  }),
}));
vi.mock('@tanstack/react-router', () => ({
  useRouterState: () => ({ location: { pathname: '/settings/organization' } }),
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));
import { OrganizationPage } from '../page';
import { OrganizationSwitcher } from '../switcher';
import { SettingsLayout } from '@/modules/settings/layout';
const owner: Organization = {
  id: 'org_a',
  name: 'Personal Org',
  slug: 'default',
  role: 'owner',
  settings: {},
};
let client: QueryClient;
function show(node: ReactNode) {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, reload: mocks.reload },
  });
  mocks.list.mockResolvedValue([owner]);
  mocks.get.mockResolvedValue(owner);
  mocks.sites.mockResolvedValue([]);
  mocks.members.mockResolvedValue([]);
  mocks.keys.mockResolvedValue([]);
  mocks.approvals.mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  client?.clear();
});

describe('Organization settings and shell selection', () => {
  it('keeps Organization in Settings for one owner org while hiding the switcher', async () => {
    show(
      <>
        <OrganizationSwitcher />
        <SettingsLayout>
          <p>Settings body</p>
        </SettingsLayout>
      </>,
    );
    expect(
      await screen.findByRole('link', { name: 'Organization' }),
    ).toHaveAttribute('href', '/settings/organization');
    expect(
      screen.queryByRole('combobox', { name: 'Organization' }),
    ).not.toBeInTheDocument();
  });
  it('switches org scope and clears the previous org form and secret state', async () => {
    const second = {
      ...owner,
      id: 'org_b',
      slug: 'second',
      name: 'Second Org',
    };
    mocks.list.mockResolvedValue([owner, second]);
    mocks.get.mockImplementation(async (id) =>
      id === 'org_b' ? second : owner,
    );
    show(
      <>
        <OrganizationSwitcher />
        <OrganizationPage />
      </>,
    );
    const switcher = await screen.findByRole('combobox', {
      name: 'Organization',
    });
    expect(await screen.findByLabelText('Organization name')).toHaveValue(
      'Personal Org',
    );
    mocks.createKey.mockResolvedValue({ token: 'lbo_old_org_secret' });
    fireEvent.click(screen.getByRole('button', { name: 'keys' }));
    fireEvent.change(screen.getByLabelText('Key name'), {
      target: { value: 'Old org key' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Create organization key' }),
    );
    await screen.findByLabelText('New organization key');
    fireEvent.click(screen.getByRole('button', { name: 'general' }));
    fireEvent.change(screen.getByLabelText('Organization name'), {
      target: { value: 'Unsaved old org' },
    });
    fireEvent.change(switcher, { target: { value: 'org_b' } });
    await waitFor(() =>
      expect(screen.getByLabelText('Organization name')).toHaveValue(
        'Second Org',
      ),
    );
    expect(
      screen.queryByLabelText('New organization key'),
    ).not.toBeInTheDocument();
    expect(mocks.get).toHaveBeenCalledWith('org_b');
    expect(mocks.sites).toHaveBeenCalledWith('org_b');
  });
  it('limits ordinary members to read-only general/sites and hides the Settings link', async () => {
    const member = { ...owner, role: 'member' as const };
    mocks.list.mockResolvedValue([member]);
    mocks.get.mockResolvedValue(member);
    show(
      <SettingsLayout>
        <OrganizationPage />
      </SettingsLayout>,
    );
    expect(await screen.findByLabelText('Organization name')).toBeDisabled();
    expect(
      screen.queryByRole('link', { name: 'Organization' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'members' }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'sites' }));
    expect(
      screen.queryByRole('button', { name: 'Create site' }),
    ).not.toBeInTheDocument();
    expect(mocks.members).not.toHaveBeenCalled();
    expect(mocks.keys).not.toHaveBeenCalled();
  });
  it('switches to the newly provisioned site and discards old-site query state', async () => {
    mocks.createSite.mockResolvedValue({
      id: 'site_new',
      name: 'New site',
      organizationId: owner.id,
    });
    show(<OrganizationPage />);
    await screen.findByLabelText('Organization name');
    client.setQueryData(['old-site-items'], [{ id: 'private-old-item' }]);
    fireEvent.click(screen.getByRole('button', { name: 'sites' }));
    fireEvent.change(screen.getByLabelText('Site name'), {
      target: { value: 'New site' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create site' }));
    await waitFor(() => expect(mocks.setSite).toHaveBeenCalledWith('site_new'));
    expect(mocks.createSite).toHaveBeenCalledWith(owner.id, {
      name: 'New site',
    });
    expect(client.getQueryData(['old-site-items'])).toBeUndefined();
    expect(mocks.reload).toHaveBeenCalledOnce();
  });
  it('lets admins manage settings but keeps slug and owner-only site actions disabled', async () => {
    const admin = { ...owner, role: 'admin' as const };
    mocks.list.mockResolvedValue([admin]);
    mocks.get.mockResolvedValue(admin);
    mocks.sites.mockResolvedValue([
      { id: 'site_1', name: 'Site One', organizationId: owner.id },
    ]);
    show(<OrganizationPage />);
    await screen.findByLabelText('Organization name');
    expect(screen.getByLabelText('Organization slug')).toBeDisabled();
    expect(screen.getByLabelText('Organization name')).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'sites' }));
    expect(await screen.findByText('Site One')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Delete site' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Transfer' }),
    ).not.toBeInTheDocument();
  });
  it('shows minted key plaintext only in a dismissible human receipt', async () => {
    mocks.createKey.mockResolvedValue({
      id: 'key_new',
      name: 'Agent',
      prefix: 'lbo_',
      token: 'lbo_human_receipt_secret',
    });
    show(<OrganizationPage />);
    await screen.findByLabelText('Organization name');
    fireEvent.click(screen.getByRole('button', { name: 'keys' }));
    fireEvent.change(screen.getByLabelText('Key name'), {
      target: { value: 'Agent' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Create organization key' }),
    );
    expect(await screen.findByLabelText('New organization key')).toHaveValue(
      'lbo_human_receipt_secret',
    );
    expect(mocks.createKey).toHaveBeenCalledWith(owner.id, 'Agent', undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(
      screen.queryByLabelText('New organization key'),
    ).not.toBeInTheDocument();
  });
  it('requires deliberate confirmation for MCP approval and displays the human receipt', async () => {
    mocks.approvals.mockResolvedValue([
      {
        id: 'approval_a',
        organizationId: owner.id,
        skillName: 'org:create_org_key',
        arguments: { name: 'Agent' },
        status: 'pending',
        createdAt: '2026-11-09T00:00:00Z',
      },
    ]);
    mocks.decide.mockResolvedValue({
      result: { token: 'lbo_approved_human_secret' },
    });
    show(<OrganizationPage />);
    await screen.findByLabelText('Organization name');
    fireEvent.click(screen.getByRole('button', { name: 'approvals' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Approve request' }),
    );
    expect(mocks.decide).not.toHaveBeenCalled();
    const confirmation = screen.getByRole('alertdialog');
    fireEvent.change(
      within(confirmation).getByLabelText('Type APPROVE to confirm'),
      { target: { value: 'APPROVE' } },
    );
    fireEvent.click(
      within(confirmation).getByRole('button', { name: 'Confirm' }),
    );
    expect(await screen.findByLabelText('New organization key')).toHaveValue(
      'lbo_approved_human_secret',
    );
    expect(mocks.decide).toHaveBeenCalledWith(
      owner.id,
      'approval_a',
      'approved',
    );
  });
  it('offers no receipt replay for an approved org key, only the rotate hint', async () => {
    mocks.approvals.mockResolvedValue([
      {
        id: 'approval_key',
        organizationId: owner.id,
        skillName: 'org:create_org_key',
        arguments: { name: 'Agent' },
        status: 'approved',
        createdAt: '2026-11-09T00:00:00Z',
      },
      {
        id: 'approval_site',
        organizationId: owner.id,
        skillName: 'org:create_site',
        arguments: { name: 'Blog' },
        status: 'approved',
        createdAt: '2026-11-09T00:00:00Z',
      },
    ]);
    show(<OrganizationPage />);
    await screen.findByLabelText('Organization name');
    fireEvent.click(screen.getByRole('button', { name: 'approvals' }));
    expect(
      await screen.findByText(/The key was shown once at approval/),
    ).toBeInTheDocument();
    // Only the site approval keeps a receipt button.
    expect(screen.getAllByRole('button', { name: 'View receipt' })).toHaveLength(1);
  });
  it("preserves the owner row and shows the server's last-owner refusal", async () => {
    mocks.members.mockResolvedValue([
      { userId: 'last_owner', email: 'last@example.test', role: 'owner' },
    ]);
    mocks.updateMember.mockRejectedValue({
      body: { errors: [{ code: 'LAST_OWNER' }] },
    });
    show(<OrganizationPage />);
    await screen.findByLabelText('Organization name');
    fireEvent.click(screen.getByRole('button', { name: 'members' }));
    const role = await screen.findByLabelText('Role for last@example.test');
    fireEvent.change(role, { target: { value: 'admin' } });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'At least one owner must remain.',
    );
    expect(role).toHaveValue('owner');
    expect(mocks.updateMember).toHaveBeenCalledWith(
      owner.id,
      'last_owner',
      'admin',
    );
  });
});
