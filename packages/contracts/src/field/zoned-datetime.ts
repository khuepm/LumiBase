/**
 * Timezone-aware datetime values (issue #747).
 *
 * A `datetime` / `timestamp` field with `options.timezone === true` stores a
 * {@link ZonedDateTime} object in the item JSON instead of a bare ISO string:
 *
 * ```json
 * { "instant": "2026-03-08T07:30:00.000Z", "tz": "America/New_York", "offset": "-04:00" }
 * ```
 *
 * - `instant` — the absolute point in time, ISO-8601 in UTC. Filters and sort
 *   operate on it.
 * - `tz` — the IANA zone the value was authored in (the "original" zone).
 * - `offset` — the UTC offset `tz` had at `instant`, recomputed by the server
 *   on every write, so a reader can show the original wall time without a tz
 *   database.
 *
 * Only `Intl` is used, so the module runs unchanged on Cloudflare Workers,
 * Node and browsers. Wall time ↔ instant conversion follows the Temporal
 * `disambiguation` semantics:
 *
 * | rule         | DST gap (wall time does not exist)  | DST overlap (wall time occurs twice) |
 * |--------------|-------------------------------------|--------------------------------------|
 * | `compatible` | shift forward by the gap length     | earlier instant (pre-transition offset) |
 * | `earlier`    | shift backward by the gap length    | earlier instant                      |
 * | `later`      | shift forward by the gap length     | later instant                        |
 * | `reject`     | error                               | error                                |
 *
 * `compatible` is the default (it is also Temporal's and RFC 5545's).
 */

export interface ZonedDateTime {
  /** ISO-8601 instant in UTC, e.g. `2026-03-08T07:30:00.000Z`. */
  instant: string;
  /** IANA time zone the value was authored in, e.g. `America/New_York`. */
  tz: string;
  /** UTC offset of `tz` at `instant`, e.g. `-04:00` (`±HH:MM`, `±HH:MM:SS` for historic LMT). */
  offset: string;
}

export type Disambiguation = 'compatible' | 'earlier' | 'later' | 'reject';
export const DISAMBIGUATIONS: readonly Disambiguation[] = ['compatible', 'earlier', 'later', 'reject'];

/** How a wall time mapped onto the time line. */
export type WallTimeResolution = 'exact' | 'gap' | 'overlap';

/** Field options understood by a timezone-aware datetime field. */
export interface ZonedDateTimeFieldOptions {
  /** Opt-in flag. Without it the field keeps its historical bare-string shape. */
  timezone?: boolean;
  /** Zone for inputs that carry no `tz` (bare ISO strings). Defaults to `UTC`. */
  defaultTimezone?: string;
  /** DST rule for `{ local, tz }` inputs. Defaults to `compatible`. */
  disambiguation?: Disambiguation;
}

export type ZonedDateTimeErrorCode =
  | 'INVALID_TIMEZONE'
  | 'INVALID_INSTANT'
  | 'INVALID_LOCAL_TIME'
  | 'NONEXISTENT_LOCAL_TIME'
  | 'AMBIGUOUS_LOCAL_TIME'
  | 'INVALID_VALUE';

export class ZonedDateTimeError extends Error {
  readonly code: ZonedDateTimeErrorCode;
  constructor(code: ZonedDateTimeErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'ZonedDateTimeError';
  }
}

/** Field types that may opt into `options.timezone`. */
export const ZONED_DATETIME_FIELD_TYPES: readonly string[] = ['datetime', 'dateTime', 'timestamp'];

/** True when a field stores {@link ZonedDateTime} values. */
export function isZonedDateTimeField(field: { type: string; options?: unknown }): boolean {
  if (!ZONED_DATETIME_FIELD_TYPES.includes(field.type)) return false;
  const options = field.options;
  return !!options && typeof options === 'object' && (options as { timezone?: unknown }).timezone === true;
}

/** True for a value that already has the stored {@link ZonedDateTime} shape. */
export function isZonedDateTimeValue(value: unknown): value is ZonedDateTime {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v.instant === 'string' && typeof v.tz === 'string';
}

// ── Time zone validation ─────────────────────────────────────────────────────

