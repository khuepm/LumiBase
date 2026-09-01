/**
 * Identity of the site the setup wizard creates on first run.
 *
 * Fixed rather than generated so a re-entrant wizard run (e.g. after a
 * crash mid-initialize) is idempotent, and so instance-wide rows —
 * settings that belong to the deployment rather than to a tenant — have
 * one stable place to live. Extracted from `SetupService` because the
 * login-guard policy reader needs the same id to resolve the
 * instance-wide Lockout_Policy deterministically (design open question 8).
 */
export const DEFAULT_SITE_ID = '__default__';
