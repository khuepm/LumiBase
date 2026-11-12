/**
 * Collection export (#727, epic #673 I02): locale-aware CSV / JSON with field
 * selection, relation modes and a per-row extension hook, streamed page by
 * page so a large collection never sits in memory.
 *
 * The file format is also the import format: `parseExport` turns an export back
 * into item payloads, and an export → parse → create → export round-trip is
 * lossless (translations included). Background import jobs (#726) build on it.
 *
 * Layout:
 *   - `planExport`      pure: schema + options → column plan
 *   - `toCsvRow` etc.   pure encoders (RFC 4180 + formula-injection guard)
 *   - `streamExport`    drives paging through `ItemService.list` and encodes
 *   - `parseExport`     pure decoder for both formats
 */
import type { CompiledField } from './schema-service';
import type { DeepQuery, ItemFilter, ItemRow, ListItemsParams } from './item-service';

export type ExportFormat = 'csv' | 'json';
/** `id` keeps the stored foreign key; `slug` swaps it for the related slug; `embed` adds the related record. */
export type RelationMode = 'id' | 'slug' | 'embed';

/** Interface id that marks a field as a per-locale map (`{ en: 'Hi', vi: 'Chào' }`). */
export const TRANSLATABLE_INTERFACE = 'translatable-text';

/** Structural columns written first, in this order, for every row. */
export const EXPORT_STRUCTURAL_COLUMNS = ['id', 'status', 'sort', 'created_at', 'updated_at'] as const;

/** Page size used to stream through `ItemService.list` (its own cap is 200). */
export const EXPORT_PAGE_SIZE = 200;

export interface ExportRecord {
  id: string;
  status: string;
  sort: number;
  created_at: string | null;
  updated_at: string | null;
  data: Record<string, unknown>;
}

export interface ExportRelation {
  type: 'm2o' | 'o2m' | 'm2m';
  /** Key in `data` that stores the foreign id (m2o) — the relation's `manyField`. */
  field: string;
  /** Key the expanded record is written under (`relationAlias`). */
  alias: string;
  /** Related collection (m2o: `oneCollection`). */
  related: string;
}

export interface ExportOptions {
  format: ExportFormat;
  /** Data fields to include, in order. Omitted → every non-alias schema field. */
  fields?: string[];
  /** Locales for translatable fields. Omitted → JSON keeps every locale; CSV uses `siteLocales`. */
  locales?: string[];
  relations?: RelationMode;
  filter?: ItemFilter;
  sort?: string[];
  status?: string;
}

export interface ExportColumn {
  /** Header text (`title`, `title.vi`, `author`). */
  header: string;
  /** Data key the value is read from. */
  field: string;
  /** Set for one column of a translatable field. */
  locale?: string;
}

export interface ExportPlan {
  collection: string;
  format: ExportFormat;
  relations: RelationMode;
  /** Data fields in output order. */
  fields: string[];
  translatable: Set<string>;
  /** Locales to keep for translatable fields; `null` = keep all (JSON only). */
  locales: string[] | null;
  /** CSV data columns (after the structural ones). */
  columns: ExportColumn[];
  /** Relations to expand for `slug` / `embed`. */
  expand: ExportRelation[];
  deep: DeepQuery | undefined;
}

export class ExportError extends Error {
  constructor(
    public readonly code: 'VALIDATION' | 'UNKNOWN_FIELD',
    message: string,
  ) {
    super(message);
    this.name = 'ExportError';
  }
}

const LOCALE_RE = /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/;

/** Fields with no stored value of their own (presentation / o2m / m2m aliases). */
function isStoredField(f: CompiledField): boolean {
  return f.type !== 'alias';
}

/**
 * Build the column plan. Throws `ExportError` for a field that is not in the
 * schema or a malformed locale, so the route can answer 400 before streaming.
 */