/**
 * Used when the runtime lacks `Intl.supportedValuesOf` (older engines), and to
 * add the ids V8 leaves out of that list (`UTC`, current spellings such as
 * `Asia/Kolkata` / `Europe/Kyiv` that V8 still reports under their old name).
 */
export const FALLBACK_TIME_ZONES: readonly string[] = [
  'UTC',
  'Etc/UTC',
  'Africa/Abidjan',
  'Africa/Cairo',
  'Africa/Casablanca',
  'Africa/Johannesburg',
  'Africa/Lagos',
  'Africa/Nairobi',
  'America/Anchorage',
  'America/Argentina/Buenos_Aires',
  'America/Bogota',
  'America/Chicago',
  'America/Denver',
  'America/Halifax',
  'America/Los_Angeles',
  'America/Mexico_City',
  'America/New_York',
  'America/Phoenix',
  'America/Santiago',
  'America/Sao_Paulo',
  'America/St_Johns',
  'America/Toronto',
  'America/Vancouver',
  'Asia/Bangkok',
  'Asia/Dhaka',
  'Asia/Dubai',
  'Asia/Ho_Chi_Minh',
  'Asia/Hong_Kong',
  'Asia/Jakarta',
  'Asia/Jerusalem',
  'Asia/Karachi',
  'Asia/Kathmandu',
  'Asia/Kolkata',
  'Asia/Manila',
  'Asia/Riyadh',
  'Asia/Seoul',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Asia/Taipei',
  'Asia/Tehran',
  'Asia/Tokyo',
  'Atlantic/Azores',
  'Atlantic/Reykjavik',
  'Australia/Adelaide',
  'Australia/Brisbane',
  'Australia/Darwin',
  'Australia/Lord_Howe',
  'Australia/Melbourne',
  'Australia/Perth',
  'Australia/Sydney',
  'Europe/Amsterdam',
  'Europe/Athens',
  'Europe/Berlin',
  'Europe/Brussels',
  'Europe/Dublin',
  'Europe/Helsinki',
  'Europe/Istanbul',
  'Europe/Kyiv',
  'Europe/Lisbon',
  'Europe/London',
  'Europe/Madrid',
  'Europe/Moscow',
  'Europe/Paris',
  'Europe/Rome',
  'Europe/Stockholm',
  'Europe/Warsaw',
  'Europe/Zurich',
  'Pacific/Auckland',
  'Pacific/Chatham',
  'Pacific/Honolulu',
  'Pacific/Kiritimati',
  'Pacific/Pago_Pago',
];

const FALLBACK_SET = new Set(FALLBACK_TIME_ZONES);
const TZ_SHAPE = /^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+){0,2}$/;
const ETC_GMT = /^Etc\/GMT[+-](?:[0-9]|1[0-4])$/;

let supportedCache: ReadonlySet<string> | null | undefined;

/** `Intl.supportedValuesOf('timeZone')` as a set, or `null` when the runtime lacks it. */
function supportedSet(): ReadonlySet<string> | null {
  if (supportedCache !== undefined) return supportedCache;
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  try {
    supportedCache = typeof intl.supportedValuesOf === 'function' ? new Set(intl.supportedValuesOf('timeZone')) : null;
  } catch {
    supportedCache = null;
  }
  return supportedCache;
}

/** Test hook: force the "runtime lacks `supportedValuesOf`" path. */
export function __setSupportedTimeZonesForTest(zones: readonly string[] | null | undefined): void {
  supportedCache = zones === undefined ? undefined : zones === null ? null : new Set(zones);
}

function known(name: string): boolean {
  return FALLBACK_SET.has(name) || (supportedSet()?.has(name) ?? false) || ETC_GMT.test(name);
}

/**
 * Validate an IANA zone id and return its canonical spelling, or `null`.
 * Accepted: ids in `Intl.supportedValuesOf('timeZone')` (or the fallback list
 * when the runtime lacks it), plus aliases the runtime resolves to one of them
 * (`US/Eastern` → `America/New_York`, `utc` → `UTC`). Fixed offsets (`+05:00`)
 * are not IANA zones and are rejected.
 */
export function canonicalTimeZone(tz: unknown): string | null {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64 || !TZ_SHAPE.test(tz)) return null;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  if (known(tz)) return tz;
  if (known(resolved)) return resolved;
  return null;
}

