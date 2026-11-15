// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { FieldResource } from '@lumibase/sdk';

/**
 * Studio side of timezone-aware datetime fields (#747): the editor, the list
 * display (user zone + original-zone hint) and the per-user display zone.
 */

const updatePreferences = vi.fn();
vi.mock('@/lib/api', () => ({
  getApiClient: () => ({ me: { updatePreferences } }),
}));

import { DatetimeInterface } from '../interfaces/datetime';
import { FormattedDateDisplay } from '../displays/formatted-date';
import { DateTimeSettingsPage } from '../../settings/date-time-page';
import {
  originalZoneHint,
  resolveDisplayTimeZone,
  useDisplayTimezoneStore,
} from '@/lib/display-timezone';

function field(options: Record<string, unknown>, extra: Partial<FieldResource> = {}): FieldResource {
  return {
    id: 'f1',
    collectionId: 'c1',
    name: 'starts_at',
    type: 'datetime',
    interface: 'datetime',
    required: false,
    hidden: false,
    sortOrder: 0,
    options,
    ...extra,
  } as FieldResource;
}

const NY_VALUE = { instant: '2026-07-04T13:00:00.000Z', tz: 'America/New_York', offset: '-04:00' };

beforeEach(() => {
  useDisplayTimezoneStore.getState().setPreference('Europe/London');
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useDisplayTimezoneStore.getState().setPreference(null);
});

describe('display time zone', () => {
  it('uses the preference, else the browser zone; ignores unknown ids', () => {
    expect(resolveDisplayTimeZone('Asia/Tokyo')).toBe('Asia/Tokyo');
    const browser = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(resolveDisplayTimeZone(null)).toBe(browser === 'Etc/Unknown' ? 'UTC' : resolveDisplayTimeZone(browser));
    expect(resolveDisplayTimeZone('Nowhere/Land')).toBe(resolveDisplayTimeZone(null));
  });

  it('hints the original zone only when it differs from the display zone', () => {
    expect(originalZoneHint(NY_VALUE, 'Europe/London')).toMatch(/9:00.*America\/New_York \(-04:00\)/);
    expect(originalZoneHint(NY_VALUE, 'America/New_York')).toBeNull();
    expect(originalZoneHint('2026-01-01T00:00:00Z', 'UTC')).toBeNull();
  });
});

describe('DatetimeInterface', () => {
  it('keeps the legacy bare-string behaviour without the option', () => {
    const onChange = vi.fn();
    render(<DatetimeInterface value="2026-07-04T09:00:00Z" field={field({})} onChange={onChange} />);
    expect(screen.queryByLabelText('Time zone')).toBeNull();
    fireEvent.change(screen.getByDisplayValue('2026-07-04T09:00'), { target: { value: '2026-07-05T10:00' } });
    expect(onChange).toHaveBeenCalledWith('2026-07-05T10:00');
  });

  it('edits wall time in the value zone and emits { instant, tz, offset }', () => {
    const onChange = vi.fn();
    render(<DatetimeInterface value={NY_VALUE} field={field({ timezone: true })} onChange={onChange} />);
    expect(screen.getByLabelText('Date and time')).toHaveProperty('value', '2026-07-04T09:00');
    expect(screen.getByLabelText('Time zone')).toHaveProperty('value', 'America/New_York');
    // Hint: same instant in the user's display zone (London).
    expect(screen.getByTestId('zoned-hint').textContent).toMatch(/UTC-04:00 · .*2:00.*Europe\/London/);

    fireEvent.change(screen.getByLabelText('Date and time'), { target: { value: '2026-07-04T10:30' } });
    expect(onChange).toHaveBeenLastCalledWith({ instant: '2026-07-04T14:30:00.000Z', tz: 'America/New_York', offset: '-04:00' });

    // Changing the zone keeps the wall time.
    fireEvent.change(screen.getByLabelText('Time zone'), { target: { value: 'Asia/Tokyo' } });
    expect(onChange).toHaveBeenLastCalledWith({ instant: '2026-07-04T00:00:00.000Z', tz: 'Asia/Tokyo', offset: '+09:00' });
  });

  it('defaults a new value to the user display zone and explains a DST gap', () => {
    const onChange = vi.fn();
    useDisplayTimezoneStore.getState().setPreference('America/New_York');
    render(<DatetimeInterface value={null} field={field({ timezone: true })} onChange={onChange} />);
    expect(screen.getByLabelText('Time zone')).toHaveProperty('value', 'America/New_York');
    fireEvent.change(screen.getByLabelText('Date and time'), { target: { value: '2026-03-08T02:30' } });
    expect(onChange).toHaveBeenLastCalledWith({ instant: '2026-03-08T07:30:00.000Z', tz: 'America/New_York', offset: '-04:00' });
    expect(screen.getByRole('status').textContent).toMatch(/does not exist/);
  });

  it('refuses a nonexistent time when the field rejects DST ambiguity', () => {
    const onChange = vi.fn();
    render(
      <DatetimeInterface value={NY_VALUE} field={field({ timezone: true, disambiguation: 'reject' })} onChange={onChange} />,
    );
    fireEvent.change(screen.getByLabelText('Date and time'), { target: { value: '2026-03-08T02:30' } });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toMatch(/DST gap/);
  });
});

describe('FormattedDateDisplay', () => {
  it('shows a zoned value in the user zone with the original zone as a hint', () => {
    render(<>{FormattedDateDisplay({ value: NY_VALUE, field: field({ timezone: true }, { displayOptions: { format: 'short' } }) })}</>);
    expect(document.body.textContent).toMatch(/Jul 4, 2026/);
    expect(document.body.textContent).toMatch(/America\/New_York \(-04:00\)/);
  });

  it('renders plain string values as before', () => {
    render(<>{FormattedDateDisplay({ value: '2026-07-04T13:00:00.000Z', field: field({}, { displayOptions: { format: 'iso' } }) })}</>);
    expect(document.body.textContent).toBe('2026-07-04T13:00:00.000Z');
  });
});

describe('Settings → Date & time', () => {
  function renderPage() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <DateTimeSettingsPage />
      </QueryClientProvider>,
    );
  }

  it('persists the chosen zone and clears it back to the browser default', async () => {
    updatePreferences.mockResolvedValue({ data: {} });
    renderPage();
    const select = screen.getByLabelText('Display time zone');
    expect(select).toHaveProperty('value', 'Europe/London');

    fireEvent.change(select, { target: { value: 'Australia/Lord_Howe' } });
    await waitFor(() => expect(updatePreferences).toHaveBeenCalledWith({ timezone: 'Australia/Lord_Howe' }));
    await waitFor(() => expect(useDisplayTimezoneStore.getState().preference).toBe('Australia/Lord_Howe'));

    fireEvent.change(select, { target: { value: '' } });
    await waitFor(() => expect(updatePreferences).toHaveBeenLastCalledWith({ timezone: null }));
    await waitFor(() => expect(useDisplayTimezoneStore.getState().preference).toBeNull());
  });
});
