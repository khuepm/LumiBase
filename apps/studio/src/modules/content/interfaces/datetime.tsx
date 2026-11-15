import { useMemo, useState } from 'react';
import {
  instantToLocal,
  isZonedDateTimeField,
  isZonedDateTimeValue,
  listTimeZones,
  zonedFromInstant,
  zonedFromLocal,
  ZonedDateTimeError,
  type Disambiguation,
  type WallTimeResolution,
  type ZonedDateTime,
} from '@lumibase/contracts/field';
import { formatInZone, useDisplayTimeZone } from '@/lib/display-timezone';
import { readOptions, type InterfaceComponent } from './types';

interface DateOptions {
  /** `date` (YYYY-MM-DD), `datetime-local` (default), or `time`. */
  variant?: 'date' | 'datetime-local' | 'time';
  /** Timezone-aware field (#747). */
  timezone?: boolean;
  defaultTimezone?: string;
  disambiguation?: Disambiguation;
}

/** Field options live top-level on the field row; older rows keep them under `meta`. */
function fieldOptions(field: Parameters<InterfaceComponent>[0]['field']): DateOptions {
  const top = (field as { options?: Record<string, unknown> }).options;
  if (top && Object.keys(top).length > 0) return top as DateOptions;
  return readOptions<DateOptions>(field);
}

/**
 * `datetime` — wraps a native HTML date/time input.
 * Stores values as ISO strings (datetime-local without seconds is fine for now).
 * With `options.timezone` the value is `{ instant, tz, offset }` and the
 * editor gains a zone picker (see {@link ZonedDatetimeInput}).
 */
export const DatetimeInterface: InterfaceComponent<unknown> = ({
  value,
  field,
  disabled,
  onChange,
}) => {
  const opts = fieldOptions(field);
  if (isZonedDateTimeField({ type: field.type, options: opts })) {
    return <ZonedDatetimeInput value={value} options={opts} disabled={disabled} onChange={onChange} />;
  }
  const variant = opts.variant ?? 'datetime-local';
  return (
    <input
      type={variant}
      value={toInputValue(typeof value === 'string' ? value : null, variant)}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
      className="w-full rounded-md border bg-background px-2 py-1 text-sm disabled:opacity-50"
    />
  );
};

function toInputValue(raw: string | null | undefined, variant: DateOptions['variant']): string {
  if (!raw) return '';
  // Accept either ISO with timezone (server) or already a local form (client).
  if (variant === 'datetime-local') {
    // Strip seconds + Z so HTML input accepts the value.
    return raw.length >= 16 ? raw.slice(0, 16) : raw;
  }
  return raw;
}

const RESOLUTION_NOTE: Record<Exclude<WallTimeResolution, 'exact'>, string> = {
  gap: 'That time does not exist in this zone (DST starts) — moved forward.',
  overlap: 'That time occurs twice in this zone (DST ends) — the first occurrence was used.',
};

/**
 * Editor for a timezone-aware value. The wall time is edited in the value's
 * own zone (the event's zone — "9:00 in Tokyo"), which defaults to the user's
 * display zone for a new value. A hint shows the same instant in the user's
 * display zone when the two differ. The conversion runs client-side with the
 * same rules as the server, so what is shown is what is saved.
 */
export function ZonedDatetimeInput({
  value,
  options,
  disabled,
  onChange,
}: {
  value: unknown;
  options: DateOptions;
  disabled?: boolean;
  onChange: (next: ZonedDateTime | null) => void;
}) {
  const displayTz = useDisplayTimeZone();
  const zones = useMemo(() => listTimeZones(), []);
  const current = normalizeForEditor(value, options.defaultTimezone ?? displayTz);
  const tz = current?.tz ?? displayTz;
  const wall = current ? instantToLocal(current.instant, tz).slice(0, 16) : '';
  const rule: Disambiguation = options.disambiguation ?? 'compatible';

  const [note, setNote] = useState<string | null>(null);
  const commitWall = (nextWall: string, nextTz: string) => {
    if (!nextWall) {
      setNote(null);
      return onChange(null);
    }
    try {
      const r = zonedFromLocal(nextWall, nextTz, rule);
      setNote(r.resolution === 'exact' ? null : RESOLUTION_NOTE[r.resolution]);
      onChange(r.value);
    } catch (err) {
      if (!(err instanceof ZonedDateTimeError)) throw err;
      // `disambiguation: 'reject'` — keep the previous value and say why.
      setNote(err.message);
    }
  };

  const zoneOptions = zones.includes(tz) ? zones : [tz, ...zones];
  return (
    <div className="space-y-1">
      <div className="flex gap-2">
        <input
          type="datetime-local"
          aria-label="Date and time"
          value={wall}
          disabled={disabled}
          onChange={(e) => commitWall(e.target.value, tz)}
          className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-sm disabled:opacity-50"
        />
        <select
          aria-label="Time zone"
          value={tz}
          disabled={disabled}
          // Changing the zone keeps the wall time ("9:00, now in Tokyo").
          onChange={(e) => (wall ? commitWall(wall, e.target.value) : undefined)}
          className="w-48 rounded-md border bg-background px-2 py-1 text-sm disabled:opacity-50"
        >
          {zoneOptions.map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </select>
      </div>
      {current && (
        <p className="text-xs text-muted-foreground" data-testid="zoned-hint">
          {current.offset ? `UTC${current.offset}` : ''}
          {tz !== displayTz ? ` · ${formatInZone(current.instant, displayTz)} in your time zone (${displayTz})` : ''}
        </p>
      )}
      {note && (
        <p className="text-xs text-amber-600" role="status">
          {note}
        </p>
      )}
    </div>
  );
}

/** Stored value → editor value. Legacy bare strings are read as instants. */
function normalizeForEditor(value: unknown, fallbackTz: string): ZonedDateTime | null {
  if (isZonedDateTimeValue(value)) return value;
  if (typeof value === 'string' && value) {
    try {
      return zonedFromInstant(value, fallbackTz);
    } catch {
      const ms = Date.parse(value);
      return Number.isNaN(ms) ? null : zonedFromInstant(ms, fallbackTz);
    }
  }
  return null;
}
