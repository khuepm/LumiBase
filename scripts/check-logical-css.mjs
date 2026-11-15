/**
 * Logical-CSS tripwire for the Studio (#761, RTL layout support).
 *
 * The Studio mirrors for right-to-left UI languages (Arabic, Hebrew, Farsi) by
 * setting `<html dir="rtl">`. That only works when layout is written with
 * *logical* properties — `ms-2` (margin-inline-start), not `ml-2`
 * (margin-left). A single physical class puts an icon on the wrong side or
 * overlaps text in RTL while looking fine in LTR, so this guard flags new
 * physical-direction utilities in `apps/studio/src` and `packages/ui/src`.
 *
 * Flagged (with their logical replacement):
 *   ml-/mr-  → ms-/me-        pl-/pr-  → ps-/pe-       left-/right- → start-/end-
 *   text-left/right → text-start/end                   float-left/right → float-start/end
 *   border-l/r → border-s/e   rounded-l/r → rounded-s/e  rounded-tl/tr/bl/br → rounded-ss/se/es/ee
 *   scroll-ml/mr/pl/pr → scroll-ms/me/ps/pe
 *   style={{ marginLeft | paddingRight | borderLeft… }} → marginInlineStart…
 *
 * Not flagged: classes under an explicit `rtl:`/`ltr:` variant (deliberately
 * direction-specific), `translate-x-*` (centering / transforms — review by
 * hand), and anything on a line carrying `rtl-physical-ok` or in a file listed
 * in ALLOW_FILES (code editors, flow canvases and media coordinates are
 * physical by nature and stay LTR).
 *
 * Usage:
 *   node scripts/check-logical-css.mjs          # report, exit 1 on findings
 *   node scripts/check-logical-css.mjs --fix    # rewrite classes in place (codemod)
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOTS = ['apps/studio/src', 'packages/ui/src'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.turbo', 'coverage']);
const SOURCE = /\.(?:tsx?|css)$/;

/** Marker for a line that is physical on purpose. */
export const LINE_ALLOW = 'rtl-physical-ok';

/**
 * Files whose geometry is physical by nature. Each entry needs a reason; the
 * surrounding container renders `dir="ltr"` so the physical classes are right.
 */
export const ALLOW_FILES = new Map([
  // React Flow canvas: node handles are Position.Left/Right, the canvas is LTR.
  ['apps/studio/src/modules/automation/flow-node-types.tsx', 'flow canvas is LTR (xyflow Position.Left/Right)'],
  // Remote cursors are drawn at physical pixel coordinates from the peer.
  ['apps/studio/src/components/cursor-overlay.tsx', 'peer cursors use physical x/y coordinates'],
]);

// Utilities that need a value (`ml-2`, `left-1/2`, `pr-[3px]`); bare `left`,
// `pr` etc. are not Tailwind classes and appear in prose and identifiers.
const VALUED = {
  ml: 'ms',
  mr: 'me',
  pl: 'ps',
  pr: 'pe',
  left: 'start',
  right: 'end',
  'scroll-ml': 'scroll-ms',
  'scroll-mr': 'scroll-me',
  'scroll-pl': 'scroll-ps',
  'scroll-pr': 'scroll-pe',
};
// Utilities that are complete with or without a suffix.
const BARE = {
  'text-left': 'text-start',
  'text-right': 'text-end',
  'float-left': 'float-start',
  'float-right': 'float-end',
  'clear-left': 'clear-start',
  'clear-right': 'clear-end',
  'border-l': 'border-s',
  'border-r': 'border-e',
  'rounded-l': 'rounded-s',
  'rounded-r': 'rounded-e',
  'rounded-tl': 'rounded-ss',
  'rounded-tr': 'rounded-se',
  'rounded-bl': 'rounded-es',
  'rounded-br': 'rounded-ee',
};
const NO_SUFFIX = new Set(['text-left', 'text-right', 'float-left', 'float-right', 'clear-left', 'clear-right']);

const SPACING_VALUE = String.raw`(?:\d+(?:\.\d+)?(?:\/\d+)?|px|auto|full|\[[^\]\s]+\]|\([^)\s]+\))`;
const WORD_VALUE = String.raw`(?:[a-z0-9]+(?:-[a-z0-9]+)*(?:\/\d+)?|\[[^\]\s]+\]|\([^)\s]+\))`;
const sortByLength = (keys) => [...keys].sort((a, b) => b.length - a.length).map((k) => k.replace(/-/g, '\\-'));

