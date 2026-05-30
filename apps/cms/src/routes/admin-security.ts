/**
 * Admin Security routes (admin-setup-wizard task 6.4; Req 7.6, 7.7,
 * 8.7, 8.8, 8.9; design §4.5, §4.6).
 *
 * Authenticated, admin-only HTTP surface for hand-unlocking accounts
 * and unblocking IPs that the LoginGuard's sliding-window counter has
 * tripped.
 *
 *   POST /unlock-user  body `{ email }`  → 200 `{ unlocked: true }`
 *   POST /unblock-ip   body `{ ip }`     → 200 `{ unblocked: true }`
 *
 * Mounted in `apps/cms/src/index.ts` at `/api/v1/admin/security` under
 * the authenticated `api` Hono — `withAuth` therefore runs upstream and
 * a missing principal is already converted to 401 before this router
 * sees the request. The router itself only needs to enforce the
 * `admin`-role gate (Req 7.6 / 7.7) and validate the inputs.
 *
 * Counter-reset semantics:
 *
 *   - **Unlock user.** The lockout state lives in two places:
 *     `users.lockedUntil` (read by the LoginGuard precheck, Req 7.3)
 *     and the sliding-window counter that derives from
 *     `login_attempts` (design §6.4). Clearing only the timestamp
 *     would leave a stale fail-burst in the window, so the next
 *     login attempt could trip the threshold again on the very first
 *     try and re-lock the user immediately. To make the unlock
 *     operationally meaningful we delete the user's recent `fail`
 *     rows inside `lockoutWindowSeconds` *and* clear the user
 *     timestamp + failed-count column.
 *
 *   - **Unblock IP.** There is no separate `ip_blocks` table — the
 *     counter is the source of truth (design §6.4) — so the only way
 *     to actually clear the block is to delete the IP's recent fail
 *     rows from `login_attempts` inside `lockoutWindowSeconds`. The
 *     route validates that the input is a syntactically-valid IPv4 or
 *     IPv6 address (reusing `parseIpToBytes` so the validator stays
 *     in lockstep with the trusted-proxy matcher) and canonicalises
 *     loopback variants to match the form `extractClientIp` writes
 *     into the table.
 *
 * Audit log (Req 8.8 / 7.6):
 *
 *   The real audit wiring lands in task 11.2 (AuditLogger). Until
 *   then we surface `user_unlocked` / `ip_unblocked` events via the
 *   structured-log channel using {@link maskAdminPath} so any
 *   accidentally-leaked Admin_Path is masked at the default log
 *   level — keeping the placeholder in shape with the audit codes
 *   from Req 15.1 means the swap to AuditLogger is mechanical.
 *
 * Validates: Requirements 7.6, 7.7, 8.7, 8.8, 8.9 (design §4.5, §4.6).
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { and, eq, gte, sql } from 'drizzle-orm';
import { loginAttempts, users } from '@lumibase/database';

import type { AppEnv } from '../env';
import { parseIpToBytes, canonicalLoopback } from '../modules/login-guard/ip-extract';
import { normalizeEmail } from '../modules/login-guard/email-normalize';
import { loadLockoutPolicyFromSettings } from '../modules/login-guard/middleware';
import { STANDARD_LOCKOUT_POLICY } from '../modules/setup/policy-codec';
import { maskAdminPath } from '../modules/audit/path-mask';

export const adminSecurityRouter = new Hono<AppEnv>();

// ── input schemas ──────────────────────────────────────────────────────

const unlockUserSchema = z.object({
  // Match the wider auth surface: RFC 5321 envelope cap of 254 chars
  // and the same `z.string().email()` shape used in `/auth/login`.
  email: z.string().email().max(254),
});

const unblockIpSchema = z.object({
  // Cap at 64 chars — far above the 45-char IPv6 max — so a malformed
  // request can't waste cycles inside the parser.
  ip: z.string().min(1).max(64),
});

// ── admin gate ─────────────────────────────────────────────────────────

/**
 * Reject the request unless `c.get('auth').roles` contains `'admin'`.
 *
 * `withAuth` (in `apps/cms/src/middleware/auth.ts`) already populates
 * `auth.roles`:
 *
 *   - Cloudflare Access → defaults to `['admin']` for Studio sessions
 *     (real role mapping is finalised in the DB query layer).
 *   - Custom JWT       → reads the array off the token; falls back to
 *     `['member']` when missing.
 *   - Dev token         → parses `dev:<email>:<role>` so test fixtures
 *     can flip between admin / non-admin.
 *
 * The check is purely role-based so it stays evaluable even before the
 * permission service has loaded; the SCIM token surface and other
 * admin-only routes either rely on the same array or an explicit
 * `adminAccess` permission check downstream. Returning a flat 403 here
 * (instead of the 404 used by `adminPathGuard` for path discovery) is
 * intentional — the caller has already proven they hold a session, so
 * the failure mode is "you're authenticated but not authorised", not
 * "this route doesn't exist".
 */
