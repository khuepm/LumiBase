import { describe, expect, it } from 'vitest';
import { isOpsAuthorized, MIN_OPS_TOKEN_LENGTH } from '../token';

const TOKEN = 'o'.repeat(MIN_OPS_TOKEN_LENGTH);
const env = (t?: string) => ({ LUMIBASE_OPS_TOKEN: t }) as never;

describe('isOpsAuthorized', () => {
  it('is closed when the token is unset, in every environment', () => {
    expect(isOpsAuthorized(env(undefined), `Bearer ${TOKEN}`)).toBe(false);
    expect(isOpsAuthorized({ LUMIBASE_ENV: 'development' } as never, undefined)).toBe(false);
  });

  it('treats a too-short token as unset', () => {
    expect(isOpsAuthorized(env('changeme'), 'Bearer changeme')).toBe(false);
  });

  it('accepts only the exact bearer token', () => {
    expect(isOpsAuthorized(env(TOKEN), `Bearer ${TOKEN}`)).toBe(true);
    expect(isOpsAuthorized(env(TOKEN), `bearer ${TOKEN}`)).toBe(true);
    expect(isOpsAuthorized(env(TOKEN), `Bearer ${TOKEN}x`)).toBe(false);
    expect(isOpsAuthorized(env(TOKEN), TOKEN)).toBe(false);
    expect(isOpsAuthorized(env(TOKEN), undefined)).toBe(false);
  });
});
