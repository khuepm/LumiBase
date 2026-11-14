/**
 * Password strength estimator — a small, dependency-free, zxcvbn-style scorer
 * (#733, epic #674 S04).
 *
 * Why in-house instead of `zxcvbn` / `@zxcvbn-ts/*`: the score has to come out
 * the same on the server (Cloudflare Workers + Node) and in the Studio meter,
 * from one implementation, without shipping ~400 KB of frequency lists into the
 * Worker bundle. The model is zxcvbn's: split the password into the cheapest
 * sequence of "patterns" an attacker would guess (common password, the user's
 * own name/email, `abc`/`123` sequences, repeats, keyboard walks, years) with a
 * brute-force fallback, sum the log10 guess counts, and map the total onto
 * zxcvbn's 0–4 buckets (`< 10^3`, `< 10^6`, `< 10^8`, `< 10^10`, above).
 *
 * The bundled dictionary is deliberately short (the most-used passwords and the
 * words people put in them). It is a floor, not a breach corpus: the optional
 * HIBP k-anonymity check in the CMS policy service is the real "known breached"
 * test. Treat this as a meter that catches the obvious, not a guarantee.
 */

export type PasswordStrengthScore = 0 | 1 | 2 | 3 | 4;

/** Machine-readable reasons a password scored low. Stable — the UI maps them to copy. */
export type PasswordWeakness =
  | 'common_password'
  | 'contains_user_input'
  | 'sequence'
  | 'repeat'
  | 'keyboard_pattern'
  | 'year';

export interface PasswordStrengthResult {
  readonly score: PasswordStrengthScore;
  /** log10 of the estimated guesses needed. */
  readonly guessesLog10: number;
  /** Patterns the cheapest guess path used, most significant first, de-duplicated. */
  readonly weaknesses: readonly PasswordWeakness[];
}

/**
 * Most-common passwords and password fragments, roughly by popularity (rank
 * matters: lower rank → fewer guesses). Lower-case, de-l33ted form.
 */
const COMMON_WORDS: readonly string[] = [
  'password', '123456', '12345678', 'qwerty', '123456789', '12345', '1234', '111111',
  '1234567', 'dragon', '123123', 'baseball', 'abc123', 'football', 'monkey', 'letmein',
  'shadow', 'master', '696969', 'mustang', '666666', 'qwertyuiop', '123321', '1234567890',
  'michael', 'superman', 'batman', 'trustno1', 'iloveyou', 'sunshine', 'princess', 'welcome',
  'admin', 'administrator', 'login', 'passw0rd', 'starwars', 'whatever', 'freedom', 'hello',
  'charlie', 'donald', 'secret', 'access', 'flower', 'hottie', 'loveme', 'zaq1zaq1', 'pass',
  'love', 'qazwsx', 'ninja', 'azerty', 'solo', 'jesus', 'cheese', 'computer', 'summer',
  'winter', 'spring', 'autumn', 'january', 'october', 'december', 'changeme', 'default',
  'root', 'toor', 'test', 'guest', 'user', 'demo', 'lumibase', 'cms', 'company', 'office',
  'monday', 'friday', 'soccer', 'hockey', 'killer', 'pepper', 'jordan', 'hunter', 'ranger',
  'buster', 'thomas', 'robert', 'tigger', 'ginger', 'matrix', 'orange', 'banana', 'apple',
  'chocolate', 'internet', 'google', 'facebook', 'samsung', 'secure', 'security', 'system',
  'manager', 'server', 'database', 'qwerty123', 'password1', 'abcdef', 'abcd', 'temp',
  'welcome1', 'p@ssword', 'strong', 'super', 'magic', 'money', 'family', 'happy', 'lucky',
  'angel', 'baby', 'love123', 'blink182', 'pokemon', 'naruto', 'matkhau', 'anhyeuem',
  'iloveu', 'yeuem', 'vietnam', 'saigon', 'hanoi',
];

const COMMON_RANK: ReadonlyMap<string, number> = new Map(
  COMMON_WORDS.map((w, i) => [w, i + 1] as const),
);

/** Common single-character substitutions folded back before dictionary lookup. */
const L33T: Readonly<Record<string, string>> = {
  '4': 'a', '@': 'a', '8': 'b', '(': 'c', '3': 'e', '6': 'g', '1': 'i', '!': 'i',
  '|': 'l', '0': 'o', '$': 's', '5': 's', '7': 't', '+': 't', '2': 'z', '%': 'x',
};

