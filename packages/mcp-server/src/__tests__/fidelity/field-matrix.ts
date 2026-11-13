import type { FieldType } from '@lumibase/contracts/field';

/**
 * Field-type matrix for the tool-schema fidelity suite (#716).
 *
 * LumiBase's item tools take `data` as an open record on both transports —
 * no per-collection input schema is generated from field definitions — so the
 * schema itself does not vary by field type. What does vary is the VALUE an
 * agent puts in `data`, and that is where generated MCP schemas break in other
 * CMSs: a nullable relation advertised without `{type:"null"}` (Payload #16214),
 * an array-valued field advertised as an object (Directus #27039). The matrix
 * below builds a realistic value for every storage type × relation/file kind ×
 * nullable × localized × repeatable, and the suite proves each one is accepted
 * by the advertised schema AND by the server-side validation, unchanged.
 */

/** Every storage type in `FieldType` — the compile-time check below keeps this exhaustive. */
export const FIELD_TYPES = [
  'string',
  'text',
  'integer',
  'bigInteger',
  'decimal',
  'boolean',
  'json',
  'uuid',
  'date',
  'datetime',
  'time',
  'timestamp',
  'csv',
  'hash',
  'geometry',
  'alias',
] as const satisfies readonly FieldType[];

// Adding a member to `FieldType` without covering it here fails `pnpm typecheck`.
type MissingFieldType = Exclude<FieldType, (typeof FIELD_TYPES)[number]>;
export const FIELD_TYPES_EXHAUSTIVE: [MissingFieldType] extends [never] ? true : never = true;

/** A representative stored value for each storage type. */
const SCALAR: Record<(typeof FIELD_TYPES)[number], unknown> = {
  string: 'Hello',
  text: 'A longer body of text.\nWith a second line.',
  integer: 42,
  // Beyond 2^53: stays a string on the wire, as the GraphQL mapping does.
  bigInteger: '9007199254740993',
  decimal: 19.99,
  boolean: false,
  json: { nested: { list: [1, 'two', null] } },
  uuid: '0190a2b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b',
  date: '2026-01-01',
  datetime: '2026-01-01T09:30:00.000Z',
  time: '09:30:00',
  timestamp: '2026-01-01T09:30:00.000Z',
  csv: 'red,green,blue',
  hash: '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA',
  geometry: { type: 'Point', coordinates: [105.85, 21.03] },
  // Alias fields hold no column; an o2m alias is written as the related ids.
  alias: ['comment_1', 'comment_2'],
};

/** Relation and file kinds — the interfaces that store references, not scalars. */
const REFERENCE: Record<string, unknown> = {
  m2o: 'author_1',
  o2m: ['comment_1', 'comment_2'],
  m2m: [{ tags_id: 'tag_1' }, { tags_id: 'tag_2' }],
  m2a: [
    { collection: 'posts', item: 'post_1' },
    { collection: 'pages', item: 'page_1' },
  ],
  file: 'file_0190a2b4',
  image: 'file_0190a2b5',
  files: ['file_0190a2b4', 'file_0190a2b5'],
};

export interface MatrixCase {
  /** Human-readable id, e.g. `m2o · nullable · localized`. */
  label: string;
  /** Field name used in the item payload. */
  field: string;
  kind: string;
  nullable: boolean;
  localized: boolean;
  repeatable: boolean;
  value: unknown;
}

const LOCALES = ['en', 'vi'] as const;

/**
 * The full cross product. `nullable` means the value sent is `null` (the case
 * that breaks generators), `localized` wraps the value in a locale-keyed object
 * (the shape `repairTranslation` and the translations interface write), and
 * `repeatable` wraps it in an array (repeater / list interfaces).
 */
export function matrix(): MatrixCase[] {
  const kinds: Array<[string, unknown]> = [
    ...FIELD_TYPES.map((t) => [t, SCALAR[t]] as [string, unknown]),
    ...Object.entries(REFERENCE),
  ];
  const out: MatrixCase[] = [];
  for (const [kind, base] of kinds) {
    for (const nullable of [false, true]) {
      for (const localized of [false, true]) {
        for (const repeatable of [false, true]) {
          let value: unknown = nullable ? null : base;
          if (repeatable) value = nullable ? [null, base] : [base, base];
          if (localized) value = Object.fromEntries(LOCALES.map((l) => [l, value]));
          const label = [kind, nullable && 'nullable', localized && 'localized', repeatable && 'repeatable']
            .filter(Boolean)
            .join(' · ');
          out.push({
            label,
            field: `f_${kind.toLowerCase()}`,
            kind,
            nullable,
            localized,
            repeatable,
            value,
          });
        }
      }
    }
  }
  return out;
}
