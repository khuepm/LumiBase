import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  __setSupportedTimeZonesForTest,
  canonicalTimeZone,
  formatOffset,
  instantToLocal,
  isZonedDateTimeField,
  listTimeZones,
  normalizeZonedDateTime,
  offsetSecondsAt,
  validateZonedDateTimeOptions,
  ZonedDateTimeError,
  zonedFromInstant,
  zonedFromLocal,
  type Disambiguation,
} from '@lumibase/contracts/field';
import { UserPreferencesUpdateSchema } from '@lumibase/contracts/schemas';
import { validateItem } from '../validation';
import { buildFieldTypeMap, buildFilter, buildSort, ItemServiceError } from '../item-service';
import { castKindForFieldType, ZONED_DATETIME_FILTER_TYPE } from '../json-filter-cast';
import { assertZonedDateTimeOptions, SchemaServiceError, type CompiledField } from '../schema-service';
import { mapFieldType, ZonedDateTimeType } from '../../graphql/type-mapping';

/**
 * Timezone-aware datetime field (#747): instant + IANA zone storage, DST
 * disambiguation, validation, filter/sort on the instant, GraphQL type.
 */

const dialect = new PgDialect();

function compiled(name: string, type: string, options: Record<string, unknown> = {}, required = false): CompiledField {
  return {
    id: `f_${name}`,
    name,
    type,
    interface: 'datetime',
    display: null,
    label: null,
    note: null,
    defaultValue: null,
    nullable: true,
    unique: false,
    indexed: false,
    searchable: false,
    length: null,
    precision: null,
    scale: null,
    special: [],
    translations: {},
    options,
    displayOptions: {},
    validation: {},
    conditions: [],
    required,
    readonly: false,
    hidden: false,
    encrypted: false,
    classification: 'none',
    versioned: false,
    rawEnabled: false,
    width: 'full',
    group: null,
    sortOrder: 0,
  };
}

const local = (l: string, tz: string, d?: Disambiguation) => zonedFromLocal(l, tz, d);

describe('time zone validation', () => {
  afterEach(() => __setSupportedTimeZonesForTest(undefined));

  it('accepts IANA ids and canonicalizes aliases; rejects offsets and unknown ids', () => {
    expect(canonicalTimeZone('America/New_York')).toBe('America/New_York');
    expect(canonicalTimeZone('UTC')).toBe('UTC');
    expect(canonicalTimeZone('utc')).toBe('UTC');
    expect(canonicalTimeZone('US/Eastern')).toBe('America/New_York');
    expect(canonicalTimeZone('Asia/Kolkata')).toBe('Asia/Kolkata');
    expect(canonicalTimeZone('Etc/GMT+5')).toBe('Etc/GMT+5');
    for (const bad of ['+05:00', 'Mars/Olympus_Mons', '', 'America/New_York; DROP', 42, null]) {
      expect(canonicalTimeZone(bad)).toBeNull();
    }
  });

  it('falls back to the built-in list when Intl.supportedValuesOf is missing', () => {
    __setSupportedTimeZonesForTest(null);
    expect(canonicalTimeZone('Australia/Lord_Howe')).toBe('Australia/Lord_Howe');
    expect(canonicalTimeZone('Europe/London')).toBe('Europe/London');
    // Real zone the runtime knows, but not on the fallback list → rejected.
    expect(canonicalTimeZone('America/Boise')).toBeNull();
    expect(listTimeZones()).toContain('Asia/Tokyo');
    expect(listTimeZones()[0]).toBe('UTC');
  });

  it('validates the user display time zone preference', () => {
    expect(UserPreferencesUpdateSchema.safeParse({ timezone: 'Europe/London' }).success).toBe(true);
    expect(UserPreferencesUpdateSchema.safeParse({ timezone: null }).success).toBe(true);
    expect(UserPreferencesUpdateSchema.safeParse({ timezone: 'Nowhere/Land' }).success).toBe(false);
  });
});

describe('offsets', () => {
  it('formats whole-minute and historic second offsets', () => {
    expect(formatOffset(0)).toBe('+00:00');
    expect(formatOffset(-18000)).toBe('-05:00');
    expect(formatOffset(37800)).toBe('+10:30');
    expect(formatOffset(-17762)).toBe('-04:56:02');
    expect(offsetSecondsAt(Date.parse('2026-07-01T00:00:00Z'), 'Asia/Kolkata')).toBe(19800);
  });
});

