/**
 * Shared `emailRoot` fixtures (#794). Used by the unit test (TS only) and by
 * the DB integration test, which asserts SQL `lumibase_email_root()` returns
 * the same value for every input — so the two implementations cannot drift.
 */
export const EMAIL_ROOT_FIXTURES: ReadonlyArray<readonly [input: string, root: string]> = [
  // case + whitespace folding only
  ['Foo@Example.com', 'foo@example.com'],
  ['  foo@example.com  ', 'foo@example.com'],
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
