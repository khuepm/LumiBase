import { z } from 'zod';

/**
 * Preview contracts (epic #667, V01/V02/V04) — shared by the CMS, Studio and
 * SDK so the three agree on what a preview token may target and how a preview
 * URL is built from a collection's template.
 *
 * Security model: `docs/en/architecture/decisions/adr-014-preview-bridge-threat-model.md`
 * (see `PREVIEW_ADR_PATH`).
 */

export const PREVIEW_ADR_PATH = 'docs/en/architecture/decisions/adr-014-preview-bridge-threat-model.md';

/** Default and maximum lifetime of a minted preview token, in seconds. */
export const PREVIEW_TOKEN_DEFAULT_TTL_SECONDS = 900;
export const PREVIEW_TOKEN_MAX_TTL_SECONDS = 3600;
export const PREVIEW_TOKEN_MIN_TTL_SECONDS = 60;

/** Query parameter a frontend may pass the token in (header is preferred). */
export const PREVIEW_QUERY_PARAM = '__preview';
/** Request header the delivery endpoint reads the token from. */
export const PREVIEW_HEADER = 'x-lumibase-preview';

/** Placeholders a `meta.previewUrl` template may contain. */
export const PREVIEW_URL_PLACEHOLDERS = ['id', 'slug', 'collection', 'locale', 'token', 'version', 'release'] as const;
export type PreviewUrlPlaceholder = (typeof PREVIEW_URL_PLACEHOLDERS)[number];

const ident = z.string().min(1).max(128);
/** BCP 47-ish locale tag (`en`, `vi`, `pt-BR`, `zh-Hant-TW`). */
const localeTag = z
  .string()
  .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/, 'Invalid locale tag.');

/**
 * Body of `POST /api/v1/preview/token`. A token targets either one item
 * (optionally a named content version of it) or a whole release.
 */
export const PreviewTokenMintSchema = z
  .object({
    collection: ident.optional(),
    itemId: ident.optional(),
    /** Content version key (`content_versions.key`) — a named branch. */
    versionKey: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'Invalid version key.')
      .optional(),
    releaseId: ident.optional(),
    locale: localeTag.optional(),
    ttlSeconds: z
      .number()
      .int()
      .min(PREVIEW_TOKEN_MIN_TTL_SECONDS)
      .max(PREVIEW_TOKEN_MAX_TTL_SECONDS)
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasItem = value.collection !== undefined || value.itemId !== undefined;
    if (hasItem && (value.collection === undefined || value.itemId === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'collection and itemId must be given together.' });
    }
    if (!hasItem && value.releaseId === undefined) {
      ctx.addIssue({ code: 'custom', message: 'A preview token targets an item (collection + itemId) or a releaseId.' });
    }
    if (value.versionKey !== undefined && !hasItem) {
      ctx.addIssue({ code: 'custom', message: 'versionKey requires collection + itemId.' });
    }
    if (value.versionKey !== undefined && value.releaseId !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'A token previews a version or a release, not both.' });
    }
  });
export type PreviewTokenMintInput = z.infer<typeof PreviewTokenMintSchema>;

/** Claims a verified preview token resolves to (never includes the token). */
export interface PreviewTarget {
  readonly collection: string | null;
  readonly itemId: string | null;
  readonly versionKey: string | null;
  readonly releaseId: string | null;
  readonly locale: string | null;
}

export type PreviewUrlTemplateIssue =
  | { readonly code: 'INVALID_URL'; readonly message: string }
  | { readonly code: 'INVALID_PROTOCOL'; readonly message: string }
  | { readonly code: 'UNKNOWN_PLACEHOLDER'; readonly message: string };

const PLACEHOLDER_RE = /\{([^{}]*)\}/g;

/**
 * Validate a collection's `meta.previewUrl` template: an absolute `http(s)`
 * URL whose only `{placeholders}` are {@link PREVIEW_URL_PLACEHOLDERS}.
 * Returns `null` when valid.
 */
export function validatePreviewUrlTemplate(template: string): PreviewUrlTemplateIssue | null {
  for (const match of template.matchAll(PLACEHOLDER_RE)) {
    const name = match[1] ?? '';
    if (!(PREVIEW_URL_PLACEHOLDERS as readonly string[]).includes(name)) {
      return { code: 'UNKNOWN_PLACEHOLDER', message: `Unknown placeholder "{${name}}".` };
    }
  }
  let url: URL;
  try {
    url = new URL(template.replace(PLACEHOLDER_RE, 'x'));
  } catch {
    return { code: 'INVALID_URL', message: 'previewUrl must be an absolute URL.' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { code: 'INVALID_PROTOCOL', message: 'previewUrl must use http: or https:.' };
  }
  return null;
}

export type PreviewUrlValues = Partial<Record<PreviewUrlPlaceholder, string | null | undefined>>;

/**
 * Build a preview URL from a validated template. Every value is
 * `encodeURIComponent`-ed; a missing value becomes the empty string; the
 * result is re-validated so a template can never yield a non-http(s) URL.
 * Returns `null` when the template is invalid.
 */
export function buildPreviewUrl(template: string, values: PreviewUrlValues): string | null {
  if (validatePreviewUrlTemplate(template)) return null;
  const built = template.replace(PLACEHOLDER_RE, (_whole, name: string) => {
    const value = values[name as PreviewUrlPlaceholder];
    return value === null || value === undefined ? '' : encodeURIComponent(value);
  });
  try {
    const url = new URL(built);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** The origin (`scheme://host[:port]`) a preview URL template points at. */
export function previewTemplateOrigin(template: string): string | null {
  if (validatePreviewUrlTemplate(template)) return null;
  try {
    return new URL(template.replace(PLACEHOLDER_RE, 'x')).origin;
  } catch {
    return null;
  }
}

/**
 * Origins allowed to host a preview frame / talk to the Studio bridge.
 * Exact `scheme://host[:port]` strings, no wildcards, no paths.
 */
export const PreviewOriginSchema = z
  .string()
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === 'https:' || url.protocol === 'http:') &&
        /^([a-z0-9-]+\.)*[a-z0-9-]+$|^\[[0-9a-f:.]+\]$/i.test(url.hostname) &&
        url.origin === value.replace(/\/$/, '')
      );
    } catch {
      return false;
    }
  }, 'An origin is scheme://host[:port] with no path, query or wildcard.');

/** `settings` key `preview` — per-site preview configuration. */
export const PreviewSettingsSchema = z
  .object({
    /** Origins the Studio may frame and accept bridge messages from. */
    allowedOrigins: z.array(PreviewOriginSchema).max(20).default([]),
    /** Default token lifetime for Studio-minted tokens. */
    ttlSeconds: z
      .number()
      .int()
      .min(PREVIEW_TOKEN_MIN_TTL_SECONDS)
      .max(PREVIEW_TOKEN_MAX_TTL_SECONDS)
      .default(PREVIEW_TOKEN_DEFAULT_TTL_SECONDS),
  })
  .strict();
export type PreviewSettings = z.infer<typeof PreviewSettingsSchema>;
