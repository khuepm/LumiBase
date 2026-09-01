import { z } from 'zod';

/**
 * Upload policy — the single source of truth for which file types and sizes a
 * site accepts. Shared by the CMS (the `file-upload-policy` guard + the
 * `/uploads/config` API) and the Studio (the settings page that lets an admin
 * choose the allowed extensions, and the upload pickers that constrain their
 * `accept` attribute). Keeping the catalogue here means the server's allowlist
 * and the client's file picker can never drift apart.
 *
 * Pure data + zod only — no Hono/React/runtime deps.
 */

/** Default cap when neither DB config nor env override is present. 10 MiB. */
export const DEFAULT_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Catalogue of the file types the platform knows how to validate safely. Each
 * entry maps a MIME type to its filename extensions and a human label for the
 * settings UI. The server content-sniffs each of these by magic bytes; SVG is
 * additionally scanned for active/script content at the guard.
 */
export interface UploadTypeEntry {
  readonly mime: string;
  readonly extensions: readonly string[];
  readonly label: string;
  /** Optional caveat surfaced in the settings UI. */
  readonly note?: string;
}

export const UPLOAD_TYPE_CATALOGUE: readonly UploadTypeEntry[] = [
  { mime: 'image/png', extensions: ['.png'], label: 'PNG image' },
  { mime: 'image/jpeg', extensions: ['.jpg', '.jpeg'], label: 'JPEG image' },
  { mime: 'image/gif', extensions: ['.gif'], label: 'GIF image' },
  { mime: 'image/webp', extensions: ['.webp'], label: 'WebP image' },
  { mime: 'image/avif', extensions: ['.avif'], label: 'AVIF image' },
  {
    mime: 'image/svg+xml',
    extensions: ['.svg'],
    label: 'SVG image',
    note: 'SVGs carrying script or active content are rejected and are served as downloads, never rendered inline.',
  },
  { mime: 'application/pdf', extensions: ['.pdf'], label: 'PDF document' },
  { mime: 'text/csv', extensions: ['.csv'], label: 'CSV file' },
  { mime: 'text/plain', extensions: ['.txt', '.text', '.log', '.md'], label: 'Plain text' },
] as const;

/** Default MIME allowlist — every catalogued type. */
export const DEFAULT_UPLOAD_MIME_TYPES: readonly string[] = UPLOAD_TYPE_CATALOGUE.map((e) => e.mime);

/** MIME → extension map, derived from the catalogue. */
export const MIME_EXTENSIONS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  UPLOAD_TYPE_CATALOGUE.map((e) => [e.mime, e.extensions]),
);

/**
 * Effective, resolved upload policy for a site: a positive byte cap and a
 * non-empty MIME allowlist.
 */
export const UploadPolicyConfigSchema = z.object({
  maxBytes: z.number().int().positive(),
  allowedMimeTypes: z.array(z.string().min(1)).min(1),
});

export type UploadPolicyConfig = z.infer<typeof UploadPolicyConfigSchema>;

/**
 * Update payload accepted by `PUT /api/v1/uploads/config`. `maxBytes` is
 * optional so a caller can change only the allowlist; MIME types are restricted
 * to the catalogue so an operator cannot enable a type the server has no
 * validator for (which would be accepted without content sniffing).
 */
export const UploadPolicyUpdateSchema = z.object({
  maxBytes: z.number().int().positive().max(1024 * 1024 * 1024).optional(),
  allowedMimeTypes: z
    .array(z.enum(DEFAULT_UPLOAD_MIME_TYPES as [string, ...string[]]))
    .min(1)
    .optional(),
});

export type UploadPolicyUpdateInput = z.infer<typeof UploadPolicyUpdateSchema>;

/** Normalize a MIME string: strip params, lowercase, trim. */
export function normalizeMimeType(mime: string | undefined): string | undefined {
  return mime?.split(';', 1)[0]?.trim().toLowerCase() || undefined;
}

/** Parse a byte cap from a raw env/string value, falling back to the default. */
export function resolveMaxBytes(raw: string | number | undefined): number {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_UPLOAD_MAX_BYTES;
  if (!raw) return DEFAULT_UPLOAD_MAX_BYTES;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_UPLOAD_MAX_BYTES;
  return parsed;
}

/** Parse a comma-separated MIME allowlist, falling back to the default. */
export function resolveMimeAllowlist(raw: string | undefined): string[] {
  if (!raw) return [...DEFAULT_UPLOAD_MIME_TYPES];
  const parsed = raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : [...DEFAULT_UPLOAD_MIME_TYPES];
}

/** Whether a MIME type is permitted by an allowlist (supports `type/*`). */
export function isMimeAllowed(mime: string | undefined, allowlist: readonly string[]): boolean {
  const normalized = normalizeMimeType(mime);
  if (!normalized) return false;
  return allowlist.some((allowed) => {
    const lower = allowed.toLowerCase();
    if (lower.endsWith('/*')) return normalized.startsWith(lower.slice(0, -1));
    return normalized === lower;
  });
}

/**
 * Whether a filename's extension is compatible with a declared MIME type. When
 * the MIME type is not one the catalogue maps, the check passes (the MIME
 * allowlist is the gate for those).
 */
export function extensionMatchesMime(fileName: string, mime: string | undefined): boolean {
  const normalized = normalizeMimeType(mime);
  if (!normalized) return false;
  const extensions = MIME_EXTENSIONS[normalized];
  if (!extensions) return true;
  const name = fileName.trim().toLowerCase();
  return extensions.some((extension) => name.endsWith(extension));
}

/** All extensions permitted by an allowlist, deduped and sorted. */
export function extensionsForMimeTypes(allowlist: readonly string[]): string[] {
  const set = new Set<string>();
  for (const mime of allowlist) {
    for (const ext of MIME_EXTENSIONS[normalizeMimeType(mime) ?? ''] ?? []) set.add(ext);
  }
  return [...set].sort();
}

/**
 * Build the value for an `<input type="file" accept="...">` from a resolved
 * policy — both the extensions and the MIME types, so the OS file picker
 * filters to what the server will accept. Returns `undefined` when the
 * allowlist is empty (no constraint).
 */
export function acceptAttribute(config: Pick<UploadPolicyConfig, 'allowedMimeTypes'>): string | undefined {
  const tokens = [...config.allowedMimeTypes, ...extensionsForMimeTypes(config.allowedMimeTypes)];
  return tokens.length > 0 ? tokens.join(',') : undefined;
}
