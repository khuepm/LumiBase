import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { sanitizeSvg, svgSanitizerFindsActiveContent } from '../svg-sanitizer';
import { svgHasActiveContent } from '../../../middleware/file-upload-policy';
import { ACTIVE_SVGS, EXTERNAL_SVGS, LEGIT_SVGS } from './corpus';

const enc = new TextEncoder();

/** Tokens that must never survive sanitisation, checked case-insensitively. */
function assertInert(svg: string): void {
  const lower = svg.toLowerCase();
  for (const token of ['<script', 'javascript:', '<foreignobject', '<iframe', '<embed', '<!doctype', '<!entity', '<?xml-stylesheet', '<handler', 'expression(']) {
    expect(lower).not.toContain(token);
  }
  expect(lower).not.toMatch(/\son[a-z]+\s*=/);
  expect(lower).not.toContain('http://www.w3.org/1999/xhtml');
}

describe('sanitizeSvg — legitimate SVGs are unchanged', () => {
  it.each(Object.entries(LEGIT_SVGS))('%s round-trips byte-identical with no findings', (_name, svg) => {
    const result = sanitizeSvg(svg);
    expect(result.findings).toEqual([]);
    expect(result.changed).toBe(false);
    expect(result.output).toBe(svg);
    // …and the upload guard accepts it.
    expect(svgHasActiveContent(enc.encode(svg))).toBe(false);
  });
});

describe('sanitizeSvg — XSS corpus is rejected at upload and neutralised when served', () => {
  it.each(Object.entries(ACTIVE_SVGS))('%s', (_name, svg) => {
    expect(svgSanitizerFindsActiveContent(svg)).toBe(true);
    expect(svgHasActiveContent(enc.encode(svg))).toBe(true);
    const result = sanitizeSvg(svg);
    expect(result.changed).toBe(true);
    assertInert(result.output);
    // Idempotent: a second pass finds nothing left to remove.
    expect(sanitizeSvg(result.output).findings).toEqual([]);
  });

  it('keeps the harmless remainder of a sanitised document', () => {
    const { output } = sanitizeSvg(ACTIVE_SVGS.scriptCdata!);
    expect(output).toBe('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
    expect(sanitizeSvg(ACTIVE_SVGS.onload!).output).toBe('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
  });
});

describe('sanitizeSvg — external references', () => {
  it.each(Object.entries(EXTERNAL_SVGS))('%s is stripped (not an upload rejection)', (_name, svg) => {
    const result = sanitizeSvg(svg);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings.every((f) => f.kind === 'external')).toBe(true);
    expect(svgSanitizerFindsActiveContent(svg)).toBe(false);
    expect(result.output).not.toContain('example');
    expect(result.output).not.toContain('data:image/svg');
    expect(result.output).not.toContain('@import');
  });

  it('keeps same-document fragment references and inline raster data URLs', () => {
    const svg = LEGIT_SVGS.gradientAndUse! + LEGIT_SVGS.styledFilter!;
    expect(sanitizeSvg(svg).findings).toEqual([]);
  });
});

describe('sanitizeSvg — properties', () => {
  const safeFragments = [
    '<g>', '</g>', '<rect width="1" height="1"/>', '<circle r="2"/>', '<path d="M0 0L1 1"/>',
    '<text>hi &amp; bye</text>', '<!-- c -->', '<use href="#a"/>', '<style>.x{fill:red}</style>',
  ];
  const hostileFragments = [
    '<script>alert(1)</script>', '<rect onload="x()"/>', '<a href="javascript:x()">', '</a>',
    '<foreignObject><div/></foreignObject>', '<!DOCTYPE x [<!ENTITY e "e">]>', '<image href="https://e.example/x.png"/>',
    '<set attributeName="href" to="javascript:x"/>', '<a href="&#106;avascript:x">', '<?xml-stylesheet href="x"?>',
    '<SCRIPT>x</SCRIPT>', '<svg:script>x</svg:script>', '<rect style="fill:url(http://e.example/x)"/>',
    '<x:div xmlns:x="http://www.w3.org/1999/xhtml">y</x:div>', '<iframe src="x"></iframe>', '<rect ONMOUSEOVER=x()/>',
  ];
  const doc = (parts: string[]) => `<svg xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`;

  it('output of any mix of safe + hostile fragments is inert and idempotent', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...safeFragments, ...hostileFragments), { maxLength: 12 }), (parts) => {
        const result = sanitizeSvg(doc(parts));
        assertInert(result.output);
        expect(result.output).not.toMatch(/https?:\/\/e\.example/);
        const again = sanitizeSvg(result.output);
        expect(again.findings).toEqual([]);
        expect(again.output).toBe(result.output);
      }),
      { numRuns: 300 },
    );
  });

  it('a document built only from safe fragments is never changed', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...safeFragments), { maxLength: 12 }), (parts) => {
        const svg = doc(parts);
        const result = sanitizeSvg(svg);
        expect(result.changed).toBe(false);
        expect(result.output).toBe(svg);
      }),
      { numRuns: 300 },
    );
  });

  it('never throws on arbitrary input', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (input) => {
        const result = sanitizeSvg(input);
        expect(typeof result.output).toBe('string');
      }),
      { numRuns: 500 },
    );
  });
});