describe('DST resolution (wall time → instant)', () => {
  it('America/New_York spring-forward gap 02:00–03:00', () => {
    const c = local('2026-03-08T02:30', 'America/New_York');
    expect(c.resolution).toBe('gap');
    expect(c.value).toEqual({ instant: '2026-03-08T07:30:00.000Z', tz: 'America/New_York', offset: '-04:00' });
    expect(instantToLocal(c.value.instant, 'America/New_York')).toBe('2026-03-08T03:30:00');
    expect(local('2026-03-08T02:30', 'America/New_York', 'earlier').value.instant).toBe('2026-03-08T06:30:00.000Z');
    expect(local('2026-03-08T02:30', 'America/New_York', 'later').value.instant).toBe('2026-03-08T07:30:00.000Z');
    expect(() => local('2026-03-08T02:30', 'America/New_York', 'reject')).toThrow(/does not exist/);
  });

  it('America/New_York fall-back overlap 01:00–02:00', () => {
    const c = local('2026-11-01T01:30', 'America/New_York');
    expect(c.resolution).toBe('overlap');
    expect(c.value).toEqual({ instant: '2026-11-01T05:30:00.000Z', tz: 'America/New_York', offset: '-04:00' });
    expect(local('2026-11-01T01:30', 'America/New_York', 'later').value).toEqual({
      instant: '2026-11-01T06:30:00.000Z',
      tz: 'America/New_York',
      offset: '-05:00',
    });
    try {
      local('2026-11-01T01:30', 'America/New_York', 'reject');
      expect.unreachable();
    } catch (err) {
      expect((err as ZonedDateTimeError).code).toBe('AMBIGUOUS_LOCAL_TIME');
    }
  });

  it('Europe/London gap (01:00–02:00, 29 Mar) and overlap (01:00–02:00, 25 Oct)', () => {
    const gap = local('2026-03-29T01:30', 'Europe/London');
    expect(gap.resolution).toBe('gap');
    expect(gap.value).toMatchObject({ instant: '2026-03-29T01:30:00.000Z', offset: '+01:00' });
    expect(local('2026-03-29T01:30', 'Europe/London', 'earlier').value.instant).toBe('2026-03-29T00:30:00.000Z');
    const overlap = local('2026-10-25T01:30', 'Europe/London');
    expect(overlap.resolution).toBe('overlap');
    expect(overlap.value).toMatchObject({ instant: '2026-10-25T00:30:00.000Z', offset: '+01:00' });
    expect(local('2026-10-25T01:30', 'Europe/London', 'later').value).toMatchObject({
      instant: '2026-10-25T01:30:00.000Z',
      offset: '+00:00',
    });
  });

  it('Australia/Lord_Howe 30-minute DST: gap 02:00–02:30 (4 Oct), overlap 01:30–02:00 (5 Apr)', () => {
    const gap = local('2026-10-04T02:15', 'Australia/Lord_Howe');
    expect(gap.resolution).toBe('gap');
    expect(gap.value).toEqual({ instant: '2026-10-03T15:45:00.000Z', tz: 'Australia/Lord_Howe', offset: '+11:00' });
    expect(instantToLocal(gap.value.instant, 'Australia/Lord_Howe')).toBe('2026-10-04T02:45:00');
    expect(local('2026-10-04T02:15', 'Australia/Lord_Howe', 'earlier').value).toMatchObject({
      instant: '2026-10-03T15:15:00.000Z',
      offset: '+10:30',
    });
    const overlap = local('2026-04-05T01:45', 'Australia/Lord_Howe');
    expect(overlap.resolution).toBe('overlap');
    expect(overlap.value).toMatchObject({ instant: '2026-04-04T14:45:00.000Z', offset: '+11:00' });
    expect(local('2026-04-05T01:45', 'Australia/Lord_Howe', 'later').value).toMatchObject({
      instant: '2026-04-04T15:15:00.000Z',
      offset: '+10:30',
    });
    // 02:00 itself is the first instant after the overlap's end → exact.
    expect(local('2026-10-04T02:30', 'Australia/Lord_Howe').resolution).toBe('exact');
  });

  it('no-DST zones resolve every wall time exactly (Asia/Tokyo, Asia/Kolkata)', () => {
    for (const l of ['2026-03-08T02:30', '2026-11-01T01:30', '2026-03-29T01:30', '2026-10-04T02:15']) {
      expect(local(l, 'Asia/Tokyo').resolution).toBe('exact');
      expect(local(l, 'Asia/Kolkata').resolution).toBe('exact');
    }
    expect(local('2026-06-01T09:00', 'Asia/Tokyo').value).toEqual({
      instant: '2026-06-01T00:00:00.000Z',
      tz: 'Asia/Tokyo',
      offset: '+09:00',
    });
    expect(local('2026-06-01T09:00', 'Asia/Kolkata').value.offset).toBe('+05:30');
  });

  it('rejects malformed local times', () => {
    for (const bad of ['2026-02-30T10:00', '2026-13-01T00:00', '2026-01-01T24:00', '2026-01-01', '0000-01-01T00:00']) {
      expect(() => local(bad, 'UTC')).toThrow(ZonedDateTimeError);
    }
  });
});

