// Node.js support check shared by the `lumibase` and `create-lumibase` bin
// shims (#760). The supported range is NOT written here: it is read from the
// `engines.node` field of the package that ships this file, which in turn must
// equal the root `package.json` range — `scripts/check-runtime-matrix.mjs`
// fails CI when they drift, and when the copy of this file in
// `packages/create-lumibase/bin/` stops being byte-identical to the one in
// `packages/cli/bin/`.
//
//   * below the hard minimum (the lowest major the range admits) → error, exit 1.
//     Those runtimes cannot even load the dependency graph (execa 10 throws at
//     import time on Node < 22), so a plain sentence beats a stack trace.
//   * inside the hard minimum but outside the range (e.g. 22.0–22.22.1, or the
//     non-LTS 25 line) → warning on stderr, the command still runs.
//
// Plain ES2020 on purpose: this file runs BEFORE the version check has passed,
// so it must parse on the old runtimes it is about to reject.

import { readFileSync } from 'node:fs';

export const POLICY_URL = 'https://docs.lumibase.dev/docs/contributing/supported-runtimes';

const COMPARATOR = /^(\^|~|>=|<=|>|<|=)?v?(\d+|x|\*)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:-[0-9A-Za-z.-]+)?$/;

/** `v22.1.0`, `22.1.0-pre`, `22` → [22, 1, 0]. Returns null when unparseable. */
export function parseVersion(text) {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(text).trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)];
}

