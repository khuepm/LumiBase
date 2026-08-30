/**
 * RFC 6238 TOTP helpers (Web Crypto HMAC-SHA1, no external deps).
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DEFAULT_PERIOD = 30;
const DEFAULT_DIGITS = 6;
const DEFAULT_WINDOW = 1;

function bytesEqualConstantTime(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function stringEqualConstantTime(a: string, b: string): boolean {
  const enc = new TextEncoder();
  return bytesEqualConstantTime(enc.encode(a), enc.encode(b));
}

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i]!;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(input: string): Uint8Array {
  const cleaned = input.replace(/=+$/g, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error('Invalid base32 character.');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** Generate a 20-byte (160-bit) random secret encoded as base32. */
export function generateTotpSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return base32Encode(bytes);
}

export function buildOtpAuthUri(options: {
  issuer: string;
  accountName: string;
  secret: string;
  digits?: number;
  period?: number;
}): string {
  const issuer = encodeURIComponent(options.issuer);
  const label = encodeURIComponent(`${options.issuer}:${options.accountName}`);
  const digits = options.digits ?? DEFAULT_DIGITS;
  const period = options.period ?? DEFAULT_PERIOD;
  return `otpauth://totp/${label}?secret=${options.secret}&issuer=${issuer}&digits=${digits}&period=${period}`;
}

async function hotp(secret: Uint8Array, counter: number, digits: number): Promise<string> {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  const high = Math.floor(counter / 0x100000000);
  const low = counter >>> 0;
  view.setUint32(0, high, false);
  view.setUint32(4, low, false);

  const keyMaterial = Uint8Array.from(secret);
  const key = await crypto.subtle.importKey(
    'raw',
    keyMaterial,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf));
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) |
    ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) |
    (mac[offset + 3]! & 0xff);
  const otp = (binary % 10 ** digits).toString().padStart(digits, '0');
  return otp;
}

export function currentTotpStep(nowMs = Date.now(), period = DEFAULT_PERIOD): number {
  return Math.floor(nowMs / 1000 / period);
}

export interface TotpVerifyResult {
  valid: boolean;
  step?: number;
}

export async function verifyTotpCode(
  base32Secret: string,
  code: string,
  options?: {
    digits?: number;
    period?: number;
    window?: number;
    lastUsedStep?: number | null;
    nowMs?: number;
  },
): Promise<TotpVerifyResult> {
  const digits = options?.digits ?? DEFAULT_DIGITS;
  const period = options?.period ?? DEFAULT_PERIOD;
  const window = options?.window ?? DEFAULT_WINDOW;
  const nowMs = options?.nowMs ?? Date.now();
  const normalized = code.trim();
  if (!/^\d+$/.test(normalized) || normalized.length !== digits) {
    return { valid: false };
  }

  let secretBytes: Uint8Array;
  try {
    secretBytes = base32Decode(base32Secret);
  } catch {
    return { valid: false };
  }

  const currentStep = currentTotpStep(nowMs, period);
  for (let offset = -window; offset <= window; offset++) {
    const step = currentStep + offset;
    if (options?.lastUsedStep != null && step <= options.lastUsedStep) continue;
    const expected = await hotp(secretBytes, step, digits);
    if (stringEqualConstantTime(expected, normalized)) {
      return { valid: true, step };
    }
  }
  return { valid: false };
}

const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Mint an `XXXX-XXXX` recovery code (same shape as bootstrap backup codes). */
export function generateRecoveryCode(): string {
  const alphabetLen = RECOVERY_ALPHABET.length;
  const unbiasedUpperBound = Math.floor(256 / alphabetLen) * alphabetLen;
  let raw = '';
  while (raw.length < 16) {
    const buf = crypto.getRandomValues(new Uint8Array(16));
    for (let i = 0; i < buf.length && raw.length < 16; i++) {
      const byte = buf[i]!;
      if (byte >= unbiasedUpperBound) continue;
      raw += RECOVERY_ALPHABET[byte % alphabetLen];
    }
  }
  return `${raw.slice(0, 8)}-${raw.slice(8, 16)}`;
}

export function normalizeRecoveryCode(input: string): string {
  return input.trim().toUpperCase().replace(/\s+/g, '');
}
