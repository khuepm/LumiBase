/**
 * Shared `emailRoot` fixtures (#794). Used by the unit test (TS only) and by
 * the DB integration test, which asserts SQL `lumibase_email_root()` returns
 * the same value for every input — so the two implementations cannot drift.
 */
export const EMAIL_ROOT_FIXTURES: ReadonlyArray<readonly [input: string, root: string]> = [
  // case + whitespace folding only
  ['Foo@Example.com', 'foo@example.com'],
  ['  foo@example.com  ', 'foo@example.com'],
  // #862: SQL trims the same set as JS trim() — not only U+0020
  ['\tfoo@example.com\n', 'foo@example.com'],
  ['\r\n Foo+x@Example.com \v\f', 'foo@example.com'],
  ['\u00a0foo@example.com\u00a0', 'foo@example.com'],
  ['\u3000\u2003foo@example.com\u202f\u205f', 'foo@example.com'],
  ['\ufefffoo@example.com\u2028\u2029', 'foo@example.com'],
  ['\u1680f.oo@gmail.com\u200a', 'foo@gmail.com'],
  // U+0085 and U+200B are not trim() whitespace: kept on both sides
  ['\u200bfoo@example.com', '\u200bfoo@example.com'],
  ['foo@example.com\u0085', 'foo@example.com\u0085'],
  // +tag stripped on every domain
  ['foo+news@example.com', 'foo@example.com'],
  ['foo+a+b@example.com', 'foo@example.com'],
  ['foo+@example.com', 'foo@example.com'],
  ['First.Last+tag@Company.co.uk', 'first.last@company.co.uk'],
  // dots only matter on Gmail
  ['f.o.o@example.com', 'f.o.o@example.com'],
  ['f.o.o@gmail.com', 'foo@gmail.com'],
  ['F.O.O+promo@GMail.com', 'foo@gmail.com'],
  // googlemail.com folds to gmail.com
  ['foo@googlemail.com', 'foo@gmail.com'],
  ['f.oo+x@googlemail.com', 'foo@gmail.com'],
  // a leading `+` is kept: the local part never becomes empty
  ['+foo@example.com', '+foo@example.com'],
  ['+foo+bar@example.com', '+foo+bar@example.com'],
  // an all-dots Gmail local part keeps its dots rather than going empty
  ['...@gmail.com', '...@gmail.com'],
  // the last `@` splits local and domain
  ['"a@b"+x@example.com', '"a@b"@example.com'],
  // not an address: only case-folded
  ['no-at-sign', 'no-at-sign'],
  ['Foo+Bar', 'foo+bar'],
  ['@example.com', '@example.com'],
  ['foo@', 'foo@'],
  ['', ''],
];

/**
 * Exact-mode key inputs (#862): `normalizeEmail()` (TS) and
 * `lumibase_email_normalize()` (SQL, migration 0041) must agree — trim the
 * JS `trim()` whitespace set, then lower-case.
 */
export const EMAIL_NORMALIZE_FIXTURES: ReadonlyArray<readonly [input: string, normalized: string]> = [
  ['Foo+Bar@Example.com', 'foo+bar@example.com'],
  ['  foo@example.com  ', 'foo@example.com'],
  ['\tFoo@Example.com\r\n', 'foo@example.com'],
  ['\u00a0\u3000foo@example.com\ufeff', 'foo@example.com'],
  ['\u2000\u200afoo@example.com\u2028', 'foo@example.com'],
  ['foo @example.com', 'foo @example.com'],
  ['\u200bfoo@example.com', '\u200bfoo@example.com'],
  ['foo@example.com\u0085', 'foo@example.com\u0085'],
  ['', ''],
];
