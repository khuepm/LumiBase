import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env';

/**
 * App-level JSON request-body cap (high-load-cache-readiness Req 6.2).
 *
 * Defense-in-depth for deployments that don't sit behind the Caddy
 * `request_body max_size` guard (Req 6.1) — e.g. a bare Node process or a
 * proxy without a body limit. Cloudflare Workers enforce a platform request
 * cap of its own, so this is the belt to Caddy's braces.
 *
 * Only mutating requests (POST/PUT/PATCH) with a JSON content-type are
 * checked; file uploads are governed separately by `withFileUploadPolicy`
 * (their own, larger `FILE_UPLOAD_MAX_BYTES`). The check is on the declared
 * `Content-Length` header, so it rejects before the body is read.
 */
const DEFAULT_MAX_JSON_BODY_BYTES = 1 * 1024 * 1024; // 1 MiB
const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH']);

export function resolveMaxJsonBody(raw: string | undefined): number {
  if (!raw) return DEFAULT_MAX_JSON_BODY_BYTES;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_MAX_JSON_BODY_BYTES;
  return Math.floor(value);
}

export const withJsonBodyLimit = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  if (!METHODS_WITH_BODY.has(c.req.method)) return next();

  const contentType = c.req.header('content-type') ?? '';
  // Only guard JSON bodies here; multipart/binary uploads have their own limit.
  if (!contentType.includes('application/json')) return next();

  const declared = c.req.header('content-length');
  if (!declared) return next();
  const length = Number(declared);
  if (!Number.isFinite(length)) return next();

  const env = c.env as Partial<AppEnv['Bindings']> | undefined;
  const maxBytes = resolveMaxJsonBody(env?.LUMIBASE_MAX_JSON_BODY ?? process.env.LUMIBASE_MAX_JSON_BODY);
  if (length > maxBytes) {
    return c.json(
      {
        errors: [
          {
            code: 'PAYLOAD_TOO_LARGE',
            message: `Request body exceeds the configured ${maxBytes} byte limit.`,
          },
        ],
      },
      413,
    );
  }

  return next();
};