export function planExport(input: {
  collection: string;
  schemaFields: Pick<CompiledField, 'name' | 'type' | 'interface' | 'hidden'>[];
  relations: ExportRelation[];
  siteLocales: string[];
  options: ExportOptions;
}): ExportPlan {
  const { collection, schemaFields, relations, siteLocales, options } = input;
  const stored = schemaFields.filter((f) => isStoredField(f as CompiledField));
  const byName = new Map(stored.map((f) => [f.name, f]));

  let fields: string[];
  if (options.fields?.length) {
    fields = [];
    for (const name of options.fields) {
      if ((EXPORT_STRUCTURAL_COLUMNS as readonly string[]).includes(name)) continue; // always written
      if (!byName.has(name)) throw new ExportError('UNKNOWN_FIELD', `Field "${name}" is not in collection "${collection}".`);
      if (!fields.includes(name)) fields.push(name);
    }
  } else {
    fields = stored.map((f) => f.name);
  }

  for (const l of options.locales ?? []) {
    if (!LOCALE_RE.test(l)) throw new ExportError('VALIDATION', `Invalid locale "${l}".`);
  }

  const translatable = new Set(
    fields.filter((name) => byName.get(name)?.interface === TRANSLATABLE_INTERFACE),
  );
  const csvLocales = options.locales?.length ? options.locales : siteLocales.length ? siteLocales : ['en'];
  const locales = options.locales?.length ? options.locales : options.format === 'csv' ? csvLocales : null;

  const mode = options.relations ?? 'id';
  const expand =
    mode === 'id'
      ? []
      : relations.filter((r) => (mode === 'slug' ? r.type === 'm2o' && fields.includes(r.field) : true));

  const columns: ExportColumn[] = [];
  for (const name of fields) {
    if (translatable.has(name)) {
      for (const locale of locales ?? csvLocales) columns.push({ header: `${name}.${locale}`, field: name, locale });
    } else {
      columns.push({ header: name, field: name });
    }
  }
  if (mode === 'embed') {
    for (const r of expand) {
      if (!fields.includes(r.alias)) columns.push({ header: r.alias, field: r.alias });
    }
  }

  const deep: DeepQuery | undefined = expand.length
    ? Object.fromEntries(expand.map((r) => [r.alias, { fields: mode === 'slug' ? ['id', 'slug'] : ['*'] }]))
    : undefined;

  return {
    collection,
    format: options.format,
    relations: mode,
    fields,
    translatable,
    locales,
    columns,
    expand,
    deep,
  };
}

/** Convert one listed row into the export record the plan describes. */
export function shapeRecord(row: ItemRow, plan: ExportPlan): ExportRecord {
  const src = row.data ?? {};
  const data: Record<string, unknown> = {};
  for (const name of plan.fields) {
    let value = src[name];
    if (plan.translatable.has(name) && plan.locales && isPlainObject(value)) {
      const map = value as Record<string, unknown>;
      value = Object.fromEntries(plan.locales.filter((l) => l in map).map((l) => [l, map[l]]));
    }
    data[name] = value === undefined ? null : value;
  }
  for (const rel of plan.expand) {
    const expanded = src[rel.alias];
    if (plan.relations === 'slug') {
      // Swap the stored id for the related slug when the related record has one.
      const slug = isPlainObject(expanded) ? (expanded as Record<string, unknown>).slug : undefined;
      if (typeof slug === 'string' && slug) data[rel.field] = slug;
    } else if (plan.relations === 'embed') {
      data[rel.alias] = expanded === undefined ? null : expanded;
    }
  }
  return {
    id: row.id,
    status: row.status,
    sort: row.sort,
    created_at: toIso(row.createdAt),
    updated_at: toIso(row.updatedAt),
    data,
  };
}

function toIso(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  return null;
}

function isPlainObject(v: unknown): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ── CSV encoding ────────────────────────────────────────────────────────────

/**
 * Leading characters that make spreadsheet apps evaluate a cell as a formula
 * (CSV injection). A string starting with one of these — or with the escape
 * quote itself, so the rule stays reversible — is written with a leading `'`.
 */
