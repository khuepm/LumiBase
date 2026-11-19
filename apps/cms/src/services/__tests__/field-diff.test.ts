import { describe, expect, it } from 'vitest';
import { diffKindOf, jsonPathDiff, listDiff, wordDiff, WORD_DIFF_MAX_TOKENS } from '@lumibase/contracts';

/** Field-aware diff helpers shared by the compare endpoint and Studio (#686). */
describe('wordDiff', () => {
  it('marks only the changed words', () => {
    expect(wordDiff('the quick brown fox', 'the slow brown fox')).toEqual([
      { op: 'equal', text: 'the ' },
      { op: 'delete', text: 'quick' },
      { op: 'insert', text: 'slow' },
      { op: 'equal', text: ' brown fox' },
    ]);
  });

  it('handles empty sides and identity', () => {
    expect(wordDiff('', 'new')).toEqual([{ op: 'insert', text: 'new' }]);
    expect(wordDiff('old', '')).toEqual([{ op: 'delete', text: 'old' }]);
    expect(wordDiff('same', 'same')).toEqual([{ op: 'equal', text: 'same' }]);
    expect(wordDiff('', '')).toEqual([]);
  });

  it('reassembles both sides exactly', () => {
    const a = 'Lorem ipsum dolor  sit amet,\nconsectetur adipiscing';
    const b = 'Lorem dolor sit amet, new\nconsectetur elit adipiscing';
    const tokens = wordDiff(a, b);
    expect(tokens.filter((t) => t.op !== 'insert').map((t) => t.text).join('')).toBe(a);
    expect(tokens.filter((t) => t.op !== 'delete').map((t) => t.text).join('')).toBe(b);
  });

  it('falls back to a block replace past the token cap', () => {
    const big = Array.from({ length: WORD_DIFF_MAX_TOKENS }, (_, i) => `w${i}`).join(' ');
    expect(wordDiff(big, `${big} x`)).toEqual([
      { op: 'delete', text: big },
      { op: 'insert', text: `${big} x` },
    ]);
  });
});

describe('jsonPathDiff', () => {
  it('reports leaf paths', () => {
    expect(
      jsonPathDiff({ seo: { title: 'a', desc: 'x' }, tags: [1, 2] }, { seo: { title: 'b' }, tags: [1, 3], n: 1 }),
    ).toEqual([
      { path: 'n', state: 'added', before: undefined, after: 1 },
      { path: 'seo.desc', state: 'removed', before: 'x', after: undefined },
      { path: 'seo.title', state: 'changed', before: 'a', after: 'b' },
      { path: 'tags.1', state: 'changed', before: 2, after: 3 },
    ]);
    expect(jsonPathDiff({ a: 1 }, { a: 1 })).toEqual([]);
  });
});

describe('listDiff', () => {
  it('reports added, removed and reorder', () => {
    expect(listDiff(['a', 'b', 'c'], ['c', 'a', 'd'])).toEqual({
      added: ['d'],
      removed: ['b'],
      kept: ['c', 'a'],
      reordered: true,
    });
    expect(listDiff(['a'], ['a']).reordered).toBe(false);
  });
});

describe('diffKindOf', () => {
  it('picks a renderer per value shape', () => {
    expect(diffKindOf('a', 'b')).toBe('text');
    expect(diffKindOf(undefined, 'b')).toBe('text');
    expect(diffKindOf(['x'], ['y'])).toBe('list');
    expect(diffKindOf({ a: 1 }, { a: 2 })).toBe('json');
    expect(diffKindOf([{ id: 1 }], [])).toBe('json');
    expect(diffKindOf(1, 2)).toBe('scalar');
  });
});
