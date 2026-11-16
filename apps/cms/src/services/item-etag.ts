/**
 * Strong entity tags for items (content-environments Phase A, design §6 and
 * §14.7). The tag is the item's `version` counter; the item id is already in
 * the URL, so it is not repeated in the tag.
 *
 * `If-Match` uses the strong comparison of RFC 9110 §13.1.1: a weak tag
 * (`W/"3"`) never matches, and an entry that is not a well-formed quoted
 * integer matches nothing.
 */

import { items } from '@lumibase/database';
import { sql, type SQL } from 'drizzle-orm';

/**
 * `SET version = version + 1`. Use in every UPDATE that changes an item's
 * logical content. Computed by the database so concurrent writers never
 * produce the same version.
 */
export function nextItemVersion(): SQL {
  return sql`${items.version} + 1`;
}

export function formatItemEtag(version: number): string {
  return `"${version}"`;
}

/**
 * Parsed `If-Match` header.
 * - `null`: header absent or blank → no precondition (legacy behaviour).
 * - `{ any: true }`: `*` → any current version is acceptable.
 * - `{ versions }`: the write may proceed only if the current version is one
 *   of these. An empty list means no entry could ever match → always 412.
 */
export type IfMatch = null | { any: true } | { any: false; versions: number[] };

const STRONG_VERSION_TAG = /^"(0|[1-9][0-9]{0,9})"$/;

export function parseIfMatch(header: string | null | undefined): IfMatch {
  if (header === null || header === undefined) return null;
  const trimmed = header.trim();
  if (trimmed === '') return null;
  if (trimmed === '*') return { any: true };
  const versions: number[] = [];
  for (const raw of trimmed.split(',')) {
    const match = STRONG_VERSION_TAG.exec(raw.trim());
    if (!match) continue;
    const version = Number(match[1]);
    if (Number.isSafeInteger(version) && version <= 2_147_483_647) versions.push(version);
  }
  return { any: false, versions };
}

/** The precondition `ItemService.patch` enforces, or `undefined` for none. */
export function expectedVersionsFrom(ifMatch: IfMatch): number[] | undefined {
  if (ifMatch === null || ifMatch.any) return undefined;
  return ifMatch.versions;
}