const FORMULA_LEAD = /^[=+\-@\t\r']/;

/** Encode one value as cell text. `null`/`undefined` → empty cell. */
export function encodeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return FORMULA_LEAD.test(value) ? `'${value}` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** RFC 4180 quoting. */
export function quoteCsv(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Encode + quote one cell. An empty string is written as `""` so it survives
 * the round-trip distinct from `null` (an unquoted empty cell).
 */
function csvCell(value: unknown): string {
  return value === '' ? '""' : quoteCsv(encodeCell(value));
}

export function csvHeader(plan: ExportPlan): string {
  return [...EXPORT_STRUCTURAL_COLUMNS, ...plan.columns.map((c) => c.header)].map(quoteCsv).join(',') + '\r\n';
}

export function toCsvRow(record: ExportRecord, plan: ExportPlan): string {
  const cells: string[] = [
    record.id,
    record.status,
    String(record.sort),
    record.created_at,
    record.updated_at,
  ].map((v) => csvCell(v));
  for (const col of plan.columns) {
    const raw = record.data[col.field];
    const value = col.locale !== undefined ? (isPlainObject(raw) ? (raw as Record<string, unknown>)[col.locale] : null) : raw;
    cells.push(csvCell(value));
  }
  return cells.join(',') + '\r\n';
}

// ── Streaming driver ────────────────────────────────────────────────────────

export interface ExportSource {
  /** One page of rows, already permission-scoped (wraps `ItemService.list`). */
  list(params: ListItemsParams): Promise<ItemRow[]>;
  /** Optional per-row transform (extension hook `items.export.before`). */
  transform?(record: ExportRecord): Promise<ExportRecord>;
}

/**
 * Walk every matching row. With no custom sort, pages by keyset on `id`
 * (`id > last`), which stays O(n) and is stable while rows are written. A
 * custom sort falls back to offset paging with `id` as the tie-breaker.
 */
export async function* iterateExport(
  plan: ExportPlan,
  options: ExportOptions,
  source: ExportSource,
): AsyncGenerator<ExportRecord> {
  const keyset = !options.sort?.length;
  const sort = keyset ? ['id'] : [...options.sort!, 'id'];
  let lastId: string | null = null;
  let offset = 0;
  for (;;) {
    const filter: ItemFilter | undefined = keyset && lastId !== null
      ? { _and: [...(options.filter ? [options.filter] : []), { id: { _gt: lastId } }] }
      : options.filter;
    const rows = await source.list({
      filter,
      sort,
      limit: EXPORT_PAGE_SIZE,
      offset: keyset ? 0 : offset,
      status: options.status,
      deep: plan.deep,
      withTotal: false,
    });
    for (const row of rows) {
      const record = shapeRecord(row, plan);
      yield source.transform ? await source.transform(record) : record;
    }
    if (rows.length < EXPORT_PAGE_SIZE) return;
    lastId = rows[rows.length - 1]!.id;
    offset += rows.length;
  }
}

/**
 * Stream the export as UTF-8 bytes. CSV starts with a BOM so spreadsheet apps
 * read Vietnamese and other non-ASCII text correctly. JSON is a single object
 * `{ collection, format, exportedAt, fields, locales, relations, items: [...] }`.
 */
export function streamExport(
  plan: ExportPlan,
  options: ExportOptions,
  source: ExportSource,
  now: () => Date = () => new Date(),
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iter = iterateExport(plan, options, source);
  let started = false;
  let first = true;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!started) {
          started = true;
          if (plan.format === 'csv') {
            controller.enqueue(encoder.encode('﻿' + csvHeader(plan)));
          } else {
            const head = {
              collection: plan.collection,
              format: 'lumibase-export@1',
              exportedAt: now().toISOString(),
              fields: plan.fields,
              locales: plan.locales,
              relations: plan.relations,
            };
            controller.enqueue(encoder.encode(JSON.stringify(head).slice(0, -1) + ',"items":['));
          }
          return;
        }
        const next = await iter.next();
        if (next.done) {
          if (plan.format === 'json') controller.enqueue(encoder.encode(']}'));
          controller.close();
          return;
        }
        const chunk =
          plan.format === 'csv'
            ? toCsvRow(next.value, plan)
            : (first ? '' : ',') + JSON.stringify(next.value);
        first = false;
        controller.enqueue(encoder.encode(chunk));
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel() {
      await iter.return(undefined);
    },
  });
}

// ── Decoding (import side) ──────────────────────────────────────────────────

/** Item payload an import writes back (`ItemService.create` shape + id). */
export interface ImportRecord {
  id?: string;
  status?: string;
  sort?: number;
  data: Record<string, unknown>;
}

/**
 * RFC 4180 parser: handles quoted cells, escaped quotes and embedded newlines.
 * An unquoted empty cell is `null`; a quoted empty cell (`""`) is `''`.
 */
