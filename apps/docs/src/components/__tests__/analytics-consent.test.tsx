import { beforeEach, describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CONSENT_STORAGE_KEY } from '@lumibase/analytics-consent';
import { AnalyticsConsent } from '../analytics/AnalyticsConsent';
import { CookiePreferences } from '../analytics/CookiePreferences';

/**
 * Behavioural cover for the consent gate.
 *
 * The pure rules (ID validation, gating, snippet contents) are unit-tested in
 * `packages/analytics-consent`. What can only be checked here is the wiring: that
 * a `denied`/undecided visitor never causes a tag request, and that withdrawal
 * brings the banner back. Those are the assertions that catch someone inverting a
 * condition in JSX, which the package tests cannot see.
 */

const MEASUREMENT_ID = 'G-TEST12345';

/** Both components read the active locale through `useT`, which needs a router. */
function renderWithRouter(ui: ReactElement) {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <MemoryRouter initialEntries={['/en/']}>{children}</MemoryRouter>
  );
  return render(ui, { wrapper });
}

function gaScripts() {
  return Array.from(document.querySelectorAll('script[src*="googletagmanager.com"]'));
}

beforeEach(() => {
  window.localStorage.clear();
  for (const script of gaScripts()) script.remove();
  document.getElementById('lumibase-ga-tag')?.remove();
});

describe('AnalyticsConsent', () => {
  it('asks first and loads no tag while undecided', () => {
    renderWithRouter(<AnalyticsConsent measurementId={MEASUREMENT_ID} />);

    expect(screen.getByRole('dialog', { name: 'Analytics cookies' })).toBeInTheDocument();
    expect(gaScripts()).toHaveLength(0);
  });

  it('loads the tag once the visitor allows it, and stops asking', () => {
    renderWithRouter(<AnalyticsConsent measurementId={MEASUREMENT_ID} />);
    fireEvent.click(screen.getByRole('button', { name: 'Allow analytics' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(CONSENT_STORAGE_KEY)).toBe('granted');

    const scripts = gaScripts();
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.getAttribute('src')).toBe(
      `https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`
    );
  });

  it('loads nothing when the visitor declines', () => {
    renderWithRouter(<AnalyticsConsent measurementId={MEASUREMENT_ID} />);
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(CONSENT_STORAGE_KEY)).toBe('denied');
    expect(gaScripts()).toHaveLength(0);
  });

  it('honours a stored decline across visits — no banner, no tag', () => {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, 'denied');

    renderWithRouter(<AnalyticsConsent measurementId={MEASUREMENT_ID} />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(gaScripts()).toHaveLength(0);
  });

  it('honours a stored grant without asking again', () => {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, 'granted');

    renderWithRouter(<AnalyticsConsent measurementId={MEASUREMENT_ID} />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(gaScripts()).toHaveLength(1);
  });

  it('ignores an unrecognised stored value rather than treating it as consent', () => {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, 'yes');

    renderWithRouter(<AnalyticsConsent measurementId={MEASUREMENT_ID} />);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(gaScripts()).toHaveLength(0);
  });

  it('does not stack tags when re-rendered', () => {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, 'granted');

    const { rerender } = renderWithRouter(<AnalyticsConsent measurementId={MEASUREMENT_ID} />);
    rerender(<AnalyticsConsent measurementId={MEASUREMENT_ID} />);

    expect(gaScripts()).toHaveLength(1);
  });
});

describe('CookiePreferences', () => {
  it('reports the stored decision', () => {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, 'granted');
    renderWithRouter(<CookiePreferences />);

    expect(screen.getByText('Analytics cookies: allowed')).toBeInTheDocument();
  });

  it('withdrawing clears the decision and brings the banner back', () => {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, 'granted');
    renderWithRouter(
      <>
        <AnalyticsConsent measurementId={MEASUREMENT_ID} />
        <CookiePreferences />
      </>
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Change my choice' }));

    expect(window.localStorage.getItem(CONSENT_STORAGE_KEY)).toBeNull();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Analytics cookies: not set (none stored)')).toBeInTheDocument();
  });
});
