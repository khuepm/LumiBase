import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { baseOf, canonicalJson, hashSnapshot, snapshotData } from '../base';
import { classify, type ClassifyInput } from '../classify';
import { collectFileIds, fileFieldsOf, rewriteFileIds } from '../file-refs';
import { inScope, isCopyableSetting, parseScope } from '../fork';

describe('base snapshot (design §14.4)', () => {
  it('canonical JSON ignores key order and undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: undefined, e: [3, { z: 1, y: 2 }] } })).toBe('{"a":{"d":2,"e":[3,{"y":2,"z":1}]},"b":1}');
  });

  it('replaces encrypted values by a SHA-256 marker and never keeps the plaintext', async () => {
    const snap = await snapshotData({ title: 'x', ssn: '123-45', empty: null }, new Set(['ssn', 'empty']));
    expect(snap.title).toBe('x');
    expect(snap).not.toHaveProperty('empty');
    expect(snap.ssn).toEqual({ $enc: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(JSON.stringify(snap)).not.toContain('123-45');
  });

  it('hash is a stable function of content', async () => {
    await fc.assert(
      fc.asyncProperty(fc.dictionary(fc.string({ maxLength: 8 }), fc.jsonValue(), { maxKeys: 6 }), async (data) => {
        const reversed = Object.fromEntries(Object.entries(data).reverse());
        expect(await hashSnapshot(data as Record<string, unknown>)).toBe(await hashSnapshot(reversed as Record<string, unknown>));
      }),
      { numRuns: 50 },
    );
    const a = await baseOf({ x: 1 }, new Set());
    const b = await baseOf({ x: 2 }, new Set());
    expect(a.hash).not.toBe(b.hash);
  });
});

describe('classify (design §8.1)', () => {
  const B = 'base';
  const base = (o: string | null, e: string, deleted = false): ClassifyInput => ({
    lineage: { baseHash: B, external: false },
    origin: o === null ? null : { hash: o },
    env: { hash: e, deleted },
  });

  it('follows the table', () => {
    expect(classify(base(B, B)).action).toBe('unchanged');
    expect(classify(base(B, 'e')).action).toBe('promote');
    expect(classify(base('o', B)).action).toBe('origin-only');
    expect(classify(base('o', 'e'))).toEqual({ action: 'conflict', reason: 'ORIGIN_CHANGED' });
    expect(classify(base('same', 'same')).action).toBe('unchanged');
    expect(classify(base(B, B, true)).action).toBe('delete');
    expect(classify(base('o', B, true))).toEqual({ action: 'conflict', reason: 'ORIGIN_CHANGED' });
    expect(classify(base(null, B, true)).action).toBe('unchanged');
    expect(classify(base(null, 'e'))).toEqual({ action: 'conflict', reason: 'ORIGIN_DELETED' });
    expect(classify({ lineage: null, origin: null, env: { hash: 'e', deleted: false } }).action).toBe('create');
    expect(classify({ lineage: null, origin: { hash: 'x' }, env: { hash: 'e', deleted: false } })).toEqual({ action: 'conflict', reason: 'ITEM_ID_EXISTS' });
    expect(classify({ lineage: { baseHash: B, external: true }, origin: { hash: B }, env: { hash: 'e', deleted: false } }).action).toBe('skip');
  });

  it('never overwrites an origin that moved away from the base', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.string(), fc.boolean(), (b, o, e, deleted) => {
        fc.pre(o !== b);
        const { action } = classify({ lineage: { baseHash: b, external: false }, origin: { hash: o }, env: { hash: e, deleted } });
        expect(['promote', 'delete']).not.toContain(action);
      }),
    );
  });
});

describe('file references', () => {
  const fieldsMap = fileFieldsOf([
    { name: 'cover', interface: 'file' },
    { name: 'gallery', interface: 'files' },
    { name: 'title', interface: 'input' },
  ]);

  it('collects and rewrites only file fields', () => {
    const data = { cover: 'f1', gallery: ['f2', 'f9'], title: 'f1' };
    expect(collectFileIds(data, fieldsMap)).toEqual(['f1', 'f2', 'f9']);
    const out = rewriteFileIds(data, fieldsMap, new Map([['f1', 'g1'], ['f2', 'g2']]));
    expect(out).toEqual({ cover: 'g1', gallery: ['g2', 'f9'], title: 'f1' });
    expect(data.cover).toBe('f1');
  });
});

describe('fork scope and settings', () => {
  it('parses scopes defensively', () => {
    expect(parseScope(null)).toEqual({ mode: 'none' });
    expect(parseScope({ mode: 'all' })).toEqual({ mode: 'all' });
    expect(parseScope({ mode: 'collections', collections: ['a', 1] })).toEqual({ mode: 'collections', collections: ['a'] });
    expect(inScope({ mode: 'collections', collections: ['a'] }, 'b')).toBe(false);
  });

  it('never copies secrets or outbound targets', () => {
    for (const key of ['revalidation.targets', 'smtp', 'media.signedTransform.secret', 'encryption.envelope', 'release.flags', 'firebase.sync', 'deploy.hooks']) {
      expect(isCopyableSetting(key)).toBe(false);
    }
    for (const key of ['locales', 'site.theme', 'editorial.workflow']) expect(isCopyableSetting(key)).toBe(true);
  });
});
