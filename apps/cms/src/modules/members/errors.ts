import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError } from 'zod';
import type { AppEnv } from '../../env';

/** Typed error for the members module; routes map it onto `{ errors: [...] }`. */
export class MemberError extends Error {
  constructor(
    readonly code: string,
    readonly status: ContentfulStatusCode,
    message: string,
    readonly issues?: unknown,
  ) {
    super(message);
    this.name = 'MemberError';
  }
}

/** Map a thrown error onto the project envelope; rethrows anything unknown. */
export function memberErrorResponse(c: Context<AppEnv>, err: unknown): Response {
  if (err instanceof MemberError) {
    return c.json(
      { errors: [{ code: err.code, message: err.message, ...(err.issues ? { issues: err.issues } : {}) }] },
      err.status,
    );
  }
  if (err instanceof ZodError) {
    return c.json({ errors: [{ code: 'VALIDATION', message: 'Invalid request body.', issues: err.issues }] }, 400);
  }
  throw err;
}

/** Postgres unique violation (23505), unwrapped through driver `.cause` chains. */
export function isUniqueViolation(err: unknown): boolean {
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur && typeof cur === 'object'; i += 1) {
    if ((cur as { code?: unknown }).code === '23505') return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}