function requireAdmin(c: Context<AppEnv>) {
  const auth = c.get('auth');
  const roles = Array.isArray(auth?.roles) ? (auth.roles as string[]) : [];
  if (!roles.includes('admin')) {
    return c.json(
      {
        errors: [
          {
            code: 'FORBIDDEN',
            message: 'Admin role required.',
          },
        ],
      },
      403,
    );
  }
  return null;
}

// ── helpers ────────────────────────────────────────────────────────────

/**
 * Resolve the active sliding-window seconds from the persisted
 * Lockout_Policy. We default to the Standard preset when the settings
 * row is missing or malformed so the unlock/unblock action still wipes
 * a sensible window (matching the LoginGuard's own fallback).
 */
async function resolveLockoutWindowSeconds(
  db: import('@lumibase/database').Database,
): Promise<number> {
  try {
    const policy = await loadLockoutPolicyFromSettings(db);
    return policy.lockoutWindowSeconds;
  } catch {
    return STANDARD_LOCKOUT_POLICY.lockoutWindowSeconds;
  }
}

/**
 * Surface a security event via `console.info` while task 11.2's real
 * AuditLogger is being built. The shape mirrors design §10.1 so the
 * eventual swap is a one-line replacement.
 */
function emitAuditEvent(
  c: Context<AppEnv>,
  event: 'user_unlocked' | 'ip_unblocked',
  metadata: Record<string, unknown>,
): void {
  const auth = c.get('auth');
  const requestId = c.get('requestId');
  // No Admin_Path is in scope here, but go through `maskAdminPath` so
  // any accidental future addition (e.g. metadata that includes a
  // request URL) is automatically masked at default log levels per
  // Req 5.5.
  const safeMetadata = maskAdminPath(metadata, null);
  // eslint-disable-next-line no-console
  console.info('[admin-security]', {
    event,
    actorEmail: auth?.email ?? null,
    actorUserId: auth?.userId ?? null,
    requestId: requestId ?? null,
    metadata: safeMetadata,
  });
}

// ── POST /unlock-user (Req 7.6; design §4.5) ───────────────────────────