// Before the token: start, whitespace, a quote/backtick, `{`, `(`, `,`.
// Variants (`hover:`, `md:`, `file:`, `[&>svg]:`) are captured so `rtl:`/`ltr:` can be skipped.
const PREFIX = String.raw`(?<![\w\-/\[.:!])((?:[\w\-\[\]&>=*@().]+:)*)(!?)(-?)`;
const END = String.raw`(?![\w\-\[/])`;
export const CLASS_RE = new RegExp(
  `${PREFIX}(?:(${sortByLength(Object.keys(VALUED)).join('|')})-(${SPACING_VALUE})|(${sortByLength(Object.keys(BARE)).join('|')})(?:-(${WORD_VALUE}))?)${END}`,
  'g',
);
export const STYLE_RE = /\b(margin|padding|border)(Left|Right)(Width|Color|Style)?\b(?=\s*:)/g;
const STYLE_FIX = { Left: 'InlineStart', Right: 'InlineEnd' };

/** Logical replacement for one regex match, or null when it must be left alone. */
function replacementFor(match) {
  const [, variants, important, negative, valuedKey, valuedValue, bareKey, bareValue] = match;
  if (/(?:^|:)(?:rtl|ltr):/.test(variants)) return null;
  if (valuedKey) return `${variants}${important}${negative}${VALUED[valuedKey]}-${valuedValue}`;
  if (NO_SUFFIX.has(bareKey) && bareValue) return null; // `text-left-foo` is not a utility
  return `${variants}${important}${negative}${BARE[bareKey]}${bareValue ? `-${bareValue}` : ''}`;
}

/** Findings for one file's source. `rel` is the repo-relative path. */
export function scanSource(source, rel = '') {
  if (ALLOW_FILES.has(rel)) return [];
  const findings = [];
  const lines = source.split('\n');
  lines.forEach((line, i) => {
    if (line.includes(LINE_ALLOW)) return;
    for (const m of line.matchAll(CLASS_RE)) {
      const fix = replacementFor(m);
      if (fix) findings.push({ file: rel, line: i + 1, found: m[0], fix });
    }
    for (const m of line.matchAll(STYLE_RE)) {
      findings.push({ file: rel, line: i + 1, found: m[0], fix: `${m[1]}${STYLE_FIX[m[2]]}${m[3] ?? ''}` });
    }
  });
  return findings;
}

/** Rewrite every finding in `source` to its logical form (the codemod). */
export function fixSource(source, rel = '') {
  if (ALLOW_FILES.has(rel)) return source;
  return source
    .split('\n')
    .map((line) => {
      if (line.includes(LINE_ALLOW)) return line;
      return line
        .replace(CLASS_RE, (...args) => replacementFor(args) ?? args[0])
        .replace(STYLE_RE, (_m, prop, side, suffix) => `${prop}${STYLE_FIX[side]}${suffix ?? ''}`);
    })
    .join('\n');
}

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(full);
    } else if (SOURCE.test(entry.name)) {
      yield full;
    }
  }
}

export async function checkLogicalCss(repoRoot = process.cwd(), { fix = false } = {}) {
  const findings = [];
  let files = 0;
  let fixed = 0;
  for (const root of ROOTS) {
    for await (const file of walk(path.join(repoRoot, root))) {
      files++;
      const rel = path.relative(repoRoot, file).split(path.sep).join('/');
      const source = await readFile(file, 'utf8');
      if (fix) {
        const next = fixSource(source, rel);
        if (next !== source) {
          await writeFile(file, next);
          fixed++;
        }
      }
      findings.push(...scanSource(fix ? fixSource(source, rel) : source, rel));
    }
  }
  return { findings, files, fixed };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fix = process.argv.includes('--fix');
  const { findings, files, fixed } = await checkLogicalCss(process.cwd(), { fix });
  if (fix) console.log(`check-logical-css: rewrote ${fixed} file(s).`);
  if (findings.length > 0) {
    console.error(`check-logical-css: ${findings.length} physical-direction class(es) in ${ROOTS.join(', ')}:`);
    for (const f of findings) console.error(`  ${f.file}:${f.line}  ${f.found}  →  ${f.fix}`);
    console.error(
      `\nUse the logical utility so the layout mirrors in RTL (docs/en/features/studio-rtl-layout.md).` +
        `\nRun \`node scripts/check-logical-css.mjs --fix\` to rewrite, or mark a deliberate physical` +
        `\nclass with a \`${LINE_ALLOW}\` comment on the same line.`,
    );
    process.exit(1);
  }
  console.log(`check-logical-css: ${files} file(s) clean.`);
}