export function parseCsv(text: string): (string | null)[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: (string | null)[][] = [];
  let row: (string | null)[] = [];
  let cell = '';
  let quoted = false;
  let wasQuoted = false;
  const take = () => {
    row.push(cell === '' && !wasQuoted ? null : cell);
    cell = '';
    wasQuoted = false;
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === '' && !wasQuoted) {
      quoted = true;
      wasQuoted = true;
    } else if (ch === ',') {
      take();
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      take();
      rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (quoted) throw new ExportError('VALIDATION', 'Unterminated quoted CSV cell.');
  if (cell !== '' || wasQuoted || row.length) {
    take();
    rows.push(row);
  }
  return rows;
}

const NUMERIC_TYPES = new Set(['integer', 'biginteger', 'decimal', 'float']);

/** Undo the formula-injection escape added by `encodeCell`. */
function unescapeText(text: string): string {
  return text.startsWith("'") && FORMULA_LEAD.test(text.slice(1)) ? text.slice(1) : text;
}

/** Reverse `encodeCell` for a field of `type`. Unquoted empty cell (`null`) → `null`. */
export function decodeCell(text: string | null, type: string | undefined): unknown {
  if (text === null) return null;
  if (text === '') return '';
  const t = (type ?? 'string').toLowerCase();
  if (NUMERIC_TYPES.has(t)) {
    const n = Number(text);
    return Number.isFinite(n) ? n : unescapeText(text);
  }
  if (t === 'boolean') return text === 'true' ? true : text === 'false' ? false : unescapeText(text);
  if (t === 'json' || t === 'csv' || t === 'geometry') {
    try {
      return JSON.parse(text);
    } catch {
      return unescapeText(text);
    }
  }
  return unescapeText(text);
}

/**
 * Parse an export file back into item payloads. `schemaFields` supplies the
 * types CSV needs to restore numbers, booleans and JSON. Columns for fields not
 * in the schema are rejected rather than silently dropped.
 */
export function parseExport(
  body: string,
  format: ExportFormat,
  schemaFields: Pick<CompiledField, 'name' | 'type' | 'interface'>[],
): ImportRecord[] {
  const byName = new Map(schemaFields.map((f) => [f.name, f]));
  if (format === 'json') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new ExportError('VALIDATION', 'Body is not valid JSON.');
    }
    const list = Array.isArray(parsed) ? parsed : (parsed as { items?: unknown })?.items;
    if (!Array.isArray(list)) throw new ExportError('VALIDATION', 'Expected an `items` array.');
    return list.map((raw, i) => {
      if (!isPlainObject(raw) || !isPlainObject((raw as { data?: unknown }).data)) {
        throw new ExportError('VALIDATION', `Item ${i} has no \`data\` object.`);
      }
      const r = raw as Partial<ExportRecord>;
      return {
        ...(typeof r.id === 'string' ? { id: r.id } : {}),
        ...(typeof r.status === 'string' ? { status: r.status } : {}),
        ...(typeof r.sort === 'number' ? { sort: r.sort } : {}),
        data: { ...(r.data as Record<string, unknown>) },
      };
    });
  }

  const [rawHeader, ...rows] = parseCsv(body);
  if (!rawHeader?.length) throw new ExportError('VALIDATION', 'CSV has no header row.');
  const header = rawHeader.map((h) => h ?? '');
  const cols = header.map((h) => {
    if ((EXPORT_STRUCTURAL_COLUMNS as readonly string[]).includes(h)) return { kind: 'structural' as const, name: h };
    const dot = h.indexOf('.');
    const base = dot > 0 ? h.slice(0, dot) : h;
    const field = byName.get(base);
    if (dot > 0 && field?.interface === TRANSLATABLE_INTERFACE) {
      return { kind: 'locale' as const, name: base, locale: h.slice(dot + 1) };
    }
    if (!byName.has(h)) throw new ExportError('UNKNOWN_FIELD', `Column "${h}" is not a field of this collection.`);
    return { kind: 'field' as const, name: h, type: byName.get(h)!.type };
  });
  return rows
    .filter((cells) => cells.some((c) => c !== null))
    .map((cells) => {
      const rec: ImportRecord = { data: {} };
      cols.forEach((col, i) => {
        const text = cells[i] ?? null;
        if (col.kind === 'structural') {
          if (col.name === 'id' && text) rec.id = text;
          else if (col.name === 'status' && text) rec.status = text;
          else if (col.name === 'sort' && text) rec.sort = Number(text);
        } else if (col.kind === 'locale') {
          if (text === null) {
            if (!(col.name in rec.data)) rec.data[col.name] = null;
            return;
          }
          const prev = rec.data[col.name];
          const map = (isPlainObject(prev) ? prev : {}) as Record<string, unknown>;
          map[col.locale] = decodeCell(text, 'string');
          rec.data[col.name] = map;
        } else {
          rec.data[col.name] = decodeCell(text, col.type);
        }
      });
      return rec;
    });
}
