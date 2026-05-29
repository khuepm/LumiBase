/**
 * Setup wizard HTTP surface (`/api/v1/setup/*`).
 *
 * Mounted in `apps/cms/src/index.ts` *outside* the authenticated tenant
 * stack — these endpoints answer before any user exists. The wizard
 * needs them to be reachable on a fresh instance, so the router only
 * relies on `withDb()` for the Drizzle client. The CORS layer is
 * inherited from the global stack.
 *
 * Routes (design §4.1–4.3):
 *
 *   GET  /setup/state         — public, rate-limited 60 req/min/IP.
 *   GET  /setup/capabilities  — public, returns 404 once initialized.
 *   POST /setup/complete      — public, returns 404 once initialized.
 *
 * Error envelope follows the project standard
 * `{ errors: [{ code, message? }] }`.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../env';
import { withDb } from '../../middleware/db';
import {
  SetupService,
  type SetupCompleteContext,
  type SetupServiceError,
} from './service';
import { lockoutPolicySchema } from './policy-codec';

// ── input schema ────────────────────────────────────────────────────────

const completeBodySchema = z.object({
  setupToken: z.string().min(1).max(256).optional(),
  account: z.object({
    email: z.string().email().max(254),
    password: z.string().min(12).max(256),
    firstName: z.string().min(1).max(100),
    lastName: z.string().min(1).max(100),
  }),
  adminPath: z.string().min(1).max(128),
  policy: lockoutPolicySchema,
});

// ── rate limit (in-memory sliding window) ──────────────────────────────

interface RateBucket {
  count: number;
  resetAt: number;
}
const STATE_RATE_LIMIT = 60; // req/min/IP
const STATE_RATE_WINDOW_MS = 60_000;

/** Module-level so tests can reset between runs. */
const stateRateBuckets = new Map<string, RateBucket>();

export function __resetSetupRateLimitForTests(): void {
  stateRateBuckets.clear();
}

function checkStateRateLimit(ip: string): boolean {
  const now = Date.now();
  const bucket = stateRateBuckets.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    stateRateBuckets.set(ip, { count: 1, resetAt: now + STATE_RATE_WINDOW_MS });
    return true;
  }
  if (bucket.count >= STATE_RATE_LIMIT) return false;
  bucket.count += 1;
  return true;
}

// ── service factory ─────────────────────────────────────────────────────

/**
 * Build a SetupService bound to the per-request Drizzle client. Reads
 * env-driven flags (`LUMIBASE_REQUIRE_SETUP_TOKEN`, `LUMIBASE_SMTP_URL`)
 * from the runtime context; tests can short-circuit by overriding
 * `c.set('setupServiceOverride', svc)` before mounting the router.
 */
function buildService(c: {
  env: AppEnv['Bindings'];
  get: <K extends keyof AppEnv['Variables']>(k: K) => AppEnv['Variables'][K];
}): SetupService {
  const db = c.get('db');
  const requireSetupToken = readBoolEnv(c.env, 'LUMIBASE_REQUIRE_SETUP_TOKEN');
  const smtpAvailable = !!readStringEnv(c.env, 'LUMIBASE_SMTP_URL');
  return new SetupService({ db, requireSetupToken, smtpAvailable });
}

/**
 * Env lookups go through these tiny helpers so the unsafe index access
 * is contained. `AppEnv['Bindings']` declares only the *known* fields;
 * the setup wizard reads operator-supplied keys (`LUMIBASE_REQUIRE_SETUP_TOKEN`,
 * `LUMIBASE_SMTP_URL`) that aren't in that interface yet, so we widen
 * to `Record<string, unknown>` in one place rather than scattering
 * casts at every call site. When those keys land in `env.ts`, this
 * cast can collapse to a typed property read.
 */
function readBoolEnv(env: AppEnv['Bindings'], key: string): boolean {
  const v = (env as unknown as Record<string, unknown>)[key];
  if (typeof v !== 'string') return false;
  return v === 'true' || v === '1' || v === 'yes';
}