export function isValidTimeZone(tz: unknown): tz is string {
  return canonicalTimeZone(tz) !== null;
}

/** Zones to offer in a picker: the runtime list (plus `UTC`) or the fallback list. */
export function listTimeZones(): string[] {
  const supported = supportedSet();
  const all = new Set<string>(supported ? ['UTC', ...supported] : FALLBACK_TIME_ZONES);
  return [...all].sort((a, b) => (a === 'UTC' ? -1 : b === 'UTC' ? 1 : a.localeCompare(b)));
}

// ── Offset arithmetic ────────────────────────────────────────────────────────

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      era: 'short',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(tz, f);
  }
  return f;
}

interface WallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

/** UTC epoch ms of a wall-clock reading, valid for years 1–9999 (no 19xx remap). */
function wallToEpochMs(p: WallParts): number {
  const d = new Date(0);
  d.setUTCFullYear(p.year, p.month - 1, p.day);
  d.setUTCHours(p.hour, p.minute, p.second, p.millisecond);
  return d.getTime();
}

function wallPartsAt(epochMs: number, tz: string): WallParts {
  const parts = formatterFor(tz).formatToParts(new Date(epochMs));
  const get = (type: string): number => Number(parts.find((x) => x.type === type)?.value ?? NaN);
  const era = parts.find((x) => x.type === 'era')?.value;
  const rawYear = get('year');
  return {
    year: era === 'BC' || era === 'B' ? 1 - rawYear : rawYear,
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
    millisecond: ((epochMs % 1000) + 1000) % 1000,
  };
}

/** UTC offset of `tz` at `epochMs`, in whole seconds (east of UTC positive). */
export function offsetSecondsAt(epochMs: number, tz: string): number {
  const floored = Math.floor(epochMs / 1000) * 1000;
  const wall = wallPartsAt(floored, tz);
  return Math.round((wallToEpochMs({ ...wall, millisecond: 0 }) - floored) / 1000);
}

/** `-18000` → `-05:00`; `-17762` → `-04:56:02`. */
export function formatOffset(seconds: number): string {
  const sign = seconds < 0 ? '-' : '+';
  const abs = Math.abs(seconds);
  const hh = String(Math.floor(abs / 3600)).padStart(2, '0');
  const mm = String(Math.floor((abs % 3600) / 60)).padStart(2, '0');
  const ss = abs % 60;
  return `${sign}${hh}:${mm}${ss ? `:${String(ss).padStart(2, '0')}` : ''}`;
}

// ── Parsing ──────────────────────────────────────────────────────────────────

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/;
const INSTANT_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|z|[+-](\d{2}):?(\d{2}))$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function partsFromMatch(m: RegExpExecArray): WallParts | null {
  const p: WallParts = {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: m[6] ? Number(m[6]) : 0,
    millisecond: m[7] ? Number(m[7].slice(0, 3).padEnd(3, '0')) : 0,
  };
  if (p.year < 1 || p.month < 1 || p.month > 12 || p.day < 1 || p.day > daysInMonth(p.year, p.month)) return null;
  if (p.hour > 23 || p.minute > 59 || p.second > 59) return null;
  return p;
}

/** Parse a local wall time `YYYY-MM-DDTHH:mm[:ss[.fff]]` (no offset). */
export function parseLocalDateTime(local: string): WallParts {
  const m = typeof local === 'string' ? LOCAL_RE.exec(local) : null;
  const p = m ? partsFromMatch(m) : null;
  if (!p) throw new ZonedDateTimeError('INVALID_LOCAL_TIME', `Invalid local date-time ${JSON.stringify(local)}; expected YYYY-MM-DDTHH:mm[:ss].`);
  return p;
}