const KEYBOARD_ROWS: readonly string[] = [
  '`1234567890-=', 'qwertyuiop[]\\', "asdfghjkl;'", 'zxcvbnm,./',
  '1qaz2wsx3edc4rfv5tgb6yhn7ujm8ik9ol0p', 'qazwsxedcrfvtgbyhnujmikolp',
];

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';

/** Brute-force cost per character (zxcvbn's conservative cardinality). */
const BRUTEFORCE_LOG10_PER_CHAR = 1;
const MIN_MATCH_LOG10 = Math.log10(50);

interface Match {
  readonly i: number;
  readonly j: number; // inclusive
  readonly log10: number;
  readonly kind: PasswordWeakness;
}

function upperVariationsLog10(token: string): number {
  if (token === token.toLowerCase()) return 0;
  const upper = [...token].filter((c) => c !== c.toLowerCase()).length;
  const lower = [...token].filter((c) => c !== c.toUpperCase()).length;
  // "Password" / "PASSWORD" / "passworD" are the first things tried.
  if (/^[A-Z][^A-Z]+$/.test(token) || /^[^a-z]+$/.test(token) || /^[^A-Z]+[A-Z]$/.test(token)) {
    return Math.log10(2);
  }
  // Otherwise: number of ways to choose which letters are upper-cased.
  return Math.log10(Math.max(2, binom(upper + lower, Math.min(upper, lower))));
}

function binom(n: number, k: number): number {
  let r = 1;
  for (let d = 1; d <= k; d++) r = (r * (n - d + 1)) / d;
  return r;
}

function unl33t(token: string): string {
  let out = '';
  for (const ch of token.toLowerCase()) out += L33T[ch] ?? ch;
  return out;
}

function dictionaryMatches(password: string, userInputs: readonly string[]): Match[] {
  const lower = password.toLowerCase();
  const plain = unl33t(password);
  const out: Match[] = [];
  const userRank = new Map<string, number>();
  userInputs.forEach((w, idx) => {
    if (w.length >= 3 && !userRank.has(w)) userRank.set(w, idx + 1);
  });
  for (let i = 0; i < password.length; i++) {
    for (let j = i + 2; j < password.length; j++) {
      const raw = lower.slice(i, j + 1);
      const sub = plain.slice(i, j + 1);
      const token = password.slice(i, j + 1);
      for (const [candidate, l33ted] of [[raw, false], [sub, sub !== raw]] as const) {
        const u = userRank.get(candidate);
        const c = COMMON_RANK.get(candidate);
        const l33tCost = l33ted ? Math.log10(4) : 0;
        if (u !== undefined) {
          out.push({ i, j, kind: 'contains_user_input', log10: Math.max(MIN_MATCH_LOG10, Math.log10(u) + upperVariationsLog10(token) + l33tCost) });
        }
        if (c !== undefined) {
          out.push({ i, j, kind: 'common_password', log10: Math.max(MIN_MATCH_LOG10, Math.log10(c) + upperVariationsLog10(token) + l33tCost) });
        }
      }
    }
  }
  return out;
}

function sequenceMatches(password: string): Match[] {
  const lower = password.toLowerCase();
  const out: Match[] = [];
  const step = (a: string, b: string): number | null => {
    for (const set of [ALPHABET, DIGITS]) {
      const ia = set.indexOf(a);
      const ib = set.indexOf(b);
      if (ia >= 0 && ib >= 0 && Math.abs(ib - ia) === 1) return ib - ia;
    }
    return null;
  };
  let i = 0;
  while (i < lower.length - 1) {
    const d = step(lower[i]!, lower[i + 1]!);
    if (d === null) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < lower.length - 1 && step(lower[j]!, lower[j + 1]!) === d) j++;
    if (j - i + 1 >= 3) {
      const first = lower[i]!;
      const base = /[a0z9]/.test(first) ? 4 : DIGITS.includes(first) ? 10 : 26;
      out.push({ i, j, kind: 'sequence', log10: Math.max(MIN_MATCH_LOG10, Math.log10(base * (j - i + 1) * (d < 0 ? 2 : 1))) });
    }
    i = j;
  }
  return out;
}