const ZONES = ['America/New_York', 'Europe/London', 'Australia/Lord_Howe', 'Asia/Tokyo', 'Asia/Kolkata', 'Pacific/Chatham', 'UTC'];
const MIN = Date.parse('1971-01-01T00:00:00Z');
const MAX = Date.parse('2037-12-31T00:00:00Z');

describe('round-trip properties (fast-check)', () => {
  it('instant → (wall, tz) → instant is the identity, except the later half of an overlap', () => {
    fc.assert(
      fc.property(fc.integer({ min: MIN, max: MAX }), fc.constantFrom(...ZONES), (ms, tz) => {
        const wall = instantToLocal(ms, tz);
        const back = zonedFromLocal(wall, tz);
        expect(back.resolution).not.toBe('gap'); // a real instant's wall time always exists
        if (back.resolution === 'exact') {
          expect(Date.parse(back.value.instant)).toBe(ms);
        } else {
          const earlier = Date.parse(zonedFromLocal(wall, tz, 'earlier').value.instant);
          const later = Date.parse(zonedFromLocal(wall, tz, 'later').value.instant);
          expect([earlier, later]).toContain(ms);
          expect(earlier).toBeLessThan(later);
        }
      }),
      { numRuns: 400 },
    );
  });

  it('(wall, tz) → instant → wall is the identity outside DST gaps', () => {
    const wallArb = fc
      .record({
        y: fc.integer({ min: 1971, max: 2037 }),
        mo: fc.integer({ min: 1, max: 12 }),
        d: fc.integer({ min: 1, max: 28 }),
        h: fc.integer({ min: 0, max: 23 }),
        mi: fc.integer({ min: 0, max: 59 }),
        s: fc.integer({ min: 0, max: 59 }),
      })
      .map(({ y, mo, d, h, mi, s }) => {
        const p = (n: number, w = 2) => String(n).padStart(w, '0');
        return `${p(y, 4)}-${p(mo)}-${p(d)}T${p(h)}:${p(mi)}:${p(s)}`;
      });
    fc.assert(
      fc.property(wallArb, fc.constantFrom(...ZONES), (wall, tz) => {
        const r = zonedFromLocal(wall, tz);
        fc.pre(r.resolution !== 'gap');
        expect(instantToLocal(r.value.instant, tz)).toBe(wall);
        expect(r.value.tz).toBe(tz);
        // Stored offset agrees with the instant: wall = instant + offset.
        expect(offsetSecondsAt(Date.parse(r.value.instant), tz)).toBe(
          (Date.parse(`${wall}Z`) - Date.parse(r.value.instant)) / 1000,
        );
      }),
      { numRuns: 400 },
    );
  });

  it('normalizing a stored value again is a no-op (idempotent writes)', () => {
    fc.assert(
      fc.property(fc.integer({ min: MIN, max: MAX }), fc.constantFrom(...ZONES), (ms, tz) => {
        const once = zonedFromInstant(ms, tz);
        expect(normalizeZonedDateTime(once)).toEqual(once);
      }),
      { numRuns: 200 },
    );
  });
});

