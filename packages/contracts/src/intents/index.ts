/**
 * Studio intent links — versioned contract (v1).
 *
 * An intent link is a stable, layout-independent URL that asks Studio to do
 * something with a piece of content ("edit item X of collection Y, in locale
 * Z, focus field F") without the producer knowing Studio's internal route
 * tree. Producers (preview overlays, notifications, a chat agent, email) build
 * links with {@link buildStudioIntentPath} / {@link buildStudioIntentUrl};
 * Studio parses them with {@link parseStudioIntent} and resolves them to its
 * own routes (or to an extension that claims the intent).
 *
 * URL shape (v1):
 *
 *   {studioOrigin}{adminPath?}/intent/{action}?collection=…&id=…&locale=…&field=…&site=…&v=1
 *
 *   action      open | create | edit
 *   collection  required for every action
 *   id          required for `edit`; optional for `open` (no id → the
 *               collection list); forbidden for `create`
 *   locale      optional BCP 47-style tag (`en`, `vi`, `pt-BR`)
 *   field       optional field name to scroll to and focus (needs `id` or
 *               `create`; ignored by the list view so it is rejected there)
 *   site        optional site id; when it differs from the active site Studio
 *               asks before switching and refuses when the user has no access
 *   v           optional contract version; absent means 1
 *
 * Compatibility rules: new optional params may be added within v1; anything
 * that changes the meaning of an existing param bumps `v`. A Studio that does
 * not know a version or a param refuses the link with an explanation instead
 * of guessing (`utm_*` tracking params are the one tolerated exception).
 *
 * Pure: no DOM, no Node APIs — safe for the CMS worker, Studio and the SDK.
 */

export const STUDIO_INTENT_VERSION = 1 as const;

export const STUDIO_INTENT_ACTIONS = ['open', 'create', 'edit'] as const;
export type StudioIntentAction = (typeof STUDIO_INTENT_ACTIONS)[number];

/** Query parameter names, in canonical (serialisation) order. */
export const STUDIO_INTENT_PARAMS = ['collection', 'id', 'locale', 'field', 'site', 'v'] as const;
export type StudioIntentParam = (typeof STUDIO_INTENT_PARAMS)[number];

/** Path segment every intent link lives under (after the optional admin path). */
export const STUDIO_INTENT_SEGMENT = 'intent' as const;

export interface StudioIntent {
  v: typeof STUDIO_INTENT_VERSION;
  action: StudioIntentAction;
  collection: string;
  id?: string;
  locale?: string;
  field?: string;
  site?: string;
}

export type StudioIntentErrorCode =
  | 'unknown_action'
  | 'unsupported_version'
  | 'unknown_param'
  | 'duplicate_param'
  | 'missing_param'
  | 'invalid_param'
  | 'forbidden_param';

export interface StudioIntentError {
  code: StudioIntentErrorCode;
  param?: string;
  message: string;
}

export type StudioIntentParseResult =
  | { ok: true; intent: StudioIntent }
  | { ok: false; errors: StudioIntentError[] };

/** Collection and field identifiers (mirrors the data-model naming rule). */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** Item ids: nanoid / uuid / numeric / slug-ish keys. */
const ITEM_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Site ids (same shape Studio accepts for the routing header). */
const SITE_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** BCP 47-ish locale tag: `en`, `vi`, `pt-BR`, `zh-Hant-TW`. */
const LOCALE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,3}$/;

const RESERVED_ITEM_IDS: ReadonlySet<string> = new Set(['new', 'reviews']);

const VALIDATORS: Record<Exclude<StudioIntentParam, 'v'>, RegExp> = {
  collection: IDENTIFIER,
  id: ITEM_ID,
  locale: LOCALE,
  field: IDENTIFIER,
  site: SITE_ID,
};

export function isStudioIntentAction(value: unknown): value is StudioIntentAction {
  return typeof value === 'string' && (STUDIO_INTENT_ACTIONS as readonly string[]).includes(value);
}

type ParamSource = URLSearchParams | Iterable<[string, string]> | Record<string, string | undefined>;

function entriesOf(source: ParamSource): Array<[string, string]> {
  if (typeof URLSearchParams !== 'undefined' && source instanceof URLSearchParams) {
    const out: Array<[string, string]> = [];
    source.forEach((value, key) => out.push([key, value]));
    return out;
  }
  if (typeof (source as Iterable<[string, string]>)[Symbol.iterator] === 'function') {
    return Array.from(source as Iterable<[string, string]>);
  }
  return Object.entries(source as Record<string, string | undefined>).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
}

/**
 * Parse and validate an intent. Never throws; every problem is reported so the
 * error page can explain all of them at once.
 */
