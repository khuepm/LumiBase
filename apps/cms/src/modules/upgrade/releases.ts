import { formatSafeError } from '@lumibase/contracts/utils';
import { z } from 'zod';
import type { ReleaseChannel } from './config';

/**
 * The public release manifest (`releases.json`), read server-side for the
 * upgrade preflight (#898). Same document Studio's update notice reads; a
 * fetch failure means "unknown", never "safe to upgrade".
 */

const channelSchema = z.object({
  version: z.string().trim().min(1),
  releaseDate: z.string().trim().min(1),
  changelogUrl: z.string().trim().min(1),
  minimumSafeUpgradeVersion: z.string().trim().min(1),
  migrationWarning: z.boolean(),
  upgradeGuideUrl: z.string().trim().min(1).optional(),
});

const manifestSchema = z.object({ stable: channelSchema, edge: channelSchema });

export type ReleaseInfo = z.infer<typeof channelSchema>;

export type ReleaseLookup = { ok: true; release: ReleaseInfo } | { ok: false; reason: string };

const FETCH_TIMEOUT_MS = 5_000;

export async function fetchLatestRelease(
  url: string,
  channel: ReleaseChannel,
  fetchImpl: typeof fetch = fetch,
): Promise<ReleaseLookup> {
  try {
    const res = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, reason: `HTTP_${res.status}` };
    const parsed = manifestSchema.safeParse(await res.json());
    if (!parsed.success) return { ok: false, reason: 'MALFORMED_RELEASES' };
    return { ok: true, release: parsed.data[channel] };
  } catch (err) {
    console.warn('[upgrade] could not read the release manifest', formatSafeError(err));
    return { ok: false, reason: 'FETCH_FAILED' };
  }
}

/**
 * Compare two versions (`v2.1.0`, `2.2.0-rc.1`). Numeric parts compare
 * numerically; a pre-release sorts before its release. `null` when either is
 * not a version (e.g. `unknown`), so callers cannot mistake it for "older".
 */
export function compareVersions(a: string, b: string): number | null {
  const parse = (v: string) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v.trim());
    if (!m) return null;
    return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i += 1) {
    if (x.nums[i] !== y.nums[i]) return x.nums[i]! < y.nums[i]! ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  const xp = x.pre.split('.');
  const yp = y.pre.split('.');
  for (let i = 0; i < Math.max(xp.length, yp.length); i += 1) {
    const p = xp[i];
    const q = yp[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p) ? Number(p) : null;
    const qn = /^\d+$/.test(q) ? Number(q) : null;
    if (pn !== null && qn !== null && pn !== qn) return pn < qn ? -1 : 1;
    if (pn === null || qn === null) {
      if (p !== q) return p < q ? -1 : 1;
    }
  }
  return 0;
}
