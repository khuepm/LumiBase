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
  'script-src': ["'self'"],
  'style-src': ["'self'", "'unsafe-inline'"],
  'connect-src': ["'self'", 'https:', 'wss:'],
};

/**
 * Apply baseline browser security headers to every response. API clients ignore
 * these headers, while HTML/error surfaces get CSP, clickjacking protection,
 * nosniff, and conservative browser feature policy by default.
 */
export const withSecurityHeaders = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  await next();
  c.header('Content-Security-Policy', serializeContentSecurityPolicy(DEFAULT_SECURITY_HEADER_POLICY));
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  c.header('Cross-Origin-Opener-Policy', 'same-origin');
  c.header('Cross-Origin-Resource-Policy', 'same-site');
};

export function serializeContentSecurityPolicy(directives: Record<string, string[]>): string {
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ');
}
