/**
 * Security history (#739, epic #674 S10) — the allow-list of audit events a
 * user may see about their own account, and the redaction that turns one
 * `lumibase_audit_log` row into a {@link SecurityHistoryItem}.
 *
 * Pure: no DB, no Hono. The query that decides WHICH rows belong to the
 * caller lives in `service.ts`; this file decides what of each row is shown.
 *
 * Redaction rules:
 *   - Only events in {@link HISTORY_EVENT_KINDS} are ever returned, under a
 *     friendly `kind` (the raw audit code is not exposed).
 *   - IPs are approximated (`approximateIp`).
 *   - When someone else performed the action (an admin unlocking the
 *     account), their IP and User-Agent are dropped — the history is about
 *     the caller, not about the staff member.
 *   - `details` holds a per-kind allow-list of metadata keys with checked
 *     types. Session ids, request ids, token ids, emails and anomaly scores
 *     are never copied.
 */

import {
  approximateIp,
  type SecurityHistoryItem,
  type SecurityHistoryKind,
} from '@lumibase/contracts';

/** Audit event code → friendly history kind. Anything else is never shown. */
export const HISTORY_EVENT_KINDS: Readonly<Record<string, SecurityHistoryKind>> = Object.freeze({
  login_success: 'sign_in',
  login_failed: 'sign_in_failed',
  mfa_verify_failed: 'mfa_challenge_failed',
  new_device_login: 'new_device',
  anomaly_triggered: 'suspicious_sign_in',
  user_locked: 'account_locked',
  user_unlocked: 'account_unlocked',
  password_changed: 'password_changed',
  password_reset_requested: 'password_reset_requested',
  password_reset_completed: 'password_reset',
  mfa_enrolled: 'mfa_enabled',
  mfa_disabled: 'mfa_disabled',
  session_revoked: 'session_revoked',
  sessions_revoked: 'sessions_revoked',
  refresh_token_reuse_detected: 'session_token_reuse',
});

/** The audit codes the history query filters on. */
export const HISTORY_EVENTS: readonly string[] = Object.freeze(Object.keys(HISTORY_EVENT_KINDS));

/** The subset of an audit row the redaction reads. */
export interface HistoryAuditRow {
  readonly id: string;
  readonly timestamp: Date;
  readonly siteId: string | null;
  readonly event: string;
  readonly actorEmail: string | null;
  readonly targetEmail: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly countryCode: string | null;
  readonly metadata: unknown;
}

const LOGIN_FAIL_REASONS = new Set([
  'invalid_credentials',
  'account_locked',
  'ip_blocked',
  'anomaly_lock',
  'mfa_required',
]);
const ANOMALY_ACTIONS = new Set(['notify_only', 'lock', 'require_mfa']);
const SIGN_IN_METHODS = new Set(['password', 'totp']);
const REVOKE_SCOPES = new Set(['all', 'others']);
const MAX_LABEL = 80;

type Details = SecurityHistoryItem['details'];

function meta(row: HistoryAuditRow): Record<string, unknown> {
  const m = row.metadata;
  if (m && typeof m === 'object' && !Array.isArray(m)) return m as Record<string, unknown>;
  if (typeof m === 'string') {
    try {
      const parsed: unknown = JSON.parse(m);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

function pickEnum(out: Details, key: string, value: unknown, allowed: ReadonlySet<string>): void {
  if (typeof value === 'string' && allowed.has(value)) out[key] = value;
}

function pickBool(out: Details, key: string, value: unknown): void {
  if (typeof value === 'boolean') out[key] = value;
}

function pickCount(out: Details, key: string, value: unknown): void {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) out[key] = value;
}

function detailsFor(kind: SecurityHistoryKind, m: Record<string, unknown>): Details {
  const out: Details = {};
  switch (kind) {
    case 'sign_in':
      pickEnum(out, 'method', m.method, SIGN_IN_METHODS);
      break;
    case 'sign_in_failed':
    case 'account_locked':
      pickEnum(out, 'reason', m.reason, LOGIN_FAIL_REASONS);
      break;
    case 'suspicious_sign_in':
      pickEnum(out, 'action', m.action, ANOMALY_ACTIONS);
      break;
    case 'new_device':
      if (typeof m.deviceLabel === 'string' && m.deviceLabel.length > 0) {
        out.deviceLabel = m.deviceLabel.slice(0, MAX_LABEL);
      }
      pickBool(out, 'notified', m.notified);
      break;
    case 'sessions_revoked':
      pickEnum(out, 'scope', m.scope, REVOKE_SCOPES);
      pickCount(out, 'revoked', m.revoked);
      break;
    case 'session_revoked':
      pickBool(out, 'current', m.current);
      break;
    case 'mfa_enabled':
      pickCount(out, 'revokedOtherSessions', m.revokedOtherSessions);
      break;
    case 'password_changed':
      pickBool(out, 'selfService', m.selfService);
      break;
    default:
      break;
  }
  return out;
}

/**
 * Redact one audit row for its subject. Returns `null` for an event outside
 * the allow-list (defence in depth — the query already filters on it).
 *
 * @param subjectEmail the caller's email; an action whose `actorEmail` is a
 *        different address was performed by someone else.
 */
export function toHistoryItem(
  row: HistoryAuditRow,
  subjectEmail: string,
): SecurityHistoryItem | null {
  const kind = Object.prototype.hasOwnProperty.call(HISTORY_EVENT_KINDS, row.event)
    ? HISTORY_EVENT_KINDS[row.event]
    : undefined;
  if (!kind) return null;

  const actor = row.actorEmail?.trim().toLowerCase() ?? '';
  const byOther = actor.length > 0 && actor !== subjectEmail.trim().toLowerCase();

  return {
    id: row.id,
    kind,
    occurredAt: row.timestamp.toISOString(),
    siteId: row.siteId,
    ipApprox: byOther ? null : approximateIp(row.ip),
    userAgent: byOther ? null : row.userAgent ? row.userAgent.slice(0, 512) : null,
    countryCode:
      !byOther && typeof row.countryCode === 'string' && /^[A-Z]{2}$/i.test(row.countryCode)
        ? row.countryCode.toUpperCase()
        : null,
    details: detailsFor(kind, meta(row)),
  };
}