export function parseStudioIntent(action: string, params: ParamSource): StudioIntentParseResult {
  const errors: StudioIntentError[] = [];
  if (!isStudioIntentAction(action)) {
    errors.push({
      code: 'unknown_action',
      message: `Unknown intent action. Expected one of: ${STUDIO_INTENT_ACTIONS.join(', ')}.`,
    });
  }

  const values: Partial<Record<StudioIntentParam, string>> = {};
  for (const [rawKey, value] of entriesOf(params)) {
    const key = rawKey;
    if (key.startsWith('utm_')) continue;
    if (!(STUDIO_INTENT_PARAMS as readonly string[]).includes(key)) {
      errors.push({ code: 'unknown_param', param: key.slice(0, 64), message: 'Unknown parameter.' });
      continue;
    }
    const name = key as StudioIntentParam;
    if (values[name] !== undefined) {
      errors.push({ code: 'duplicate_param', param: name, message: 'Parameter given more than once.' });
      continue;
    }
    values[name] = value;
  }

  if (values.v !== undefined && values.v !== String(STUDIO_INTENT_VERSION)) {
    errors.push({
      code: 'unsupported_version',
      param: 'v',
      message: `This link uses intent version ${values.v.slice(0, 8)}; this Studio understands version ${STUDIO_INTENT_VERSION}.`,
    });
  }

  for (const name of Object.keys(VALIDATORS) as Array<keyof typeof VALIDATORS>) {
    const value = values[name];
    if (value === undefined) continue;
    if (!VALIDATORS[name].test(value)) {
      errors.push({ code: 'invalid_param', param: name, message: `Invalid ${name}.` });
    }
  }

  // Static segments of the item route; an id equal to one would open the
  // create form or the review queue instead of an item.
  if (values.id !== undefined && RESERVED_ITEM_IDS.has(values.id)) {
    errors.push({ code: 'invalid_param', param: 'id', message: 'Invalid id.' });
  }

  if (values.collection === undefined) {
    errors.push({ code: 'missing_param', param: 'collection', message: 'A collection is required.' });
  }
  if (action === 'edit' && values.id === undefined) {
    errors.push({ code: 'missing_param', param: 'id', message: 'An item id is required to edit.' });
  }
  if (action === 'create' && values.id !== undefined) {
    errors.push({ code: 'forbidden_param', param: 'id', message: 'A new item cannot have an id.' });
  }
  if (action === 'open' && values.id === undefined && values.field !== undefined) {
    errors.push({
      code: 'forbidden_param',
      param: 'field',
      message: 'A field can only be focused on an item, not on a collection list.',
    });
  }

  if (errors.length > 0) return { ok: false, errors };

  const intent: StudioIntent = {
    v: STUDIO_INTENT_VERSION,
    action: action as StudioIntentAction,
    collection: values.collection as string,
  };
  if (values.id !== undefined) intent.id = values.id;
  if (values.locale !== undefined) intent.locale = values.locale;
  if (values.field !== undefined) intent.field = values.field;
  if (values.site !== undefined) intent.site = values.site;
  return { ok: true, intent };
}

export type StudioIntentInput = Omit<StudioIntent, 'v'> & { v?: typeof STUDIO_INTENT_VERSION };

/**
 * Admin-relative intent path, e.g. `/intent/edit?collection=posts&id=p1`.
 * Validates the input with the same rules Studio applies, so a producer can
 * never mint a link Studio would refuse. Params are emitted in canonical order;
 * `v` is omitted while it is the default.
 */
export function buildStudioIntentPath(input: StudioIntentInput): string {
  const { action, ...rest } = input;
  const params = new URLSearchParams();
  for (const name of STUDIO_INTENT_PARAMS) {
    if (name === 'v') continue;
    const value = rest[name];
    if (value !== undefined) params.set(name, value);
  }
  const parsed = parseStudioIntent(action, params);
  if (!parsed.ok) {
    const detail = parsed.errors.map((e) => (e.param ? `${e.param}: ${e.code}` : e.code)).join(', ');
    throw new TypeError(`Invalid Studio intent (${detail}).`);
  }
  return `/${STUDIO_INTENT_SEGMENT}/${action}?${params.toString()}`;
}

/** Admin path shape (mirrors the setup wizard rule). */
const ADMIN_PATH = /^\/[a-z0-9][a-z0-9-]{2,62}[a-z0-9]$/;

export interface BuildStudioIntentUrlOptions {
  /** Studio origin, e.g. `https://cms.example.com` (http/https only). */
  studioUrl: string;
  /** Private admin path (`/lumi-7f3a9c`) when Studio is served under one. */
  adminPath?: string | null;
}

/** Strips leading and trailing `/` in linear time (no backtracking regex). */
function trimSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === 47) start += 1;
  while (end > start && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(start, end);
}

/**
 * Absolute intent URL for links that leave the app (email, chat, push).
 * Any path on `studioUrl` is discarded; the admin path is validated.
 */
export function buildStudioIntentUrl(input: StudioIntentInput, options: BuildStudioIntentUrlOptions): string {
  let base: URL;
  try {
    base = new URL(options.studioUrl);
  } catch {
    throw new TypeError('studioUrl must be an absolute http(s) URL.');
  }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') {
    throw new TypeError('studioUrl must be an absolute http(s) URL.');
  }
  const adminPath = options.adminPath ? `/${trimSlashes(options.adminPath)}` : '';
  if (adminPath && !ADMIN_PATH.test(adminPath)) throw new TypeError('Invalid adminPath.');
  return `${base.origin}${adminPath}${buildStudioIntentPath(input)}`;
}

/**
 * Built-in Studio route for an intent (admin-relative). Always an internal
 * path assembled from validated, URI-encoded segments.
 */
export function studioIntentRoute(intent: StudioIntent): { pathname: string; search: { locale?: string; field?: string } } {
  const collection = encodeURIComponent(intent.collection);
  const search: { locale?: string; field?: string } = {};
  if (intent.locale) search.locale = intent.locale;
  if (intent.field && (intent.id || intent.action === 'create')) search.field = intent.field;
  if (intent.action === 'create') return { pathname: `/content/${collection}/new`, search };
  if (!intent.id) return { pathname: `/content/${collection}`, search: {} };
  return { pathname: `/content/${collection}/${encodeURIComponent(intent.id)}`, search };
}
