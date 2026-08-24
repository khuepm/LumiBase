import { describe, expect, it } from 'vitest';
import {
  base32Encode,
  base32Decode,
  generateTotpSecret,
  verifyTotpCode,
  currentTotpStep,
} from '../totp';

describe('totp', () => {
  it('round-trips base32', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const enc = base32Encode(bytes);
    expect(base32Decode(enc)).toEqual(bytes);
  });

  it('verifies a generated secret for the current step', async () => {
    const secret = generateTotpSecret();
    const secretBytes = base32Decode(secret);
    const step = currentTotpStep();
    const keyMaterial = Uint8Array.from(secretBytes);
    const key = await crypto.subtle.importKey('raw', keyMaterial, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    view.setUint32(4, step >>> 0, false);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf));
    const offset = mac[mac.length - 1]! & 0x0f;
    const binary =
      ((mac[offset]! & 0x7f) << 24) |
      ((mac[offset + 1]! & 0xff) << 16) |
      ((mac[offset + 2]! & 0xff) << 8) |
      (mac[offset + 3]! & 0xff);
    const code = (binary % 1_000_000).toString().padStart(6, '0');

    const result = await verifyTotpCode(secret, code);
    expect(result.valid).toBe(true);
    expect(result.step).toBe(step);
  });

  it('rejects replay within the same step', async () => {
    const secret = generateTotpSecret();
    const step = currentTotpStep();
    const secretBytes = base32Decode(secret);
    const keyMaterial = Uint8Array.from(secretBytes);
    const key = await crypto.subtle.importKey('raw', keyMaterial, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    view.setUint32(4, step >>> 0, false);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf));
    const offset = mac[mac.length - 1]! & 0x0f;
    const binary =
      ((mac[offset]! & 0x7f) << 24) |
      ((mac[offset + 1]! & 0xff) << 16) |
      ((mac[offset + 2]! & 0xff) << 8) |
      (mac[offset + 3]! & 0xff);
    const code = (binary % 1_000_000).toString().padStart(6, '0');

    const first = await verifyTotpCode(secret, code, { lastUsedStep: null });
    expect(first.valid).toBe(true);
    const replay = await verifyTotpCode(secret, code, { lastUsedStep: first.step });
    expect(replay.valid).toBe(false);
  });
});