function repeatMatches(password: string): Match[] {
  const out: Match[] = [];
  const n = password.length;
  for (let i = 0; i < n; i++) {
    // Try every base unit length; record the longest repeat run starting at i.
    for (let unit = 1; unit <= Math.floor((n - i) / 2); unit++) {
      const base = password.slice(i, i + unit);
      let reps = 1;
      while (password.slice(i + reps * unit, i + (reps + 1) * unit) === base) reps++;
      if (reps >= 2 && reps * unit >= 3) {
        // Cost: guess the base (brute force, capped) then the repeat count.
        const baseLog = unit * BRUTEFORCE_LOG10_PER_CHAR;
        out.push({ i, j: i + reps * unit - 1, kind: 'repeat', log10: Math.max(MIN_MATCH_LOG10, baseLog + Math.log10(reps)) });
      }
    }
  }
  return out;
}

function keyboardMatches(password: string): Match[] {
  const lower = password.toLowerCase();
  const out: Match[] = [];
  for (let i = 0; i < lower.length; i++) {
    for (let j = i + 3; j < lower.length; j++) {
      const token = lower.slice(i, j + 1);
      const reversed = [...token].reverse().join('');
      if (KEYBOARD_ROWS.some((row) => row.includes(token) || row.includes(reversed))) {
        out.push({ i, j, kind: 'keyboard_pattern', log10: Math.max(MIN_MATCH_LOG10, Math.log10(94 * (j - i + 1) * 2)) });
      }
    }
  }
  return out;
}

function yearMatches(password: string): Match[] {
  const out: Match[] = [];
  const re = /(19\d\d|20\d\d)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(password)) !== null) {
    out.push({ i: m.index, j: m.index + 3, kind: 'year', log10: Math.log10(119) });
  }
  return out;
}

/** Split e-mails / names into the lower-case tokens a guesser would try. */
export function passwordUserInputTokens(inputs: readonly (string | null | undefined)[]): string[] {
  const tokens = new Set<string>();
  for (const raw of inputs) {
    if (!raw) continue;
    const value = raw.toLowerCase().trim();
    if (value.length >= 3) tokens.add(value);
    for (const part of value.split(/[^a-z0-9]+/)) {
      if (part.length >= 3) tokens.add(part);
    }
  }
  return [...tokens];
}

function scoreFor(guessesLog10: number): PasswordStrengthScore {
  if (guessesLog10 < 3) return 0;
  if (guessesLog10 < 6) return 1;
  if (guessesLog10 < 8) return 2;
  if (guessesLog10 < 10) return 3;
  return 4;
}

/**
 * Estimate how many guesses `password` would take and return a zxcvbn-style
 * 0–4 score. `userInputs` are values an attacker targeting this user would try
 * first (e-mail, names) — pass them raw, they are tokenised here.
 *
 * Pure and deterministic; runs in the browser, Node and Workers. Input is
 * capped at 256 characters by every caller (the policy's max length), which
 * keeps the O(n²) matchers cheap.
 */
export function estimatePasswordStrength(
  password: string,
  userInputs: readonly (string | null | undefined)[] = [],
): PasswordStrengthResult {
  const pw = password.slice(0, 256);
  const n = pw.length;
  if (n === 0) return { score: 0, guessesLog10: 0, weaknesses: [] };

  const matches = [
    ...dictionaryMatches(pw, passwordUserInputTokens(userInputs)),
    ...sequenceMatches(pw),
    ...repeatMatches(pw),
    ...keyboardMatches(pw),
    ...yearMatches(pw),
  ];
  const byEnd = new Map<number, Match[]>();
  for (const m of matches) {
    const list = byEnd.get(m.j) ?? [];
    list.push(m);
    byEnd.set(m.j, list);
  }

  // best[k] = cheapest log10 guesses for the prefix of length k.
  const best: number[] = new Array<number>(n + 1).fill(Infinity);
  const via: (Match | null)[] = new Array<Match | null>(n + 1).fill(null);
  best[0] = 0;
  for (let k = 1; k <= n; k++) {
    best[k] = best[k - 1]! + BRUTEFORCE_LOG10_PER_CHAR;
    via[k] = null;
    for (const m of byEnd.get(k - 1) ?? []) {
      const cost = best[m.i]! + m.log10;
      if (cost < best[k]!) {
        best[k] = cost;
        via[k] = m;
      }
    }
  }

  // Walk back to collect the patterns the cheapest path used.
  const used: Match[] = [];
  let k = n;
  while (k > 0) {
    const m = via[k];
    if (m) {
      used.push(m);
      k = m.i;
    } else {
      k--;
    }
  }
  used.sort((a, b) => b.j - b.i - (a.j - a.i));
  const weaknesses = [...new Set(used.map((m) => m.kind))];

  const guessesLog10 = Math.round(best[n]! * 100) / 100;
  return { score: scoreFor(guessesLog10), guessesLog10, weaknesses };
}
