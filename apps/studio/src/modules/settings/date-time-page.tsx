import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Clock } from 'lucide-react';
import { listTimeZones } from '@lumibase/contracts/field';
import { getApiClient } from '@/lib/api';
import {
  browserTimeZone,
  formatInZone,
  resolveDisplayTimeZone,
  useDisplayTimezoneStore,
} from '@/lib/display-timezone';

/** `<select>` value meaning "no preference — follow the browser". */
const BROWSER = '';

/**
 * Settings → Date & time (#747). Per-user display time zone, persisted to
 * `users.preferences.timezone` via `PATCH /me/preferences`. Dates in lists and
 * date inputs render in this zone; timezone-aware fields also show the zone
 * the value was authored in. Empty = follow the browser.
 */
export function DateTimeSettingsPage() {
  const client = getApiClient();
  const qc = useQueryClient();
  const preference = useDisplayTimezoneStore((s) => s.preference);
  const setPreference = useDisplayTimezoneStore((s) => s.setPreference);
  const zones = useMemo(() => listTimeZones(), []);
  const browser = useMemo(() => browserTimeZone(), []);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const mutation = useMutation({
    mutationFn: (timezone: string | null) => client.me.updatePreferences({ timezone }),
    onMutate: () => {
      setError(null);
      setSaved(false);
    },
    onSuccess: (_res, timezone) => {
      setPreference(timezone);
      setSaved(true);
      qc.invalidateQueries({ queryKey: ['me', 'preferences'] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Could not save the time zone.'),
  });

  const effective = resolveDisplayTimeZone(preference);
  const now = new Date();

  return (
    <div className="mx-auto max-w-3xl space-y-8 p-6">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-3xl font-semibold tracking-tight">
          <Clock className="h-7 w-7" /> Date &amp; time
        </h1>
        <p className="text-sm text-muted-foreground">
          The time zone Studio shows dates in. Timezone-aware fields also show the zone each value was entered in.
        </p>
      </header>

      <section className="space-y-3 rounded-lg border p-4">
        <label htmlFor="display-timezone" className="block text-sm font-medium">
          Display time zone
        </label>
        <select
          id="display-timezone"
          value={preference ?? BROWSER}
          disabled={mutation.isPending}
          onChange={(e) => mutation.mutate(e.target.value === BROWSER ? null : e.target.value)}
          className="w-full rounded-md border bg-background px-2 py-1.5 text-sm disabled:opacity-50"
        >
          <option value={BROWSER}>Browser default ({browser})</option>
          {zones.map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground" data-testid="tz-preview">
          Now: {formatInZone(now, effective, { dateStyle: 'full', timeStyle: 'long' })} ({effective})
        </p>
        {saved && !error && <p className="text-xs text-emerald-600" role="status">Saved.</p>}
        {error && (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}