function compare(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function isWild(part) {
  return part === undefined || part === 'x' || part === '*';
}

/** One comparator token → { min, minInclusive, max, maxInclusive } bounds. */
function toBounds(token) {
  const match = COMPARATOR.exec(token);
  if (!match) throw new Error(`unsupported engines range token: "${token}"`);
  const op = match[1] || '=';
  if (isWild(match[2])) return { min: null, max: null };
  const major = Number(match[2]);
  const minorWild = isWild(match[3]);
  const patchWild = isWild(match[4]);
  const minor = minorWild ? 0 : Number(match[3]);
  const patch = patchWild ? 0 : Number(match[4]);
  const base = [major, minor, patch];
  // Upper bound of a partial version: `22` covers [22.0.0, 23.0.0).
  const partialCeil = minorWild ? [major + 1, 0, 0] : patchWild ? [major, minor + 1, 0] : null;

  switch (op) {
    case '^': {
      const max = major > 0 ? [major + 1, 0, 0] : minor > 0 || minorWild ? [0, minor + 1, 0] : [0, 0, patch + 1];
      return { min: base, minInclusive: true, max, maxInclusive: false };
    }
    case '~':
      return { min: base, minInclusive: true, max: minorWild ? [major + 1, 0, 0] : [major, minor + 1, 0], maxInclusive: false };
    case '>=':
      return { min: base, minInclusive: true, max: null };
    case '>':
      return partialCeil ? { min: partialCeil, minInclusive: true, max: null } : { min: base, minInclusive: false, max: null };
    case '<':
      return { min: null, max: base, maxInclusive: false };
    case '<=':
      return partialCeil ? { min: null, max: partialCeil, maxInclusive: false } : { min: null, max: base, maxInclusive: true };
    default:
      return partialCeil
        ? { min: base, minInclusive: true, max: partialCeil, maxInclusive: false }
        : { min: base, minInclusive: true, max: base, maxInclusive: true };
  }
}

/**
 * Parse an `engines.node` range into OR-ed sets of AND-ed bounds. Supports the
 * npm forms the repo actually uses (`^`, `~`, `>=`, `>`, `<`, `<=`, `=`, bare
 * and partial versions, `||`). Anything else throws, so an exotic range is
 * caught by the drift check instead of being misread at runtime.
 */
export function parseRange(range) {
  if (typeof range !== 'string' || range.trim() === '') throw new Error('engines.node is empty');
  return range.split('||').map((set) => {
    const tokens = set.trim().replace(/(\^|~|>=|<=|>|<|=)\s+/g, '$1').split(/\s+/).filter(Boolean);
    if (tokens.length === 0) throw new Error(`empty set in engines range: "${range}"`);
    return tokens.map(toBounds);
  });
}

function withinBounds(version, bounds) {
  if (bounds.min) {
    const c = compare(version, bounds.min);
    if (c < 0 || (c === 0 && !bounds.minInclusive)) return false;
  }
  if (bounds.max) {
    const c = compare(version, bounds.max);
    if (c > 0 || (c === 0 && !bounds.maxInclusive)) return false;
  }
  return true;
}

export function satisfies(version, range) {
  const parsed = typeof version === 'string' ? parseVersion(version) : version;
  if (!parsed) return false;
  return parseRange(range).some((set) => set.every((bounds) => withinBounds(parsed, bounds)));
}

/** Lowest major any set of the range admits — below it the CLI refuses to run. */
export function hardMinimumMajor(range) {
  let lowest = Infinity;
  for (const set of parseRange(range)) {
    let floor = 0;
    for (const bounds of set) {
      if (bounds.min && bounds.min[0] > floor) floor = bounds.min[0];
    }
    if (floor < lowest) lowest = floor;
  }
  return lowest === Infinity ? 0 : lowest;
}

/**
 * Majors the range pins as a bounded line (`^22.22.2` → 22). Open-ended sets
 * (`>=26.0.0`) are reported separately as `openFrom`.
 */
export function describeRange(range) {
  const lines = [];
  let openFrom = null;
  for (const set of parseRange(range)) {
    const min = set.reduce((acc, b) => (b.min && (!acc || compare(b.min, acc) > 0) ? b.min : acc), null);
    const max = set.reduce((acc, b) => (b.max && (!acc || compare(b.max, acc) < 0) ? b.max : acc), null);
    if (min && !max) {
      if (openFrom === null || min[0] < openFrom) openFrom = min[0];
    } else if (min && max && max[0] === min[0] + 1 && max[1] === 0 && max[2] === 0) {
      lines.push(min[0]);
    }
  }
  return { lines: lines.sort((a, b) => a - b), openFrom };
}

/** Pure classification: 'ok' | 'unsupported' (warn) | 'too-old' (fail). */
export function checkNodeVersion(version, range) {
  const parsed = parseVersion(version);
  if (!parsed) return { status: 'ok' };
  if (satisfies(parsed, range)) return { status: 'ok' };
  const minimum = hardMinimumMajor(range);
  if (parsed[0] < minimum) return { status: 'too-old', minimum };
  return { status: 'unsupported', minimum };
}

export function formatNodeMessage(name, version, range, result) {
  if (result.status === 'too-old') {
    return (
      `${name} requires Node.js ${result.minimum} or newer. Current: ${version}.\n` +
      `Supported range: ${range}. Install an LTS release from https://nodejs.org and retry.\n` +
      `See ${POLICY_URL}`
    );
  }
  if (result.status === 'unsupported') {
    return (
      `Warning: ${name} is not supported on Node.js ${version} (supported: ${range}).\n` +
      `Continuing anyway — if something breaks, switch to an LTS release first.\n` +
      `See ${POLICY_URL}`
    );
  }
  return '';
}

/**
 * Run the check for a bin shim. `readRange` defaults to the shipping package's
 * own `engines.node`. Never throws: a broken manifest must not brick the CLI.
 * Returns the status so callers (and tests) can see what happened.
 */
export function enforceNodeSupport(options) {
  const name = options.name;
  const version = options.version || process.version;
  const write = options.write || ((text) => process.stderr.write(text + '\n'));
  const exit = options.exit || ((code) => process.exit(code));
  let range;
  let result;
  try {
    range = options.range || JSON.parse(readFileSync(options.packageJsonUrl, 'utf8')).engines.node;
    result = checkNodeVersion(version, range);
  } catch (_error) {
    return 'ok';
  }
  if (result.status === 'ok') return 'ok';
  write(formatNodeMessage(name, version, range, result));
  if (result.status === 'too-old') exit(1);
  return result.status;
}
