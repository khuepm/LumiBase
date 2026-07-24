import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env';

/**
 * Endpoint deprecation signalling (OWASP API9: Improper Inventory Management).
 *
 * Attach to any route that is being retired so consumers get a machine-readable
 * warning ahead of removal, via the IETF `Deprecation` and `Sunset` response
 * headers (RFC 8594) plus an optional `Link rel="deprecation"` to the changelog.
 *
 * Example:
 *   legacyRouter.use('*', withDeprecation({
 *     since: '2026-07-01',
 *     sunset: '2026-10-01',
 *     link: 'https://docs.lumibase.dev/changelog#v1-items-legacy',
 *   }));
 */
export interface DeprecationOptions {
  /** ISO-8601 date (or HTTP-date) the endpoint became deprecated. */
  since?: string;
  /** ISO-8601 date (or HTTP-date) after which the endpoint may be removed. */
  sunset?: string;
  /** URL documenting the deprecation / migration path. */
  link?: string;
}

function toHttpDate(value: string): string | null {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toUTCString();
}

export function withDeprecation(options: DeprecationOptions = {}) {
  return createMiddleware<AppEnv>(async (c, next) => {
    await next();

    // `Deprecation: true` when no date is given, else the HTTP-date form.
    const deprecationValue = options.since ? toHttpDate(options.since) : null;
    c.header('Deprecation', deprecationValue ?? 'true');

    if (options.sunset) {
      const sunset = toHttpDate(options.sunset);
      if (sunset) c.header('Sunset', sunset);
    }

    if (options.link) {
      c.header('Link', `<${options.link}>; rel="deprecation"`);
    }
  });
}