adminSecurityRouter.post('/unlock-user', async (c) => {
  const forbidden = requireAdmin(c);
  if (forbidden) return forbidden;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      {
        errors: [
          { code: 'VALIDATION_ERROR', message: 'Body must be valid JSON.' },
        ],
      },
      400,
    );
  }

  const parsed = unlockUserSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        errors: [
          {
            code: 'VALIDATION_ERROR',
            message: 'Email is required and must be a valid address.',
          },
        ],
      },
      400,
    );
  }

  const db = c.get('db');
  const emailLower = normalizeEmail(parsed.data.email);
  if (emailLower.length === 0) {
    return c.json(
      { errors: [{ code: 'VALIDATION_ERROR', message: 'Email is empty.' }] },
      400,
    );
  }

  // 1. Confirm the user exists. The lookup is case-insensitive so a
  //    `Foo@Bar` row matches a `foo@bar` request body — same shape as
  //    the LoginGuard precheck (`middleware.ts`).
  const [existing] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(sql`lower(${users.email}) = ${emailLower}`)
    .limit(1);

  if (!existing) {
    return c.json(
      {
        errors: [
          {
            code: 'USER_NOT_FOUND',
            message: 'No user matches the supplied email.',
          },
        ],
      },
      404,
    );
  }

  // 2. Clear the lockout state on the user row. Mirror the columns
  //    `recordLoginSuccess` resets so admin unlocks and self-recovery
  //    by successful login leave the row in the same state.
  await db
    .update(users)
    .set({
      failedCount: 0,
      lockedUntil: null,
      failedCountWindowStart: null,
    })
    .where(eq(users.id, existing.id));

  // 3. Drain the sliding-window counter for this email so the next
  //    login attempt doesn't immediately re-lock the user. Scope to
  //    the active `lockoutWindowSeconds` — older rows are already
  //    out-of-window and would be filtered by the counter SQL anyway,
  //    but pruning them now keeps the deletion bounded.
  const windowSeconds = await resolveLockoutWindowSeconds(db);
  await db
    .delete(loginAttempts)
    .where(
      and(
        eq(loginAttempts.emailLower, emailLower),
        eq(loginAttempts.result, 'fail'),
        gte(
          loginAttempts.createdAt,
          sql`now() - (${String(windowSeconds)} || ' seconds')::interval`,
        ),
      ),
    );

  emitAuditEvent(c, 'user_unlocked', {
    targetUserId: existing.id,
    targetEmail: emailLower,
    windowSeconds,
  });

  return c.json({ data: { unlocked: true } });
});

// ── POST /unblock-ip (Req 7.7, 8.7; design §4.6) ───────────────────────

adminSecurityRouter.post('/unblock-ip', async (c) => {
  const forbidden = requireAdmin(c);
  if (forbidden) return forbidden;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      {
        errors: [
          { code: 'VALIDATION_ERROR', message: 'Body must be valid JSON.' },
        ],
      },
      400,
    );
  }

  const parsed = unblockIpSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        errors: [
          { code: 'VALIDATION_ERROR', message: 'Field "ip" is required.' },
        ],
      },
      400,
    );
  }

  // Validate using the same parser the trusted-proxy matcher uses —
  // accepts dotted IPv4, full / compressed IPv6, IPv4-mapped IPv6, and
  // strips zone identifiers. Anything else is `INVALID_IP`.
  const trimmed = parsed.data.ip.trim();
  const bytes = parseIpToBytes(trimmed);
  if (!bytes) {
    return c.json(
      {
        errors: [
          {
            code: 'INVALID_IP',
            message: 'IP must be a valid IPv4 or IPv6 address.',
          },
        ],
      },
      400,
    );
  }

  // Canonicalise loopback variants so `::ffff:127.0.0.1` matches the
  // `127.0.0.1` form `extractClientIp` actually writes into
  // `login_attempts.ip`. Non-loopback addresses pass through unchanged
  // (canonicalLoopback only normalises the two loopback forms by
  // contract — see `ip-extract.ts`).
  const ipCanonical = canonicalLoopback(trimmed);

  const db = c.get('db');
  const windowSeconds = await resolveLockoutWindowSeconds(db);

  // Drain the sliding-window counter for this IP. The counter is the
  // sole source of truth for IP blocks (design §6.4), so deleting
  // these rows is *the* unblock — no separate `ip_blocks` row to
  // touch.
  await db
    .delete(loginAttempts)
    .where(
      and(
        eq(loginAttempts.ip, ipCanonical),
        eq(loginAttempts.result, 'fail'),
        gte(
          loginAttempts.createdAt,
          sql`now() - (${String(windowSeconds)} || ' seconds')::interval`,
        ),
      ),
    );

  emitAuditEvent(c, 'ip_unblocked', {
    targetIp: ipCanonical,
    windowSeconds,
  });

  return c.json({ data: { unblocked: true } });
});