describe('normalizeZonedDateTime inputs', () => {
  it('accepts { instant, tz } with any offset and recomputes the offset', () => {
    expect(
      normalizeZonedDateTime({ instant: '2026-07-01T10:00:00+02:00', tz: 'Europe/London', offset: '+09:00' }),
    ).toEqual({ instant: '2026-07-01T08:00:00.000Z', tz: 'Europe/London', offset: '+01:00' });
  });

  it('accepts { local, tz } with a per-value disambiguation', () => {
    expect(
      normalizeZonedDateTime({ local: '2026-11-01T01:30', tz: 'America/New_York', disambiguation: 'later' }).instant,
    ).toBe('2026-11-01T06:30:00.000Z');
  });

  it('accepts bare ISO strings using defaultTimezone (UTC when unset)', () => {
    expect(normalizeZonedDateTime('2026-01-01T00:00:00Z')).toEqual({
      instant: '2026-01-01T00:00:00.000Z',
      tz: 'UTC',
      offset: '+00:00',
    });
    expect(normalizeZonedDateTime('2026-01-01T09:00', { defaultTimezone: 'Asia/Tokyo' }).instant).toBe(
      '2026-01-01T00:00:00.000Z',
    );
    expect(() => normalizeZonedDateTime('2026-01-01T09:00')).toThrow(/needs a "tz"/);
  });

  it('rejects bad shapes and unknown zones', () => {
    expect(() => normalizeZonedDateTime({ instant: '2026-01-01T00:00:00Z', local: '2026-01-01T00:00', tz: 'UTC' })).toThrow(/not both/);
    expect(() => normalizeZonedDateTime({ instant: '2026-01-01T00:00:00', tz: 'UTC' })).toThrow(/offset/);
    expect(() => normalizeZonedDateTime({ instant: '2026-01-01T00:00:00Z', tz: 'Nowhere/Land' })).toThrow(/Unknown IANA/);
    expect(() => normalizeZonedDateTime(12345)).toThrow(ZonedDateTimeError);
    expect(() => normalizeZonedDateTime({ local: '2026-01-01T00:00', tz: 'UTC', disambiguation: 'nope' })).toThrow(/disambiguation/);
  });
});

