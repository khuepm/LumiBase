import { describe, expect, it } from 'vitest';
import type { Database } from '@lumibase/database';
import { SetupService } from '../service';

/**
 * `GET /setup/capabilities` reports whether an AEAD key is resolvable.
 *
 * Why the wizard needs it: without a key, TOTP enrollment and encrypted item
 * fields simply do not work, and the first sign used to be a `503` from
 * Settings → Security long after setup had finished. Production already
 * refuses to boot without `ENCRYPTION_KEY` (`config/production.ts`), so this
 * covers every other runtime — local, Docker staging, a Workers preview.
 *
 * See issue #429 and `docs/en/operations/encryption-keys.md`.
 */

const db = {} as unknown as Database;

const svc = (encryptionAvailable: boolean) =>
  new SetupService({
    db,
    requireSetupToken: false,
    smtpAvailable: false,
    encryptionAvailable,
    geoipProbe: () => false,
  });

describe('setup capabilities — encryption', () => {
  it('reports available when a key is resolvable', async () => {
    await expect(svc(true).getCapabilities()).resolves.toMatchObject({
      encryption: { available: true },
    });
  });

  it('reports unavailable when no key is configured', async () => {
    await expect(svc(false).getCapabilities()).resolves.toMatchObject({
      encryption: { available: false },
    });
  });

  it('keeps the other probes independent', async () => {
    // A missing encryption key must not drag geoip/smtp down with it — the
    // wizard renders one notice per capability and they have separate causes.
    const caps = await svc(false).getCapabilities();
    expect(caps).toEqual({
      geoip: { available: false },
      smtp: { available: false },
      encryption: { available: false },
    });
  });
});
