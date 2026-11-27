import type { Context } from 'hono';
import { z } from 'zod';
import { formatSafeError } from '@lumibase/contracts/utils';
import type { AppEnv } from '../env';
import { captureOpsError } from '../modules/ops/capture';

type ValidationError = { code: 'VALIDATION'; message: string };

/**
 * Map an error thrown while validating client input to `VALIDATION` entries,
 * or `null` when it is a genuine server fault (#1046).
 *
 * - `ZodError` is matched by instance and by shape, so a schema built with
 *   another zod copy in the bundle still counts.
 * - A `SyntaxError` counts only when it is a JSON parse failure on a request
 *   that can carry a body, which is what `c.req.json()` throws.
 *
 * The messages describe the shape of the payload only, never an account.
 */
export function clientValidationErrors(err: unknown, method: string): ValidationError[] | null {
  if (
    err instanceof z.ZodError ||
    (err instanceof Error &&
      err.name === 'ZodError' &&
      Array.isArray((err as { issues?: unknown }).issues))
  ) {
    const issues = (err as unknown as { issues: Array<{ message?: unknown }> }).issues;
    const errors = issues.map(
      (i): ValidationError => ({
        code: 'VALIDATION',
        message: typeof i.message === 'string' ? i.message : 'Invalid input.',
      }),
    );
    return errors.length > 0 ? errors : [{ code: 'VALIDATION', message: 'Invalid input.' }];
  }
  if (
    err instanceof SyntaxError &&
    /JSON/i.test(err.message) &&
    method !== 'GET' &&
    method !== 'HEAD'
  ) {
    return [{ code: 'VALIDATION', message: 'Body must be valid JSON.' }];
  }
  return null;
}

/**
 * `app.onError` for the CMS. A route that calls `schema.parse()` or
 * `c.req.json()` directly lets a ZodError / JSON SyntaxError escape; that is
 * a bad request, not a server fault, so it answers 400 and stays out of the
 * ops error feed. Everything else is a 500 `INTERNAL`, logged and captured.
 */
export function appErrorHandler(err: Error, c: Context<AppEnv>): Response {
  const validation = clientValidationErrors(err, c.req.method);
  if (validation) {
    return c.json({ errors: validation }, 400);
  }
  const requestId = c.get('requestId');
  console.error('[lumibase-cms] unhandled error', { requestId, err: formatSafeError(err) });
  captureOpsError(c, { err, status: 500, errorCode: 'INTERNAL' });
  return c.json(
    { errors: [{ code: 'INTERNAL', message: 'Internal Server Error', requestId }] },
    500,
  );
}
