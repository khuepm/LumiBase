/**
 * Audit-context middleware (admin-setup-wizard task 11.2; Req 15.1,
 * 15.2; design §6.2, §10.1).
 *
 * The design's middleware ordering (§6.2) places an `auditContext`
 * step right after the request-id step and before the
 * `adminPathGuard`:
 *
 * ```
 * app.use('*', requestId)      // sinh requestId, gắn vào ctx
 * app.use('*', auditContext)   // attach { ip, userAgent, requestId } vào ctx
 * app.use('*', adminPathGuard) // ...
 * ```
 *
 * `requestId` is already stashed on the context by {@link
 * import('./logger').withLogger} (it sets `c.set('requestId', ...)`),
 * so this middleware's remaining job is to resolve and stash the other
 * two audit dimensions — the client IP and the User-Agent — onto the
 * Hono context. With all three present, every downstream handler and
 * every `AuditLogger.write` caller (the LoginGuard hooks, the
 * admin-security routes, the recovery service, the setup service) can
 * read `c.get('ip')`, `c.get('userAgent')`, and `c.get('requestId')`
 * uniformly without re-deriving them per call site (Req 15.2).
 *
 * ── Why reuse `extractClientIp` ──────────────────────────────────────────
 *
 * The IP is resolved with {@link
 * import('../modules/login-guard/ip-extract').extractClientIp} — the
 * SAME helper the LoginGuard uses to WRITE `login_attempts.ip` and the
 * recovery routes use for their rate-limit key. Reusing it keeps the
 * audit trail's `ip` column in the exact canonical form (trusted-proxy
 * resolution, loopback canonicalisation) that the rest of the security
 * surface already agrees on, so an audit entry's IP joins cleanly
 * against a `login_attempts` row (Req 8.4 / design §6.1). We do NOT
 * pass a `getRemoteAddress` resolver here: on the global chain we only
 * have the Hono context, and the production deploys surface the client
 * IP via `CF-Connecting-IP` (Workers) or `X-Forwarded-For` from a
 * trusted proxy (Node behind a reverse proxy) — both header-based, so
 * the extractor resolves them without a socket adapter. When no signal
 * survives, `extractClientIp` returns the literal `'unknown'`, which we
 * stash as-is (it is intentionally not a valid IP, so it can never
 * collide with a real address in the audit trail).
 *
 * ── User-Agent ────────────────────────────────────────────────────────────
 *
 * The raw `User-Agent` header is stored verbatim (`undefined` when
 * absent) — the audit schema's `userAgent` column is free text and the
 * forensic value is in the raw string. No masking is applied here; the
 * AuditLogger's {@link import('../modules/audit/logger').maskSensitive}
 * only touches the four secret KEYS in `metadata` (Req 15.3), and a UA
 * is not a secret.
 *
 * ── Ordering note ─────────────────────────────────────────────────────────
 *
 * Mounted in `apps/cms/src/index.ts` just before `adminPathGuard`
 * (after the `withLogger` / `withMetrics` / `withRuntime` / `cors`
 * block), matching design §6.2's "between requestId and
 * adminPathGuard" placement so the guard — and every route below it —
 * runs with the audit context already populated.
 *
 * **Validates: Requirements 15.1, 15.2**
 *
 * References: requirements §15.1, §15.2; design.md §6.2, §10.1.
 */

import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env';
import { extractClientIp } from '../modules/login-guard/ip-extract';

/**
 * Populate `{ ip, userAgent }` on the Hono context for the current
 * request (`requestId` is already set upstream by {@link
 * import('./logger').withLogger}). Mirrors the `withLogger` middleware
 * style: a thin factory returning the handler so it reads
 * `app.use('*', withAuditContext())` at the mount site.
 */
export const withAuditContext = (): MiddlewareHandler<AppEnv> => async (
  c,
  next,
) => {
  // Resolve the client IP through the shared extractor so the audit
  // trail's `ip` matches the LoginGuard's `login_attempts.ip` form.
  c.set('ip', extractClientIp(c));
  // Store the raw User-Agent verbatim; `undefined` when the header is
  // absent (the audit column is nullable free text).
  c.set('userAgent', c.req.header('user-agent') ?? undefined);
  await next();
};
