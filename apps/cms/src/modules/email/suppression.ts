/**
 * Email suppression list (CAN-SPAM, ePrivacy).
 *
 * Holds opt-out / suppressed recipients per site. The send path must call
 * {@link SuppressionService.isSuppressed} before dispatching commercial email,
 * and {@link SuppressionService.filter} to strip suppressed addresses from a
 * recipient list.
 *
 * Unsubscribe links are stateless: {@link createUnsubscribeToken} signs a
 * `{ siteId, email }` claim with the deployment's `JWT_SECRET` (HS256, no
 * expiry — unsubscribe links must keep working), and the public endpoint calls
 * {@link verifyUnsubscribeToken} before recording the opt-out.
 */

import type { Database } from '@lumibase/database';
import { emailSuppressions } from '@lumibase/database';
import { and, eq, inArray } from 'drizzle-orm';
import { SignJWT, jwtVerify } from 'jose';
import { normalizeEmail } from '../login-guard/email-normalize';

const UNSUBSCRIBE_PURPOSE = 'email_unsubscribe';

export interface UnsubscribeClaims {
  siteId: string;
  email: string;
}

/** Sign a stateless unsubscribe token (HS256, no expiry). */
export async function createUnsubscribeToken(
  claims: UnsubscribeClaims,
  secret: string,
): Promise<string> {
  const key = new TextEncoder().encode(secret);
  return new SignJWT({ siteId: claims.siteId, email: normalizeEmail(claims.email) })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(UNSUBSCRIBE_PURPOSE)
    .setIssuedAt()
    .sign(key);
}

/** Verify an unsubscribe token; returns claims or `null` if invalid. */
export async function verifyUnsubscribeToken(
  token: string,
  secret: string,
): Promise<UnsubscribeClaims | null> {
  try {
    const key = new TextEncoder().encode(secret);
    const { payload } = await jwtVerify(token, key, { subject: UNSUBSCRIBE_PURPOSE });
    const siteId = typeof payload.siteId === 'string' ? payload.siteId : null;
    const email = typeof payload.email === 'string' ? payload.email : null;
    if (!siteId || !email) return null;
    return { siteId, email };
  } catch {
    return null;
  }
}

/** Build a public unsubscribe URL from a base origin and token. */
export function buildUnsubscribeUrl(baseUrl: string, token: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}/api/v1/email/unsubscribe?token=${encodeURIComponent(token)}`;
}

export interface SuppressionServiceDeps {
  db: Database;
  now?: () => Date;
}

export class SuppressionService {
  private readonly db: Database;
  private readonly now: () => Date;

  constructor(deps: SuppressionServiceDeps) {
    this.db = deps.db;
    this.now = deps.now ?? (() => new Date());
  }

  /** True if the given email is suppressed for the site. */
  async isSuppressed(params: { siteId: string; email: string }): Promise<boolean> {
    const emailLower = normalizeEmail(params.email);
    if (!emailLower) return false;
    const rows = await this.db
      .select({ id: emailSuppressions.id })
      .from(emailSuppressions)
      .where(
        and(
          eq(emailSuppressions.siteId, params.siteId),
          eq(emailSuppressions.emailLower, emailLower),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** Strip suppressed addresses from a recipient list. */
  async filter(params: { siteId: string; emails: readonly string[] }): Promise<string[]> {
    const normalized = params.emails.map((e) => ({ raw: e, lower: normalizeEmail(e) }));
    const lowers = normalized.map((n) => n.lower).filter(Boolean);
    if (lowers.length === 0) return [];
    const suppressed = await this.db
      .select({ emailLower: emailSuppressions.emailLower })
      .from(emailSuppressions)
      .where(
        and(
          eq(emailSuppressions.siteId, params.siteId),
          inArray(emailSuppressions.emailLower, lowers),
        ),
      );
    const blocked = new Set(suppressed.map((r) => r.emailLower));
    return normalized.filter((n) => n.lower && !blocked.has(n.lower)).map((n) => n.raw);
  }

  /** Add an address to the suppression list (idempotent). */
  async suppress(params: {
    siteId: string;
    email: string;
    reason?: string;
    source?: string;
  }): Promise<{ emailLower: string; alreadySuppressed: boolean }> {
    const emailLower = normalizeEmail(params.email);
    const before = await this.isSuppressed({ siteId: params.siteId, email: emailLower });
    await this.db
      .insert(emailSuppressions)
      .values({
        siteId: params.siteId,
        emailLower,
        reason: params.reason ?? 'unsubscribe',
        source: params.source ?? null,
      })
      .onConflictDoNothing({
        target: [emailSuppressions.siteId, emailSuppressions.emailLower],
      });
    return { emailLower, alreadySuppressed: before };
  }

  /** Remove an address from the suppression list (re-subscribe). */
  async unsuppress(params: { siteId: string; email: string }): Promise<boolean> {
    const emailLower = normalizeEmail(params.email);
    const deleted = await this.db
      .delete(emailSuppressions)
      .where(
        and(
          eq(emailSuppressions.siteId, params.siteId),
          eq(emailSuppressions.emailLower, emailLower),
        ),
      )
      .returning({ id: emailSuppressions.id });
    return deleted.length > 0;
  }

  /** List all suppressed addresses for a site. */
  list(params: { siteId: string }) {
    return this.db
      .select()
      .from(emailSuppressions)
      .where(eq(emailSuppressions.siteId, params.siteId));
  }
}
