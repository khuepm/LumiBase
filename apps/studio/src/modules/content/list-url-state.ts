import type { FilterCondition } from './filter-builder';

/**
 * Collection list view state carried in the URL (#694), so leaving for an
 * item and coming back with the browser's Back button lands on the same page,
 * sort and filters instead of a reset list.
 *
 * Search keys (all optional; absent = default):
 *   `page`     0-based page index, omitted for page 0
 *   `sort`     `field` (asc) or `-field` (desc)
 *   `f`        filter conditions `[{ field, op, value }]`
 *   `modified` `true` = "Modified since publish" toggle on
 */
export interface ListViewState {
  page: number;
  sort: { field: string; dir: 'asc' | 'desc' };
  filters: FilterCondition[];
  modifiedOnly: boolean;
}

export interface ListSearch {
  page?: number;
  sort?: string;
  f?: FilterCondition[];
  modified?: boolean;
}

const FIELD = /^[A-Za-z0-9_.]{1,128}$/;
const OP = /^_[a-z_]{1,32}$/;
const MAX_FILTERS = 50;

function isCondition(v: unknown): v is FilterCondition {
  if (!v || typeof v !== 'object') return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.field === 'string' && FIELD.test(c.field) &&
    typeof c.op === 'string' && OP.test(c.op) &&
    (typeof c.value === 'string' || typeof c.value === 'number' || typeof c.value === 'boolean')
  );
}

/**
 * Read the list state from a (loosely typed) URL search object. Anything
 * malformed is ignored rather than trusted: the URL is user-editable.
 * Returns only the keys that were present and valid.
 */
export function readListSearch(search: unknown): Partial<ListViewState> {
  if (!search || typeof search !== 'object') return {};
  const s = search as Record<string, unknown>;
  const out: Partial<ListViewState> = {};
  const page = typeof s.page === 'number' ? s.page : typeof s.page === 'string' ? Number(s.page) : NaN;
  if (Number.isInteger(page) && page >= 0 && page < 100_000) out.page = page;
  if (typeof s.sort === 'string' && s.sort.length > 0) {
    const desc = s.sort.startsWith('-');
    const field = desc ? s.sort.slice(1) : s.sort;
    if (FIELD.test(field)) out.sort = { field, dir: desc ? 'desc' : 'asc' };
  }
  if (Array.isArray(s.f)) {
    out.filters = s.f.filter(isCondition).slice(0, MAX_FILTERS).map((c) => ({ ...c, value: String(c.value) }));
  }
  if (s.modified === true || s.modified === 'true') out.modifiedOnly = true;
  return out;
}

/** Whether the URL carries any list state (then it wins over saved presets). */
export function hasListSearch(search: unknown): boolean {
  return Object.keys(readListSearch(search)).length > 0;
}

/**
 * Search object for a list state. Defaults are omitted so a plain list URL
 * stays clean; `defaultSort` is the sort that needs no `sort` key.
 */
export function writeListSearch(
  state: ListViewState,
  defaultSort: ListViewState['sort'] = { field: 'updated_at', dir: 'desc' },
): ListSearch {
  const out: ListSearch = {};
  if (state.page > 0) out.page = state.page;
  if (state.sort.field !== defaultSort.field || state.sort.dir !== defaultSort.dir) {
    out.sort = `${state.sort.dir === 'desc' ? '-' : ''}${state.sort.field}`;
  }
  if (state.filters.length > 0) out.f = state.filters;
  if (state.modifiedOnly) out.modified = true;
  return out;
}

const LAST_LIST_KEY = (collection: string) => `lumibase:list-view:${collection}`;

/**
 * Remember a collection's last list search for this tab, so the breadcrumb and
 * the back arrow in the item editor return to the same page and filters even
 * when the user arrived at the item some other way than Back. Best effort:
 * storage can be unavailable (private mode, quota).
 */
export function rememberListSearch(collection: string, search: ListSearch): void {
  try {
    if (Object.keys(search).length === 0) sessionStorage.removeItem(LAST_LIST_KEY(collection));
    else sessionStorage.setItem(LAST_LIST_KEY(collection), JSON.stringify(search));
  } catch {
    /* storage unavailable — the plain list URL still works */
  }
}

/** The last remembered list search of a collection (validated), or `{}`. */
export function lastListSearch(collection: string): ListSearch {
  try {
    const raw = sessionStorage.getItem(LAST_LIST_KEY(collection));
    if (!raw) return {};
    const state = readListSearch(JSON.parse(raw));
    return writeListSearch({
      page: state.page ?? 0,
      sort: state.sort ?? { field: 'updated_at', dir: 'desc' },
      filters: state.filters ?? [],
      modifiedOnly: state.modifiedOnly ?? false,
    });
  } catch {
    return {};
  }
}
