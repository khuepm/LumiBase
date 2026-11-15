/**
 * New-device sign-in detection + notification (#739, epic #674 S10).
 *
 * ── What counts as a "device" ─────────────────────────────────────────────
 * The device fingerprint the anomaly detector already uses
 * (`anomaly/device.ts`: SHA-256 of the version-stripped User-Agent + the
 * `Accept-Language` header, 16 hex chars), and the per-user LRU of known
 * fingerprints it already keeps in `lumibase_login_baselines
 * .device_fingerprints` (cap 20). No new table: this module only reads that
 * baseline BEFORE the success hook folds the current attempt into it.
 *
 * The IP is deliberately NOT part of the device key: mobile and home IPs
 * change daily, so keying on them would mail users on every network change
 * and teach them to ignore the email. The IP is reported in the email and
 * the history instead.
 *
 * Because the anomaly device subscore is optional per Lockout_Policy, the
 * route may reach the success hook without a fingerprint on the draft;
 * {@link detectNewDevice} fills it in, so the baseline learns devices even
 * when the device subscore is off.
 *
 * ── When it is "new" ─────────────────────────────────────────────────────
 *   - the account has at least one earlier successful sign-in, AND
 *   - the baseline already knows at least one device (so the first sign-in
 *     after upgrading, for an account whose devices were never recorded,
 *     is learned silently instead of mailing every user once), AND
 *   - the fingerprint is not in the LRU.
 * A missing User-Agent never counts as a new device.
 *
 * ── Notification ──────────────────────────────────────────────────────────
 * {@link notifyNewDeviceSignIn} runs detached from the response
 * (`runDetached`: `waitUntil` on Workers, fire-and-forget on Docker), so the
 * sign-in never waits on SMTP and the email leaves within seconds. It is
 * rate-limited per user ({@link NEW_DEVICE_EMAIL_LIMIT} per
 * {@link NEW_DEVICE_EMAIL_WINDOW_SECONDS}); a suppressed email is still
 * recorded as a `new_device_login` audit event (`notified: false`) so the
 * history shows the device either way. Nothing here changes the login
 * response, its status or its timing, so it cannot reveal whether an
 * account exists.
 */

import type { Context } from 'hono';
import type { Database } from '@lumibase/database';
import type { RateLimiterProvider } from '@lumibase/runtime';
import { MemoryRateLimiter } from '@lumibase/runtime';
import { approximateIp, describeUserAgent } from '@lumibase/contracts';

import type { AppEnv } from '../../env';
import { runDetached } from '../../lib/detached';
import { consumeRateLimit } from '../../middleware/rate-limit-helper';
import { fingerprint as deviceFingerprint, loadDeviceBaselineFromDb } from '../anomaly/device';
import type { DeviceBaselineSnapshot, LoginAttemptDraft } from '../anomaly/types';
import type { AuditLogWriteInput } from '../audit/logger';
import { AuditLogger } from '../audit/logger';
import { sendNewDeviceLoginEmail, type NewDeviceEmailResult } from '../email/new-device-login';

export const NEW_DEVICE_EMAIL_LIMIT = 3;
export const NEW_DEVICE_EMAIL_WINDOW_SECONDS = 60 * 60;

const fallbackLimiter = new MemoryRateLimiter();

export interface NewDeviceVerdict {
  readonly isNew: boolean;
  /** The device fingerprint, or null when the request carried no usable UA. */
  readonly fingerprint: string | null;
}

export interface DetectNewDeviceOptions {
  /** Override the baseline read (tests). */
  readonly loadBaseline?: (userId: string) => Promise<DeviceBaselineSnapshot | null>;
}

/** Pure decision over a loaded baseline (exported for unit tests). */
export function isNewDevice(baseline: DeviceBaselineSnapshot | null, fp: string): boolean {
  if (!baseline) return false;
  if (baseline.successfulLogins < 1) return false;
  if (baseline.deviceFingerprints.length === 0) return false;
  return !baseline.deviceFingerprints.some((entry) => entry.fp === fp);
}

/**
 * Decide whether this successful sign-in comes from a device not seen before.
 * Call it BEFORE `recordLoginSuccess` (which updates the baseline) and pass
 * the same `attempt` draft to that hook. Never throws: any failure is "not
 * new".
 */
export async function detectNewDevice(
  db: Database,
  userId: string,
  userAgent: string | null | undefined,
  acceptLanguage: string | null | undefined,
  attempt: LoginAttemptDraft,
  options: DetectNewDeviceOptions = {},
): Promise<NewDeviceVerdict> {
  let fp = typeof attempt.deviceFingerprint === 'string' ? attempt.deviceFingerprint : '';
  if (fp.length === 0) {
    try {
      fp = await deviceFingerprint(userAgent, acceptLanguage);
    } catch {
      fp = '';
    }
    if (fp.length === 0) return { isNew: false, fingerprint: null };
    // Let the success hook fold it into the baseline LRU.
    attempt.deviceFingerprint = fp;
    attempt.deviceLookupStatus = 'ok';
  }

  let baseline: DeviceBaselineSnapshot | null;
  try {
    baseline = await (options.loadBaseline ?? ((id: string) => loadDeviceBaselineFromDb(db, id)))(userId);
  } catch {
    return { isNew: false, fingerprint: fp };
  }
  return { isNew: isNewDevice(baseline, fp), fingerprint: fp };
}

