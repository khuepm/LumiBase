/**
 * Constant-time string comparison for webhook signature / token checks.
 *
 * Compares the UTF-8 bytes of two strings without early-exit so an attacker
 * cannot learn how many leading characters matched from timing. Length
 * differences still short-circuit (the length itself is not secret), but the
 * byte loop always runs to completion over the longer input.
 */
export function constantTimeEqualStr(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  // Mix the length difference into the accumulator so equal-length-but-different
  // and different-length inputs both return false via the same path.
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}