function readStringEnv(env: AppEnv['Bindings'], key: string): string | undefined {
  const v = (env as unknown as Record<string, unknown>)[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

// ── client IP extraction (mirrors design §6.1) ─────────────────────────

function extractClientIp(req: Request): string {
  const cf = req.headers.get('cf-connecting-ip');
  if (cf) return cf;
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return 'unknown';
}

// ── error → HTTP mapping ───────────────────────────────────────────────

function errorToHttp(error: SetupServiceError): { status: number; body: { errors: Array<{ code: string; message?: string; details?: unknown }> } } {
  switch (error.code) {
    case 'ALREADY_INITIALIZED':
      return {
        status: 404,
        body: { errors: [{ code: 'NOT_FOUND' }] },
      };
    case 'SETUP_IN_PROGRESS':
      return {
        status: 409,
        body: {
          errors: [
            { code: 'SETUP_IN_PROGRESS', message: 'Another setup is in progress.' },
          ],
        },
      };
    case 'SETUP_TOKEN_REQUIRED':
      return {
        status: 401,
        body: { errors: [{ code: 'SETUP_TOKEN_REQUIRED' }] },
      };
    case 'SETUP_TOKEN_INVALID':
      return {
        status: 401,
        body: { errors: [{ code: 'SETUP_TOKEN_INVALID' }] },
      };
    case 'VALIDATION_ERROR':
      return {
        status: 400,
        body: {
          errors: [{ code: 'VALIDATION_ERROR', details: error.issues }],
        },
      };
    case 'PATH_PREDICTABLE':
      return {
        status: 422,
        body: {
          errors: [{ code: 'PATH_PREDICTABLE', message: error.message }],
        },
      };
    case 'PATH_RESERVED':
      return {
        status: 422,
        body: {
          errors: [{ code: 'PATH_RESERVED', message: error.message }],
        },
      };
    case 'PATH_TAKEN':
      return {
        status: 409,
        body: { errors: [{ code: 'PATH_TAKEN' }] },
      };
    case 'INTERNAL':
    default:
      return {
        status: 500,
        body: { errors: [{ code: 'INTERNAL' }] },
      };
  }
}

// ── router ──────────────────────────────────────────────────────────────

export const setupRouter = new Hono<AppEnv>();

// All setup routes need the per-request Drizzle client.
setupRouter.use('*', withDb());

setupRouter.get('/state', async (c) => {
  const ip = extractClientIp(c.req.raw);
  if (!checkStateRateLimit(ip)) {
    return c.json(
      { errors: [{ code: 'RATE_LIMITED' }] },
      429,
      { 'retry-after': Math.ceil(STATE_RATE_WINDOW_MS / 1000).toString() },
    );
  }

  const svc = buildService(c);
  const state = await svc.getState();
  // Don't leak version, hostname, or tenant id (Req 1.6).
  return c.json(state, 200);
});

setupRouter.get('/capabilities', async (c) => {
  const svc = buildService(c);
  // Capabilities only matter while uninitialized — once setup is done
  // every /setup/* path 404s indistinguishably (Req 1.4).
  const state = await svc.getState();
  if (state.state === 'initialized') {
    return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  }
  const caps = await svc.getCapabilities();
  return c.json(caps, 200);
});

setupRouter.post('/complete', async (c) => {
  // Parse body first so a malformed payload yields a clean 400 before
  // we touch the DB.
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json(
      { errors: [{ code: 'VALIDATION_ERROR', message: 'invalid JSON' }] },
      400,
    );
  }

  const parsed = completeBodySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      {
        errors: [
          {
            code: 'VALIDATION_ERROR',
            details: parsed.error.issues.map((i) => ({
              path: i.path,
              message: i.message,
            })),
          },
        ],
      },
      400,
    );
  }

  const svc = buildService(c);
  const ctx: SetupCompleteContext = {
    requestId: c.get('requestId'),
    ip: extractClientIp(c.req.raw),
    userAgent: c.req.header('user-agent') ?? undefined,
  };

  const outcome = await svc.complete(parsed.data, ctx);

  if (!outcome.ok) {
    const mapped = errorToHttp(outcome.error);
    // mapped.status is 4xx/5xx in our taxonomy.
    return c.json(mapped.body, mapped.status as 400 | 401 | 404 | 409 | 422 | 500);
  }

  return c.json(outcome.value, 201);
});
