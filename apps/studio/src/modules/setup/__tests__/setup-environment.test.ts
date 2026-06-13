import { describe, expect, it } from 'vitest';
import { shouldAutoRedirectToAdmin } from '../setup-environment';

describe('shouldAutoRedirectToAdmin', () => {
  it('allows admin convenience redirects in development', () => {
    expect(
      shouldAutoRedirectToAdmin({
        PROD: false,
        VITE_LUMIBASE_ALLOW_ADMIN_PATH_REDIRECT: undefined,
        VITE_LUMIBASE_RELEASE_CHANNEL: 'development',
      }),
    ).toBe(true);
  });

  it('blocks admin redirects in production builds', () => {
    expect(
      shouldAutoRedirectToAdmin({
        PROD: true,
        VITE_LUMIBASE_ALLOW_ADMIN_PATH_REDIRECT: undefined,
        VITE_LUMIBASE_RELEASE_CHANNEL: 'development',
      }),
    ).toBe(false);
  });

  it('blocks admin redirects when the release channel is production', () => {
    expect(
      shouldAutoRedirectToAdmin({
        PROD: false,
        VITE_LUMIBASE_ALLOW_ADMIN_PATH_REDIRECT: undefined,
        VITE_LUMIBASE_RELEASE_CHANNEL: ' production ',
      }),
    ).toBe(false);
  });

  it('allows an explicit setup/debug override', () => {
    expect(
      shouldAutoRedirectToAdmin({
        PROD: true,
        VITE_LUMIBASE_ALLOW_ADMIN_PATH_REDIRECT: ' true ',
        VITE_LUMIBASE_RELEASE_CHANNEL: 'production',
      }),
    ).toBe(true);
  });
});
