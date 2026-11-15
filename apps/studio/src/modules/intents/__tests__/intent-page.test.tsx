// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({
  navigate: vi.fn(),
  params: { action: 'edit' } as Record<string, string>,
  searchStr: '',
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => nav.navigate,
  useParams: () => nav.params,
  useRouterState: ({ select }: { select: (s: { location: { searchStr: string } }) => unknown }) =>
    select({ location: { searchStr: nav.searchStr } }),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

const ext = vi.hoisted(() => ({ load: vi.fn(async () => undefined) }));
vi.mock('@/lib/extension-loader', () => ({ loadExtensionIntentHandlers: ext.load }));

import { IntentPage, IntentResolver } from '../intent-page';
import { clearIntentHandlers, registerIntentHandlers } from '@/lib/intents/registry';
import { getActiveSite, setActiveSite } from '@/lib/api';

function wrap(ui: ReactNode) {
  const qc = new QueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function at(pathname: string, action: string, searchStr: string) {
  window.history.replaceState(null, '', `${pathname}${searchStr}`);
  nav.params = { action };
  nav.searchStr = searchStr;
}

beforeEach(() => {
  nav.navigate.mockReset();
  localStorage.clear();
  setActiveSite('site_a');
});
afterEach(() => clearIntentHandlers());

describe('IntentPage', () => {
  it('resolves an edit intent to the item editor under the admin prefix', async () => {
    at('/lumi-7f3a9c/intent/edit', 'edit', '?collection=posts&id=p1&locale=vi&field=title');
    wrap(<IntentPage />);
    await waitFor(() =>
      expect(nav.navigate).toHaveBeenCalledWith({
        href: '/lumi-7f3a9c/content/posts/p1?locale=vi&field=title',
        replace: true,
      }),
    );
    expect(ext.load).toHaveBeenCalled();
  });

  it('keeps ids raw (no JSON coercion of numeric ids)', async () => {
    at('/intent/open', 'open', '?collection=posts&id=00123');
    wrap(<IntentPage />);
    await waitFor(() =>
      expect(nav.navigate).toHaveBeenCalledWith({ href: '/content/posts/00123', replace: true }),
    );
  });

  it('renders a friendly error page for invalid links and never navigates', async () => {
    at('/intent/edit', 'edit', '?collection=posts&id=p1&next=https://evil.example');
    wrap(<IntentPage />);
    expect(await screen.findByRole('alert', { name: 'This link can’t be opened' })).toBeInTheDocument();
    expect(screen.getByText('next')).toBeInTheDocument();
    expect(nav.navigate).not.toHaveBeenCalled();
  });

  it('renders the error page for an unknown action', async () => {
    at('/intent/destroy', 'destroy', '?collection=posts');
    wrap(<IntentPage />);
    expect(await screen.findByText(/Unknown intent action/)).toBeInTheDocument();
  });

  it('uses an extension claim when one wins', async () => {
    registerIntentHandlers('seo-tools', ['intents:claim:edit:posts'], [
      { id: 'seo', canHandle: () => 10, handle: () => ({ navigate: '/content/posts/p1?panel=seo' }) },
    ]);
    at('/intent/edit', 'edit', '?collection=posts&id=p1');
    wrap(<IntentPage />);
    await waitFor(() =>
      expect(nav.navigate).toHaveBeenCalledWith({ href: '/content/posts/p1?panel=seo', replace: true }),
    );
  });
});

describe('IntentResolver — site switching', () => {
  const intent = { v: 1 as const, action: 'edit' as const, collection: 'posts', id: 'p1', site: 'site_b' };

  it('refuses a site the user cannot access and does not act on the current site', async () => {
    const probe = vi.fn(async () => 'denied' as const);
    wrap(<IntentResolver intent={intent} probe={probe} />);
    expect(await screen.findByRole('alert', { name: 'You don’t have access to that site' })).toBeInTheDocument();
    expect(probe).toHaveBeenCalledWith('site_b');
    expect(nav.navigate).not.toHaveBeenCalled();
    expect(getActiveSite()).toBe('site_a');
  });

  it('reports a probe failure without switching', async () => {
    wrap(<IntentResolver intent={intent} probe={async () => 'error'} />);
    expect(await screen.findByText(/Couldn’t check access/)).toBeInTheDocument();
    expect(getActiveSite()).toBe('site_a');
  });

  it('asks before switching to an accessible site, then switches on confirm', async () => {
    const reload = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, reload } });
    wrap(<IntentResolver intent={intent} probe={async () => 'allowed'} />);
    const button = await screen.findByRole('button', { name: /Switch to site_b/ });
    expect(getActiveSite()).toBe('site_a');
    expect(nav.navigate).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(getActiveSite()).toBe('site_b');
  });

  it('skips the probe when the link targets the active site', async () => {
    const probe = vi.fn();
    wrap(<IntentResolver intent={{ ...intent, site: 'site_a' }} probe={probe} />);
    await waitFor(() => expect(nav.navigate).toHaveBeenCalled());
    expect(probe).not.toHaveBeenCalled();
  });
});
