import { create } from 'zustand';
import { canonicalTimeZone, isZonedDateTimeValue, type ZonedDateTime } from '@lumibase/contracts/field';

/**
 * Per-user display time zone (#747).
 *
 * `preference` mirrors `users.preferences.timezone` (loaded once in `AppShell`,
 * updated by Settings → Date & time). `null` means "follow the browser". Kept
 * in a store rather than React context so displays and interfaces rendered
 * outside a QueryClient (tests, extensions) still work.
 */
interface DisplayTimezoneState {
  preference: string | null;
  setPreference: (tz: string | null) => void;
}

export const useDisplayTimezoneStore = create<DisplayTimezoneState>((set) => ({
  preference: null,
  setPreference: (tz) => set({ preference: tz ? canonicalTimeZone(tz) : null }),
}));

/** The browser's zone, or `UTC` when the runtime cannot tell. */
export function browserTimeZone(): string {
  try {
    return canonicalTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone) ?? 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Effective display zone: the user's preference, else the browser zone. */
export function resolveDisplayTimeZone(preference: string | null | undefined): string {
  return (preference && canonicalTimeZone(preference)) || browserTimeZone();
}

export function useDisplayTimeZone(): string {
  const preference = useDisplayTimezoneStore((s) => s.preference);
  return resolveDisplayTimeZone(preference);
}

/** `Jun 1, 2026, 9:00 AM` in `tz`. */
export function formatInZone(
  instant: string | number | Date,
  tz: string,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
): string {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(undefined, { ...options, timeZone: tz }).format(date);
  } catch {
    return date.toISOString();
  }
}

/**
 * Hint describing the original zone of a stored value, e.g.
 * `10:00 AM Europe/London (+01:00)`, or `null` when it equals the display zone.
 */
export function originalZoneHint(value: unknown, displayTz: string): string | null {
  if (!isZonedDateTimeValue(value)) return null;
  const v = value as ZonedDateTime;
  if (v.tz === displayTz) return null;
  const time = formatInZone(v.instant, v.tz, { dateStyle: 'medium', timeStyle: 'short' });
  return `${time} ${v.tz}${v.offset ? ` (${v.offset})` : ''}`;
}