/** Parse an ISO-8601 instant that carries `Z` or an explicit offset. Returns epoch ms. */
export function parseInstant(instant: string): number {
  const m = typeof instant === 'string' ? INSTANT_RE.exec(instant) : null;
  const p = m ? partsFromMatch(m) : null;
  if (!m || !p) {
    throw new ZonedDateTimeError('INVALID_INSTANT', `Invalid instant ${JSON.stringify(instant)}; expected ISO-8601 with Z or an offset.`);
  }
  let offsetMs = 0;
  if (m[9] !== undefined) {
    const oh = Number(m[9]);
    const om = Number(m[10]);
    if (oh > 18 || om > 59) throw new ZonedDateTimeError('INVALID_INSTANT', `Invalid offset in ${JSON.stringify(instant)}.`);
    offsetMs = (oh * 60 + om) * 60_000 * (m[8]!.startsWith('-') ? -1 : 1);
  }
  const ms = wallToEpochMs(p) - offsetMs;
  const year = new Date(ms).getUTCFullYear();
  if (year < 1 || year > 9999) throw new ZonedDateTimeError('INVALID_INSTANT', `Instant ${JSON.stringify(instant)} is out of range (years 0001–9999).`);
  return ms;
}

// ── Conversions ──────────────────────────────────────────────────────────────

