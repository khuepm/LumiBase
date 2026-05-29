/**
 * Constant-time admin path comparison.
 *
 * Implements Req 5.7 ("THE Admin_Path_Guard SHALL có constant-time
 * string comparison khi so sánh path để tránh timing attack tiết lộ
 * tiền tố") on top of the algorithm pinned in design.md §7.1. The
 * upstream consumer is the `adminPathGuard` middleware (task 4.2):
 * for every incoming request that lands in the Studio scope, the
 * request path is compared against `system_state.admin_path` using
 * this helper before the route is dispatched. A non-constant-time
 * comparison (e.g. `===` or even `Buffer.compare`) leaks the longest
 * matching prefix through CPU branch-predictor / cache timing, which
 * over enough samples lets an attacker recover the secret path one
 * character at a time — exactly the "Hide Login" pattern this feature
 * is meant to defend against.
 *
 * Algorithm (verbatim per design.md §7.1, kept short on purpose so it
 * fits in CPU cache and runs in a fixed number of operations):
 *
 *   1. Encode each string as UTF-8 truncated to 64 bytes — admin paths
 *      are validated upstream against `^/[a-z0-9][a-z0-9-]{2,62}[a-z0-9]$`
 *      so the slug fits ASCII and the leading slash + slug fit in 64
 *      bytes for every accepted shape.
 *   2. Pad each encoded buffer with zero bytes to a fixed 64-byte
 *      length so the compare loop runs the same number of iterations
 *      regardless of input length (no early exit, no length-dependent
 *      branch).
 *   3. Seed the running XOR accumulator with `a.length ^ b.length`.
 *      Without this seed, two same-byte buffers padded from different
 *      starting lengths (e.g. `/abc` vs `/abc\0`) would compare equal
 *      after step 4 even though the strings differ — Property 6 calls
 *      this out as the "length-XOR" guard.
 *   4. XOR every one of the 64 byte pairs into the accumulator. The
 *      result is `0` iff the buffers are identical.
 *
 * Return value: `true` only when both the accumulated byte XOR and
 * the length XOR are zero. The function does not throw — a non-string
 * input (e.g. `undefined`) is coerced into the empty string before
 * encoding so the caller's type contract failures still produce a
 * `false` result rather than a 500 inside the guard.
 *
 * Sync vs async: the design pseudo-code uses `Promise<boolean>`, but
 * keeping the helper synchronous is intentional. There is no async
 * I/O involved, and a microtask hop between the encode and the XOR
 * loop introduces scheduling jitter that actively works against the
 * timing invariant we want (Property 6 / `path-compare.timing.test.ts`
 * in task 4.6). The middleware in task 4.2 calls this from the hot
 * path of every request, so cutting the unnecessary `await` also
 * trims a few microseconds of overhead per request.
 *
 * **Validates: Requirements 5.7**
 * **Validates: Property 6 (Constant-Time Path Compare)**
 *
 * References: design.md §7.1, §13.3 Property 6.
 */

/**
 * Fixed compare buffer width in bytes. Must be at least the length of
 * any valid admin path (max 64 bytes after upstream validation: 1
 * leading slash + ≤63 ASCII slug bytes from the Req 4.2 regex bound
 * `[a-z0-9-]{2,62}` plus its two anchors).
 */
const COMPARE_BUFFER_SIZE = 64;

/** Single shared encoder. `TextEncoder` is stateless and safe to reuse. */
const utf8 = new TextEncoder();

/**
 * Pad `s` (UTF-8 encoded) into a fresh `Uint8Array` of exactly
 * {@link COMPARE_BUFFER_SIZE} bytes. Bytes beyond the buffer width are
 * truncated; bytes short of the width are left as the zero-init from
 * the typed array constructor. A new buffer is allocated per call so
 * callers don't share mutable state across concurrent requests.
 */
function padTo64(s: string): Uint8Array {
  const buf = new Uint8Array(COMPARE_BUFFER_SIZE);
  // `String.prototype.slice` works on UTF-16 code units, but since
  // valid admin paths are ASCII the per-codepoint and per-byte cost
  // are equivalent; for non-ASCII inputs we still trim to the buffer
  // width via `encodeInto` so we never overflow.
  const encoded = utf8.encode(s.slice(0, COMPARE_BUFFER_SIZE));
  buf.set(encoded.subarray(0, COMPARE_BUFFER_SIZE));
  return buf;
}

/**
 * Compare two paths in (input-length-independent) constant time.
 *
 * Returns `true` iff `a` and `b` are byte-equal once both have been
 * encoded as UTF-8 and padded to {@link COMPARE_BUFFER_SIZE} bytes,
 * AND their original `String#length` values match.
 *
 * The function performs a fixed amount of work — one `TextEncoder.encode`
 * per side, one allocation per side, and exactly
 * {@link COMPARE_BUFFER_SIZE} XOR-OR operations — so its runtime does
 * not depend on the position of the first differing byte. See
 * `__tests__/path-compare.test.ts` for the byte-level correctness
 * suite and `path-compare.timing.test.ts` (task 4.6) for the empirical
 * timing variance check.
 */
export function pathEqualsConstantTime(a: string, b: string): boolean {
  // Coerce non-strings to empty so callers' type-system slips don't
  // throw inside the middleware. The length-XOR seed below still
  // catches the diff between e.g. `'/lumi'` (5) and `''` (0).
  const sa = typeof a === 'string' ? a : '';
  const sb = typeof b === 'string' ? b : '';

  const A = padTo64(sa);
  const B = padTo64(sb);

  // Seed with the length XOR (Property 6 length-leak protection):
  // without this, padding a shorter string with zero bytes would let
  // it compare equal to a longer string whose tail is also zero bytes.
  let diff = sa.length ^ sb.length;
  // Unrolled-style straight loop: no `break`, no length-dependent
  // branch inside the body. Bitwise OR into `diff` accumulates any
  // mismatch without short-circuiting.
  for (let i = 0; i < COMPARE_BUFFER_SIZE; i++) {
    diff |= (A[i] as number) ^ (B[i] as number);
  }

  return diff === 0;
}

/** Re-exported for tests that want to assert the buffer width contract. */
export const __COMPARE_BUFFER_SIZE_FOR_TESTS = COMPARE_BUFFER_SIZE;
