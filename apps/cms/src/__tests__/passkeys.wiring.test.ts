import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #735 wiring tripwires. The passkey sign-in endpoints run before the caller
 * has a session, so — like `/auth/verify-totp` — they must sit in all three
 * public sets, and the routers must be attached before `/auth` and `/me` are
 * mounted (see router-mount-order.wiring.test.ts for why).
 */

const read = (rel: string) => readFileSync(resolve(__dirname, '..', rel), 'utf8');
const PUBLIC = ['/api/v1/auth/passkey/options', '/api/v1/auth/passkey/verify'];

describe('passkey wiring', () => {
  it.each(['middleware/auth.ts', 'middleware/site-membership.ts', 'middleware/studio-access.ts'])(
    '%s lists the passkey sign-in paths as public',
    (file) => {
      const src = read(file);
      for (const p of PUBLIC) expect(src).toContain(`'${p}'`);
    },
  );

  it('attaches the passkey routers before /auth and /me are mounted', () => {
    const src = read('index.ts');
    const pos = (s: string) => {
      const i = src.indexOf(s);
      expect(i, `${s} not found`).toBeGreaterThan(-1);
      return i;
    };
    expect(pos("authRouter.route('/', passkeyAuthRouter)")).toBeLessThan(pos("api.route('/auth', authRouter)"));
    expect(pos("meRouter.route('/', passkeyMeRouter)")).toBeLessThan(pos("api.route('/me', meRouter)"));
  });

  it('the /me management routes stay behind withAuth (not in the bypass list)', () => {
    expect(read('middleware/auth.ts')).not.toContain('/api/v1/me/passkeys');
  });
});
