/**
 * Operator token gate for the ops diagnostics plane
 * (`.kiro/specs/ops-diagnostics/design.md` — Trust boundary).
 *
 * `LUMIBASE_OPS_TOKEN` is a static bearer secret, separate from
 * `METRICS_TOKEN` because the ops routes expose error messages and schema
 * names. Unset means the plane does not exist: every route answers the
 * canonical 404, in every environment (no dev fallback).
 */
import type { AppEnv } from '../../env';

/** Below this length a token is treated as unset (guards against `"x"` / `"changeme"`). */
export const MIN_OPS_TOKEN_LENGTH = 32;

function processEnvValue(key: string): string | undefined {
  try {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    return env?.[key];
  } catch {
    return undefined;
  }
}

export function resolveOpsToken(env: AppEnv['Bindings'] | undefined): string | undefined {
  const token = env?.LUMIBASE_OPS_TOKEN || processEnvValue('LUMIBASE_OPS_TOKEN');
  return token && token.length >= MIN_OPS_TOKEN_LENGTH ? token : undefined;
}

function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer') return null;
  const token = rest.join(' ').trim();
  return token.length > 0 ? token : null;
}

function constantTimeEqual(a: string, b: string): boolean {
  const max = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < max; i += 1) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export function isOpsAuthorized(env: AppEnv['Bindings'] | undefined, authorization: string | undefined): boolean {
  const expected = resolveOpsToken(env);
  if (!expected) return false;
  const actual = bearer(authorization);
  return actual !== null && constantTimeEqual(actual, expected);
}
