import { reviewContentHash } from '@lumibase/sdk';

/**
 * Hashing for Studio draft review (Jev J08, #515).
 *
 * The CMS stamps every review run with `contentHash = sha256(canonical JSON)`
 * of the fields it reviewed (`review-service.ts`). The Studio needs the same
 * canonical form for two things:
 *
 * - **Client-side staleness.** `canonicalReviewJson` is taken when a review
 *   starts; any later difference means the editor changed the reviewed
 *   content, so the result is stale and must not be applied.
 * - **Server-side staleness on feedback.** For snapshot runs the CMS cannot
 *   re-read an unsaved draft, so feedback carries `draftReviewHash` of the
 *   draft the editor sees now; the CMS answers 409 `REVIEW_STALE` when it
 *   differs from the run's hash.
 *
 * `draftReviewHash` is the SDK's `reviewContentHash`, which a parity test
 * (`apps/cms/src/services/__tests__/review-content-hash-parity.test.ts`)
 * holds byte-for-byte equal to the CMS function. Re-implementing it here
 * would add a third copy to keep in sync, so this file only adds the
 * projection and the synchronous canonical string.
 */

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

/** Only `fields`, without `undefined` values: the shape the CMS reviews and hashes. */
export function projectReviewFields(
  values: Record<string, unknown> | null | undefined,
  fields: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!values) return out;
  for (const field of fields) {
    if (Object.hasOwn(values, field) && values[field] !== undefined) out[field] = values[field];
  }
  return out;
}

/**
 * Canonical JSON (sorted keys, dates serialised, `undefined` dropped) — the
 * exact string the CMS hashes. Synchronous, so a render can compare it.
 */
export function canonicalReviewJson(values: Record<string, unknown>): string {
  return JSON.stringify(canonicalize(JSON.parse(JSON.stringify(values ?? null))));
}

/** `sha256:<64 hex>` of `values`, identical to the CMS `ReviewRun.contentHash`. */
export function draftReviewHash(values: Record<string, unknown>): Promise<string> {
  return reviewContentHash(values);
}
