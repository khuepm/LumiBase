// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

let pathname = '/access/roles';

vi.mock('@tanstack/react-router', () => ({
  useRouterState: () => ({ location: { pathname } }),
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

import { AccessLayout } from '../layout';

afterEach(cleanup);

describe('AccessLayout active tab', () => {
  it.each([
    ['/access/api-keys', 'API keys'],
    ['/lumi-admin/access/api-keys', 'API keys'],
    ['/lumi-admin/access/policies/policy_1', 'Policies'],
  ])('marks %s active', (path, label) => {
    pathname = path;
    render(<AccessLayout><div>Page</div></AccessLayout>);

    expect(screen.getByRole('link', { name: label })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Roles' })).not.toHaveAttribute('aria-current', 'page');
  });
});