function requireZone(tz: unknown): string {
  const canonical = canonicalTimeZone(tz);
  if (!canonical) throw new ZonedDateTimeError('INVALID_TIMEZONE', `Unknown IANA time zone ${JSON.stringify(tz)}.`);
  return canonical;
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

/** Build the stored shape for an instant in a zone. */
export function zonedFromInstant(instant: string | number | Date, tz: string): ZonedDateTime {
  const zone = requireZone(tz);
  const ms =
    typeof instant === 'number' ? instant : instant instanceof Date ? instant.getTime() : parseInstant(instant);
  if (!Number.isFinite(ms)) throw new ZonedDateTimeError('INVALID_INSTANT', 'Invalid instant.');
  return { instant: new Date(ms).toISOString(), tz: zone, offset: formatOffset(offsetSecondsAt(ms, zone)) };
}

/**
 * Wall-clock reading of an instant in `tz`: `YYYY-MM-DDTHH:mm:ss`, plus
 * `.fff` when the instant has milliseconds.
 */
export function instantToLocal(instant: string | number, tz: string): string {
  const zone = requireZone(tz);
  const ms = typeof instant === 'number' ? instant : parseInstant(instant);
  const p = wallPartsAt(ms, zone);
  const base = `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
  return p.millisecond ? `${base}.${pad(p.millisecond, 3)}` : base;
}

/** Every instant whose wall-clock reading in `tz` is `wallMs` (0, 1 or 2 of them). */
function candidates(wallMs: number, tz: string): { instants: number[]; before: number; after: number } {
  const before = offsetSecondsAt(wallMs - 86_400_000, tz);
  const after = offsetSecondsAt(wallMs + 86_400_000, tz);
  const offsets = new Set([before, after, offsetSecondsAt(wallMs, tz)]);
  const instants: number[] = [];
  for (const off of offsets) {
    const candidate = wallMs - off * 1000;
    if (offsetSecondsAt(candidate, tz) === off) instants.push(candidate);
  }
  instants.sort((a, b) => a - b);
  return { instants: [...new Set(instants)], before, after };
}

/**
 * Resolve a local wall time in `tz` to an instant, applying `disambiguation`
 * in a DST gap or overlap (see the module doc for the table).
 */
export function zonedFromLocal(
  local: string,
  tz: string,
  disambiguation: Disambiguation = 'compatible',
): { value: ZonedDateTime; resolution: WallTimeResolution } {
  const zone = requireZone(tz);
  const wallMs = wallToEpochMs(parseLocalDateTime(local));
  const { instants, before, after } = candidates(wallMs, zone);
  let ms: number;
  let resolution: WallTimeResolution;
  if (instants.length === 1) {
    ms = instants[0]!;
    resolution = 'exact';
  } else if (instants.length > 1) {
    resolution = 'overlap';
    if (disambiguation === 'reject') {
      throw new ZonedDateTimeError('AMBIGUOUS_LOCAL_TIME', `${local} occurs twice in ${zone} (DST overlap); send an instant or choose a disambiguation.`);
    }
    ms = disambiguation === 'later' ? instants[instants.length - 1]! : instants[0]!;
  } else {
    resolution = 'gap';
    if (disambiguation === 'reject') {
      throw new ZonedDateTimeError('NONEXISTENT_LOCAL_TIME', `${local} does not exist in ${zone} (DST gap).`);
    }
    // Offset in force before the transition pushes the reading forward by the
    // gap length; the offset after it pulls the reading back by the same amount.
    ms = wallMs - (disambiguation === 'earlier' ? after : before) * 1000;
  }
  return { value: zonedFromInstant(ms, zone), resolution };
}

/**
 * Normalize any accepted input into the stored {@link ZonedDateTime} shape.
 *
 * Accepted inputs:
 * - `{ instant, tz }` — instant with `Z`/offset; `offset` (if sent) is recomputed.
 * - `{ local, tz, disambiguation? }` — wall time in `tz`.
 * - an ISO string with `Z`/offset — zone = `options.defaultTimezone` ?? `UTC`.
 * - an ISO string without offset — wall time in `options.defaultTimezone`
 *   (rejected when no default zone is configured).
 */
export function normalizeZonedDateTime(raw: unknown, options: ZonedDateTimeFieldOptions = {}): ZonedDateTime {
  const fallbackZone = options.defaultTimezone ?? 'UTC';
  const rule = options.disambiguation ?? 'compatible';
  if (typeof raw === 'string') {
    if (INSTANT_RE.test(raw)) return zonedFromInstant(raw, fallbackZone);
    if (!options.defaultTimezone) {
      throw new ZonedDateTimeError('INVALID_VALUE', 'A date-time without an offset needs a "tz" (or the field\'s defaultTimezone option).');
    }
    return zonedFromLocal(raw, fallbackZone, rule).value;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ZonedDateTimeError('INVALID_VALUE', 'Expected { instant, tz } or { local, tz }.');
  }
  const v = raw as Record<string, unknown>;
  const tz = v.tz ?? fallbackZone;
  const hasInstant = v.instant !== undefined && v.instant !== null;
  const hasLocal = v.local !== undefined && v.local !== null;
  if (hasInstant && hasLocal) {
    throw new ZonedDateTimeError('INVALID_VALUE', 'Send either "instant" or "local", not both.');
  }
  if (hasInstant) {
    if (typeof v.instant !== 'string') throw new ZonedDateTimeError('INVALID_INSTANT', '"instant" must be an ISO-8601 string.');
    return zonedFromInstant(v.instant, tz as string);
  }
  if (hasLocal) {
    if (typeof v.local !== 'string') throw new ZonedDateTimeError('INVALID_LOCAL_TIME', '"local" must be a string.');
    const perValue = v.disambiguation;
    if (perValue !== undefined && !DISAMBIGUATIONS.includes(perValue as Disambiguation)) {
      throw new ZonedDateTimeError('INVALID_VALUE', `"disambiguation" must be one of ${DISAMBIGUATIONS.join(', ')}.`);
    }
    return zonedFromLocal(v.local, tz as string, (perValue as Disambiguation | undefined) ?? rule).value;
  }
  throw new ZonedDateTimeError('INVALID_VALUE', 'Expected { instant, tz } or { local, tz }.');
}

/** Validate field options; returns an error message or `null`. */
export function validateZonedDateTimeOptions(type: string, options: unknown): string | null {
  if (!options || typeof options !== 'object') return null;
  const o = options as Record<string, unknown>;
  if (o.timezone === undefined) return null;
  if (typeof o.timezone !== 'boolean') return 'options.timezone must be a boolean.';
  if (!o.timezone) return null;
  if (!ZONED_DATETIME_FIELD_TYPES.includes(type)) {
    return `options.timezone is only supported on ${ZONED_DATETIME_FIELD_TYPES.join(' / ')} fields.`;
  }
  if (o.defaultTimezone !== undefined && !isValidTimeZone(o.defaultTimezone)) {
    return `options.defaultTimezone ${JSON.stringify(o.defaultTimezone)} is not a known IANA time zone.`;
  }
  if (o.disambiguation !== undefined && !DISAMBIGUATIONS.includes(o.disambiguation as Disambiguation)) {
    return `options.disambiguation must be one of ${DISAMBIGUATIONS.join(', ')}.`;
  }
  return null;
}

/** Epoch ms of a stored value — a {@link ZonedDateTime} or a legacy ISO string — or `null`. */
export function zonedInstantMs(value: unknown): number | null {
  const s = isZonedDateTimeValue(value) ? value.instant : typeof value === 'string' ? value : null;
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}