describe('field options', () => {
  it('detects opt-in fields only', () => {
    expect(isZonedDateTimeField({ type: 'datetime', options: { timezone: true } })).toBe(true);
    expect(isZonedDateTimeField({ type: 'timestamp', options: { timezone: true } })).toBe(true);
    expect(isZonedDateTimeField({ type: 'datetime', options: {} })).toBe(false);
    expect(isZonedDateTimeField({ type: 'datetime', options: { timezone: 'yes' } })).toBe(false);
    expect(isZonedDateTimeField({ type: 'date', options: { timezone: true } })).toBe(false);
  });

  it('schema-service rejects malformed options with INVALID_FIELD_OPTIONS', () => {
    expect(validateZonedDateTimeOptions('datetime', { timezone: true, defaultTimezone: 'Asia/Tokyo' })).toBeNull();
    expect(validateZonedDateTimeOptions('string', { timezone: false })).toBeNull();
    for (const [type, options] of [
      ['string', { timezone: true }],
      ['datetime', { timezone: 'true' }],
      ['datetime', { timezone: true, defaultTimezone: 'Nowhere/Land' }],
      ['datetime', { timezone: true, disambiguation: 'closest' }],
    ] as const) {
      try {
        assertZonedDateTimeOptions(type, options);
        expect.unreachable(`${type} ${JSON.stringify(options)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(SchemaServiceError);
        expect((err as SchemaServiceError).code).toBe('INVALID_FIELD_OPTIONS');
      }
    }
  });
});

describe('item validation', () => {
  const zoned = compiled('starts_at', 'datetime', { timezone: true });
  const plain = compiled('legacy_at', 'datetime');

  it('round-trips the zone through validation (stored shape)', () => {
    const r = validateItem([zoned], { starts_at: { local: '2026-07-04T09:00', tz: 'America/New_York' } });
    expect(r).toEqual({
      ok: true,
      data: { starts_at: { instant: '2026-07-04T13:00:00.000Z', tz: 'America/New_York', offset: '-04:00' } },
    });
    // Feeding the stored value back keeps it byte-identical.
    const again = validateItem([zoned], r.ok ? r.data : {});
    expect(again).toEqual(r);
  });

  it('applies the field-level disambiguation and defaultTimezone', () => {
    const strict = compiled('t', 'datetime', { timezone: true, disambiguation: 'reject', defaultTimezone: 'Europe/London' });
    const gap = validateItem([strict], { t: '2026-03-29T01:30' });
    expect(gap.ok).toBe(false);
    if (!gap.ok) expect(gap.issues[0]).toMatchObject({ field: 't', message: expect.stringMatching(/NONEXISTENT_LOCAL_TIME/) });
    const ok = validateItem([strict], { t: '2026-06-01T12:00' });
    expect(ok.ok && ok.data.t).toEqual({ instant: '2026-06-01T11:00:00.000Z', tz: 'Europe/London', offset: '+01:00' });
  });

  it('honours required / nullable / partial', () => {
    const req = compiled('t', 'datetime', { timezone: true }, true);
    expect(validateItem([req], {}).ok).toBe(false);
    expect(validateItem([req], { t: null }).ok).toBe(false);
    expect(validateItem([zoned], { starts_at: null })).toEqual({ ok: true, data: { starts_at: null } });
    expect(validateItem([zoned], {})).toEqual({ ok: true, data: {} });
    expect(validateItem([req], { other: 1 }, { partial: true }).ok).toBe(true);
  });

  it('leaves fields without the option unchanged (bare string, no normalization)', () => {
    expect(validateItem([plain], { legacy_at: '2026-07-04 09:00' })).toEqual({
      ok: true,
      data: { legacy_at: '2026-07-04 09:00' },
    });
    expect(validateItem([plain], { legacy_at: { instant: 'x', tz: 'UTC' } }).ok).toBe(false);
  });
});

describe('filter + sort operate on the instant', () => {
  const types = buildFieldTypeMap([
    { name: 'starts_at', type: 'datetime', options: { timezone: true } },
    { name: 'legacy_at', type: 'datetime', options: {} },
  ]);

  it('maps the zoned field to the timestamp Cast_Rule', () => {
    expect(types.get('starts_at')).toBe(ZONED_DATETIME_FILTER_TYPE);
    expect(types.get('legacy_at')).toBe('datetime');
    expect(castKindForFieldType(ZONED_DATETIME_FILTER_TYPE)).toBe('timestamp');
  });

  it('compares the instant path (with legacy-string fallback) as timestamptz', () => {
    const q = dialect.sqlToQuery(buildFilter({ starts_at: { _gte: '2026-03-08T07:00:00Z' } } as never, types)!);
    expect(q.sql).toContain('coalesce("lumibase_items"."data"#>>$1::text[], "lumibase_items"."data"->>$2)');
    expect(q.sql).toContain('::timestamptz');
    expect(q.params).toContain('{starts_at,instant}');
    expect(q.params).toContain('2026-03-08T07:00:00.000Z');
  });

  it('accepts zoned filter values and compares their instant', () => {
    const q = dialect.sqlToQuery(
      buildFilter({ starts_at: { _lt: { local: '2026-03-08T03:00', tz: 'America/New_York' } } } as never, types)!,
    );
    expect(q.params).toContain('2026-03-08T07:00:00.000Z');
    const many = dialect.sqlToQuery(
      buildFilter({ starts_at: { _in: [{ instant: '2026-01-01T09:00:00+09:00', tz: 'Asia/Tokyo' }, '2026-02-01T00:00:00Z'] } } as never, types)!,
    );
    expect(many.params).toEqual(expect.arrayContaining(['2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z']));
    expect(() => buildFilter({ starts_at: { _eq: { local: 'nope', tz: 'UTC' } } } as never, types)).toThrow(ItemServiceError);
  });

  it('sorts on the casted instant; legacy fields keep their expression', () => {
    const [zonedSort] = buildSort(['-starts_at'], types);
    const z = dialect.sqlToQuery(zonedSort!);
    expect(z.sql).toContain('#>>');
    expect(z.sql).toContain('::timestamptz');
    expect(z.sql).toMatch(/desc$/);
    const [legacySort] = buildSort(['legacy_at'], types);
    const l = dialect.sqlToQuery(legacySort!);
    expect(l.sql).not.toContain('#>>');
    expect(l.sql).toContain('::timestamptz');
  });

  it('string operators on a zoned field search the instant text', () => {
    const q = dialect.sqlToQuery(buildFilter({ starts_at: { _starts_with: '2026-03' } } as never, types)!);
    expect(q.sql).toContain('coalesce(');
    expect(q.sql).toContain('ilike');
  });
});

describe('GraphQL', () => {
  it('types a zoned field as ZonedDateTime and resolves legacy strings', () => {
    expect(mapFieldType(compiled('t', 'datetime', { timezone: true }))).toBe(ZonedDateTimeType);
    expect(mapFieldType(compiled('t', 'datetime'))).not.toBe(ZonedDateTimeType);
    const f = ZonedDateTimeType.getFields();
    const info = {} as never;
    const value = { instant: '2026-01-01T00:00:00.000Z', tz: 'Asia/Tokyo', offset: '+09:00' };
    expect(f.instant!.resolve!(value, {}, {}, info)).toBe(value.instant);
    expect(f.tz!.resolve!(value, {}, {}, info)).toBe('Asia/Tokyo');
    expect(f.offset!.resolve!(value, {}, {}, info)).toBe('+09:00');
    expect(f.instant!.resolve!('2026-01-01T00:00:00Z', {}, {}, info)).toBe('2026-01-01T00:00:00Z');
    expect(f.tz!.resolve!('2026-01-01T00:00:00Z', {}, {}, info)).toBeNull();
  });
});
