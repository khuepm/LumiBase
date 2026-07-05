/**
 * Image Transform DSL — the shared contract for on-the-fly image derivatives.
 *
 * The Studio transform panel produces a `TransformDsl`; the CMS delivery route
 * (`GET /media/:key`) parses the same shape and hands it to the runtime image
 * adapter. Keeping the schema here means the URL the FE builds and the params
 * the BE executes can never drift.
 *
 * `transformKey()` yields a stable cache key for a (file, dsl) pair — stable
 * regardless of parameter order — so cached derivatives hit reliably and can be
 * invalidated by the `file:<key>` tag when the source file changes (ADR-004).
 *
 * See `.kiro/specs/image-transform-dsl`.
 */

import { z } from 'zod';

/** Hard ceiling on any output dimension — an abuse guard against huge upscales. */
export const MAX_DIM = 5000;

export const TRANSFORM_FORMATS = ['webp', 'avif', 'jpeg', 'png'] as const;
export type TransformFormat = (typeof TRANSFORM_FORMATS)[number];

export const TRANSFORM_FITS = ['cover', 'contain', 'fill', 'inside', 'outside'] as const;
export type TransformFit = (typeof TRANSFORM_FITS)[number];

/** Focal point in normalized [0,1] coordinates, used when cropping. */
export const focalSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});
export type Focal = z.infer<typeof focalSchema>;

export const transformDslSchema = z
  .object({
    width: z.number().int().min(1).max(MAX_DIM).optional(),
    height: z.number().int().min(1).max(MAX_DIM).optional(),
    format: z.enum(TRANSFORM_FORMATS).optional(),
    /** Output quality, 1–100. */
    quality: z.number().int().min(1).max(100).optional(),
    fit: z.enum(TRANSFORM_FITS).optional(),
    focal: focalSchema.optional(),
  })
  .strict();
export type TransformDsl = z.infer<typeof transformDslSchema>;

/**
 * Parse a DSL from query params (all strings). Returns the validated DSL, or a
 * ZodError via safeParse for the caller to convert to a 400. `focal` accepts
 * either `focal=0.5,0.5` or separate `fx`/`fy`.
 */
export function parseTransformQuery(params: Record<string, string | undefined>): TransformDsl {
  const raw: Record<string, unknown> = {};
  if (params.width != null) raw.width = Number(params.width);
  if (params.height != null) raw.height = Number(params.height);
  if (params.format != null) raw.format = params.format;
  if (params.quality != null) raw.quality = Number(params.quality);
  if (params.fit != null) raw.fit = params.fit;
  if (params.focal != null) {
    const [x, y] = params.focal.split(',').map(Number);
    raw.focal = { x, y };
  } else if (params.fx != null || params.fy != null) {
    raw.focal = { x: Number(params.fx ?? 0.5), y: Number(params.fy ?? 0.5) };
  }
  return transformDslSchema.parse(raw);
}

/**
 * Stable, order-independent cache key for a (file key, transform) pair. The DSL
 * is canonicalized (keys sorted) so `{w,h}` and `{h,w}` map to the same key.
 * An empty DSL yields the original key (backward compatible with no-param URLs).
 */
export function transformKey(fileKey: string, dsl: TransformDsl): string {
  const entries = Object.entries(dsl)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return fileKey;
  const parts = entries.map(([k, v]) =>
    typeof v === 'object' && v !== null ? `${k}=${JSON.stringify(sortObj(v as Record<string, unknown>))}` : `${k}=${String(v)}`,
  );
  return `${fileKey}?${parts.join('&')}`;
}

function sortObj(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
}

/** Tag used to group all derivatives of a source file for cache invalidation. */
export function fileTag(fileKey: string): string {
  return `file:${fileKey}`;
}
