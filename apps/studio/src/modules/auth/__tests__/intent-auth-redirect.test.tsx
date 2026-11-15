// @vitest-environment jsdom
/**
 * Intent links survive sign-in (issue #759): signed-out → `{adminPath}/login?next=…`
 * → after login back to the intent, admin prefix included. `next` is never an
 * open redirect.
 */
import { render, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({
  navigate: vi.fn(),
  location: { pathname: '/', searchStr: '' },
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => nav.navigate,
  useRouterState: () => ({ location: nav.location }),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));

vi.mock('@/modules/setup/use-setup-state-query', () => ({
  useSetupStateQuery: () => ({
    data: { state: 'initialized' },
    isError: false,
    isSuccess: true,
    isFetching: false,
    isPending: false,
    refetch: vi.fn(),
  }),
  shouldShowSetupStateError: () => false,
}));

import { AdminReadyGate } from '@/modules/setup/admin-ready-gate';
import { AdminLoginPage } from '../admin-login-page';
import { clearActiveToken, setActiveToken } from '@/lib/api';

const NEXT = '/intent/edit?collection=posts&id=p1&locale=vi&field=title';

function setUrl(path: string) {
  window.history.replaceState(null, '', path);
}

beforeEach(() => {
  nav.navigate.mockReset();
  localStorage.clear();
  clearActiveToken();
});
afterEach(() => clearActiveToken());

describe('AdminReadyGate — signed-out intent link', () => {
  it('redirects to the admin login with the intent as next', async () => {
    nav.location = { pathname: '/lumi-7f3a9c/intent/edit', searchStr: '?collection=posts&id=p1&locale=vi&field=title' };
    render(
      <AdminReadyGate>
        <p>shell</p>
      </AdminReadyGate>,
    );
    await waitFor(() =>
      expect(nav.navigate).toHaveBeenCalledWith({
        href: `/lumi-7f3a9c/login?next=${encodeURIComponent(NEXT)}`,
        replace: true,
      }),
    );
  });

  it('does not redirect for ordinary module pages (unchanged behaviour)', async () => {
    nav.location = { pathname: '/lumi-7f3a9c/content/posts', searchStr: '' };
    render(
      <AdminReadyGate>
        <p>shell</p>
      </AdminReadyGate>,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(nav.navigate).not.toHaveBeenCalledWith(expect.objectContaining({ href: expect.stringContaining('next=') }));
  });
});

describe('AdminLoginPage — return to the intent', () => {
  it('goes back to the prefixed intent when already signed in', async () => {
    setActiveToken('tok');
    setUrl(`/lumi-7f3a9c/login?next=${encodeURIComponent(NEXT)}`);
    render(<AdminLoginPage adminPath="lumi-7f3a9c" />);
    await waitFor(() =>
      expect(nav.navigate).toHaveBeenCalledWith({ href: `/lumi-7f3a9c${NEXT}`, replace: true }),
    );
  });

  it.each([
    'https://evil.example/intent/edit?collection=posts&id=p1',
    '//evil.example/intent/edit',
    '/settings/security',
    '/\\evil.example',
  ])('ignores an unsafe next %j and lands on the admin home', async (next) => {
    setActiveToken('tok');
    setUrl(`/lumi-7f3a9c/login?next=${encodeURIComponent(next)}`);
    render(<AdminLoginPage adminPath="lumi-7f3a9c" />);
    await waitFor(() => expect(nav.navigate).toHaveBeenCalledWith({ to: '/lumi-7f3a9c' }));
    expect(nav.navigate).not.toHaveBeenCalledWith(expect.objectContaining({ href: expect.anything() }));
  });
});

describe('handleUnauthorized — expired session on an intent link', () => {
  it('keeps the intent as next on the forced re-login', async () => {
    vi.resetModules();
    const assign = vi.fn();
    const search = '?collection=posts&id=p1';
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, pathname: '/lumi-7f3a9c/intent/edit', search, assign },
    });
    const api = await import('@/lib/api');
    api.setActiveToken('stale');
    api.handleUnauthorized();
    expect(assign).toHaveBeenCalledWith(
      `/lumi-7f3a9c/login?next=${encodeURIComponent(`/intent/edit${search}`)}`,
    );
  });
});
