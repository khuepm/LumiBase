import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env';

const DEFAULT_SECURITY_HEADER_POLICY: Record<string, string[]> = {
  'default-src': ["'none'"],
  'base-uri': ["'none'"],
  'frame-ancestors': ["'none'"],
  'form-action': ["'none'"],
  'img-src': ["'self'", 'data:', 'blob:'],
  'media-src': ["'self'", 'blob:'],
  'font-src': ["'self'", 'data:'],
  'object-src': ["'none'"],
  // `blob:`: the Studio imports an extension bundle from a blob of the bytes
  // it verified, never from the bundle URL a second time (#1008, ADR-015).
  'script-src': ["'self'", 'blob:'],
  'style-src': ["'self'", "'unsafe-inline'"],
  'connect-src': ["'self'", 'https:', 'wss:'],
};

/**
 * `frame-src` for HTML documents this server renders without a route policy —
 * in practice the Studio shell (Docker `serve-studio`). The live preview pane
 * (epic #667) frames the site's frontend; without this the baseline
 * `default-src 'none'` blocks every frame. The Studio then enforces the exact
 * per-site allowlist itself (ADR-014); this header is the deployment-wide
 * ceiling. Tighten it with `LUMIBASE_STUDIO_FRAME_SRC` (space- or
 * comma-separated origins, or `'none'` to disable preview framing).
 */
export const DEFAULT_STUDIO_FRAME_SRC = ['https:', 'http://localhost:*', 'http://127.0.0.1:*'];

const FRAME_SOURCE = /^(https?:|https?:\/\/(\*\.)?[a-z0-9.-]+(:(\d{1,5}|\*))?)$/i;

export function resolveStudioFrameSrc(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return DEFAULT_STUDIO_FRAME_SRC;
  const parts = raw.split(/[\s,]+/).filter(Boolean);
  if (parts.includes("'none'")) return ["'none'"];
  const valid = parts.filter((p) => FRAME_SOURCE.test(p));
  return valid.length > 0 ? valid : ["'none'"];
}

/**
 * Apply baseline browser security headers to every response. API clients ignore
 * these headers, while HTML/error surfaces get CSP, clickjacking protection,
 * nosniff, and conservative browser feature policy by default.
 */
export const withSecurityHeaders = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  await next();
  // A route may set its own, stricter CSP (e.g. the `sandbox` policy on
  // user-uploaded media, #740). Keep it and add the baseline as a second
  // header: browsers enforce every CSP header, so the result can only be
  // stricter than either policy alone — never weaker.
  const routePolicy = c.res.headers.get('Content-Security-Policy');
  const isAppHtml = !routePolicy && (c.res.headers.get('Content-Type') ?? '').toLowerCase().startsWith('text/html');
  const env = (c.env ?? {}) as { LUMIBASE_STUDIO_FRAME_SRC?: string };
  const baseline = serializeContentSecurityPolicy(
    isAppHtml
      ? { ...DEFAULT_SECURITY_HEADER_POLICY, 'frame-src': resolveStudioFrameSrc(env.LUMIBASE_STUDIO_FRAME_SRC) }
      : DEFAULT_SECURITY_HEADER_POLICY,
  );
  if (routePolicy && routePolicy !== baseline) {
    c.header('Content-Security-Policy', baseline, { append: true });
  } else {
    c.header('Content-Security-Policy', baseline);
  }
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
  // `geolocation=(self)`: the Studio (served from this origin in Docker) offers
  // "Use my location" on geopoint fields (#746). Same-origin only — no frame or
  // third-party origin gets it, and the browser still asks the person.
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self), payment=(), usb=()');
  c.header('Cross-Origin-Opener-Policy', 'same-origin');
  c.header('Cross-Origin-Resource-Policy', 'same-site');
};

export function serializeContentSecurityPolicy(directives: Record<string, string[]>): string {
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ');
}
