import { signSourceToken, SOURCE_TOKEN_TTL_MS } from './source-token';

/**
 * Build `(fileId, version) => signed source URL` for one site. Returns null
 * from the builder when there is no secret or no public origin, so the job
 * records why it could not submit instead of handing the provider a URL it
 * cannot reach.
 */
export function sourceUrlBuilder(opts: {
  secret: string | null;
  origin: string | null;
  siteId: string;
  now?: () => number;
}): (fileId: string, version: number) => Promise<string | null> {
  return async (fileId, version) => {
    if (!opts.secret || !opts.origin) return null;
    const exp = (opts.now?.() ?? Date.now()) + SOURCE_TOKEN_TTL_MS;
    const token = await signSourceToken(opts.secret, { siteId: opts.siteId, fileId, version, exp });
    return `${opts.origin}/api/v1/video/source/${token}`;
  };
}
