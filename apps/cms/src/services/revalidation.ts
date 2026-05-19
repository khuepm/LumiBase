/**
 * Tag-based cache revalidation service — Phase G.
 *
 * When content changes in LumiBase, downstream Next.js (or any ISR-capable)
 * apps need to be notified to purge their cached pages. This service:
 *
 * 1. Maintains a list of registered revalidation targets per site (stored in
 *    settings key `revalidation.targets`).
 * 2. Dispatches a `POST <target.url>?tag=<collectionName>` HTTP request for
 *    each active target when `revalidate()` is called.
 * 3. Can also accept an array of explicit tags (e.g. `['home', 'posts']`).
 *
 * Next.js route handler example (app/api/revalidate/route.ts):
 *   import { revalidateTag } from 'next/cache';
 *   export async function POST(req: Request) {
 *     const tag = new URL(req.url).searchParams.get('tag');
 *     if (tag) revalidateTag(tag);
 *     return Response.json({ revalidated: true });
 *   }
 */

export interface RevalidationTarget {
  /** Unique id for this target entry. */
  id: string;
  /** Display label (e.g. "Production Next.js"). */
  label: string;
  /** Full URL to the Next.js revalidation endpoint. */
  url: string;
  /** Optional bearer token sent as Authorization header. */
  secret?: string;
  /** `active` | `inactive` */
  status: 'active' | 'inactive';
}

export interface RevalidationResult {
  targetId: string;
  tag: string;
  ok: boolean;
  status?: number;
  error?: string;
}

/**
 * Dispatch revalidation requests to all active targets for a given site.
 *
 * @param targets  List of registered targets (loaded from settings).
 * @param tags     Collection names or explicit cache tags to invalidate.
 * @returns        Array of per-target results (fire-and-forget safe).
 */
export async function dispatchRevalidation(
  targets: RevalidationTarget[],
  tags: string[],
): Promise<RevalidationResult[]> {
  const active = targets.filter((t) => t.status === 'active');
  const results: RevalidationResult[] = [];

  for (const target of active) {
    for (const tag of tags) {
      try {
        const url = new URL(target.url);
        url.searchParams.set('tag', tag);

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (target.secret) {
          headers['Authorization'] = `Bearer ${target.secret}`;
        }

        const res = await fetch(url.toString(), {
          method: 'POST',
          headers,
          // 5-second timeout — revalidation is best-effort.
          signal: AbortSignal.timeout(5_000),
        });

        results.push({ targetId: target.id, tag, ok: res.ok, status: res.status });
      } catch (err) {
        results.push({
          targetId: target.id,
          tag,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return results;
}

/**
 * Parse a settings `revalidation.targets` value into typed targets.
 * Falls back to `[]` if the stored value is malformed.
 */
export function parseTargets(raw: unknown): RevalidationTarget[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (t): t is RevalidationTarget =>
      typeof t === 'object' &&
      t !== null &&
      typeof t.id === 'string' &&
      typeof t.url === 'string',
  );
}
