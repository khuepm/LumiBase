// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';

/**
 * Light render test for the tabbed Activity settings page (task 12.4).
 *
 * Confirms the tab switcher exposes both the "Activity" and "Security
 * audit" tabs and toggles the active panel. The bulk of the audit
 * coverage lives in `security-audit-tab.test.tsx`; here we only verify
 * the host page wires the two tabs together.
 *
 * `@/lib/api` and `react-i18next` are mocked so the page renders without
 * a real API client or i18n backend; `fetch` is stubbed for the audit
 * tab's query.
 *
 * **Validates: Requirements 15.4**
 */

// Mock the API client so the Activity tab's `client.activity.list` is a
// resolved no-op (this test isn't about the activity table's data).
vi.mock('@/lib/api', () => ({
  getApiClient: () => ({
    activity: { list: vi.fn().mockResolvedValue({ data: [] }) },
  }),
}));

// Mock react-i18next so `t('key', 'Default')` returns the default copy.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

import { ActivityPage } from '../activity-page';

function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      status: 200,
      headers: { get: () => null },
      json: async () => ({ data: { items: [], nextCursor: null } }),
    } as unknown as Response),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ActivityPage — tab switcher', () => {
  it('renders both tabs', () => {
    renderWithClient(<ActivityPage />);
    expect(screen.getByRole('tab', { name: /activity/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /security audit/i })).toBeInTheDocument();
  });

  it('defaults to the Activity tab selected', () => {
    renderWithClient(<ActivityPage />);
    expect(screen.getByRole('tab', { name: /activity/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: /security audit/i })).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  it('switches to the Security audit tab on click', () => {
    renderWithClient(<ActivityPage />);
    fireEvent.click(screen.getByRole('tab', { name: /security audit/i }));

    expect(screen.getByRole('tab', { name: /security audit/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // The security tab's Search button only exists when its panel is active.
    expect(screen.getByRole('button', { name: /search/i })).toBeInTheDocument();
  });
});
