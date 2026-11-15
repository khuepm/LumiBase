import assert from 'node:assert/strict';
import test from 'node:test';
import { checkLogicalCss, fixSource, LINE_ALLOW, scanSource } from '../check-logical-css.mjs';

const found = (src, rel) => scanSource(src, rel).map((f) => `${f.found}→${f.fix}`);

test('this repository passes (Studio + packages/ui use logical utilities)', async () => {
  const { findings, files } = await checkLogicalCss();
  assert.deepEqual(findings, []);
  assert.ok(files > 200, 'the scan should cover the real Studio source tree');
});

test('flags physical spacing, inset, alignment, border and radius utilities', () => {
  const src = `<div className="ml-2 mr-auto pl-3 pr-[3px] left-0 -right-1 text-left text-right border-l border-r-2 rounded-l-md rounded-tr float-left scroll-pl-4" />`;
  assert.deepEqual(found(src), [
    'ml-2→ms-2',
    'mr-auto→me-auto',
    'pl-3→ps-3',
    'pr-[3px]→pe-[3px]',
    'left-0→start-0',
    '-right-1→-end-1',
    'text-left→text-start',
    'text-right→text-end',
    'border-l→border-s',
    'border-r-2→border-e-2',
    'rounded-l-md→rounded-s-md',
    'rounded-tr→rounded-se',
    'float-left→float-start',
    'scroll-pl-4→scroll-ps-4',
  ]);
});

test('keeps variants and the important modifier', () => {
  assert.deepEqual(found(`cn('hover:ml-2', 'md:!pr-4', 'file:mr-3', 'sm:border-r', '[&>svg]:left-1')`), [
    'hover:ml-2→hover:ms-2',
    'md:!pr-4→md:!pe-4',
    'file:mr-3→file:me-3',
    'sm:border-r→sm:border-e',
    '[&>svg]:left-1→[&>svg]:start-1',
  ]);
});

test('flags physical inline-style keys', () => {
  assert.deepEqual(found(`style={{ paddingLeft: 4, marginRight: 2, borderLeftWidth: 1 }}`), [
    'paddingLeft→paddingInlineStart',
    'marginRight→marginInlineEnd',
    'borderLeftWidth→borderInlineStartWidth',
  ]);
});

test('ignores prose, identifiers, logical classes and look-alikes', () => {
  const src = [
    `// Align the label to the left of the icon; pr review; right-click to open.`,
    `const left = 1; const pr = 2; const right = left + pr;`,
    `className="ms-2 me-auto ps-3 pe-4 start-0 end-0 text-start border-s rounded-e-md"`,
    `className="border-red-500 rounded-lg text-lg pl-review-thing"`,
    `const key = 'left-sidebar'; const x = 'margin-left';`,
  ].join('\n');
  assert.deepEqual(found(src), []);
});

test('rtl:/ltr: variants are deliberate and not flagged', () => {
  assert.deepEqual(found(`className="rtl:mr-2 ltr:ml-2 md:rtl:left-0"`), []);
});

test('a line marker or an allow-listed file opts out', () => {
  assert.deepEqual(found(`<div className="left-0" /> {/* ${LINE_ALLOW}: pixel coordinates */}`), []);
  assert.deepEqual(found(`<div className="absolute right-2" />`, 'apps/studio/src/modules/automation/flow-node-types.tsx'), []);
  assert.equal(found(`<div className="absolute right-2" />`, 'apps/studio/src/other.tsx').length, 1);
});

test('--fix rewrites to the logical form and is idempotent', () => {
  const src = `<div className="ml-2 hover:pr-4 text-left border-l" style={{ paddingLeft: depth * 16 }} />`;
  const fixed = fixSource(src);
  assert.equal(fixed, `<div className="ms-2 hover:pe-4 text-start border-s" style={{ paddingInlineStart: depth * 16 }} />`);
  assert.equal(fixSource(fixed), fixed);
  assert.deepEqual(scanSource(fixed), []);
});