export interface NewDeviceNoticeInput {
  readonly db: Database;
  readonly env: AppEnv['Bindings'];
  readonly rateLimiter?: RateLimiterProvider;
  readonly siteId: string;
  readonly userId: string;
  readonly email: string;
  readonly audience: string;
  readonly ip: string;
  readonly userAgent: string | null;
  readonly countryCode: string | null;
  readonly signedInAt: Date;
  readonly requestId?: string | null;
  /** Injected for tests; defaults to an `AuditLogger` on `db`/`siteId`. */
  readonly audit?: { write(entry: AuditLogWriteInput): Promise<void> };
  /** Injected for tests; defaults to {@link sendNewDeviceLoginEmail}. */
  readonly send?: typeof sendNewDeviceLoginEmail;
}

export interface NewDeviceNoticeOutcome {
  readonly notified: boolean;
  readonly reason?: 'rate_limited' | 'email_failed' | 'email_not_configured' | 'error';
}

/**
 * Rate-limit, send the email, then record a `new_device_login` audit event.
 * Never throws.
 */
export async function notifyNewDeviceSignIn(input: NewDeviceNoticeInput): Promise<NewDeviceNoticeOutcome> {
  const deviceLabel = describeUserAgent(input.userAgent).label;
  const ipApprox = approximateIp(input.ip);
  let outcome: NewDeviceNoticeOutcome;

  try {
    // Per-user budget. A rate-limit backend outage falls back to an
    // in-process limiter rather than to "unlimited".
    let rl = await consumeRateLimit(
      input.rateLimiter,
      `rl:new-device-email:user:${input.userId}`,
      NEW_DEVICE_EMAIL_LIMIT,
      NEW_DEVICE_EMAIL_WINDOW_SECONDS,
    );
    if (rl.status === 'unavailable') {
      rl = await consumeRateLimit(
        fallbackLimiter,
        `rl:new-device-email:user:${input.userId}`,
        NEW_DEVICE_EMAIL_LIMIT,
        NEW_DEVICE_EMAIL_WINDOW_SECONDS,
      );
    }

    if (rl.status === 'block') {
      outcome = { notified: false, reason: 'rate_limited' };
    } else {
      const send = input.send ?? sendNewDeviceLoginEmail;
      const result: NewDeviceEmailResult = await send({
        db: input.db,
        siteId: input.siteId,
        env: input.env,
        email: input.email,
        audience: input.audience,
        signedInAt: input.signedInAt,
        ipApprox,
        countryCode: input.countryCode,
        deviceLabel,
      });
      outcome = result.ok
        ? { notified: true }
        : { notified: false, reason: result.attempted ? 'email_failed' : 'email_not_configured' };
    }
  } catch {
    outcome = { notified: false, reason: 'error' };
  }

  try {
    const audit = input.audit ?? new AuditLogger({ db: input.db, siteId: input.siteId });
    await audit.write({
      event: 'new_device_login',
      actorEmail: input.email.toLowerCase(),
      targetEmail: input.email.toLowerCase(),
      ip: input.ip,
      userAgent: input.userAgent,
      countryCode: input.countryCode,
      requestId: input.requestId ?? null,
      metadata: {
        userId: input.userId,
        deviceLabel,
        notified: outcome.notified,
        ...(outcome.reason ? { suppressedReason: outcome.reason } : {}),
      },
    });
  } catch {
    // Best-effort; the sign-in already succeeded.
  }
  return outcome;
}

/**
 * Route glue: when `verdict.isNew`, run {@link notifyNewDeviceSignIn}
 * detached from the response. No-op otherwise.
 */
export function scheduleNewDeviceNotice(
  c: Context<AppEnv>,
  verdict: NewDeviceVerdict,
  input: Omit<NewDeviceNoticeInput, 'db' | 'env' | 'rateLimiter' | 'requestId' | 'signedInAt'> & {
    readonly signedInAt?: Date;
  },
): void {
  if (!verdict.isNew) return;
  let rateLimiter: RateLimiterProvider | undefined;
  try {
    rateLimiter = c.get('runtime')?.rateLimiter;
  } catch {
    rateLimiter = undefined;
  }
  const work = notifyNewDeviceSignIn({
    ...input,
    db: c.get('db'),
    env: c.env,
    rateLimiter,
    requestId: c.get('requestId') ?? null,
    signedInAt: input.signedInAt ?? new Date(),
  }).catch(() => undefined);
  runDetached(c, work);
}
