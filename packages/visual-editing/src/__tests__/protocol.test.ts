import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  acceptPreviewMessage,
  decodeFieldRef,
  encodeFieldRef,
  isAllowedOrigin,
  MAX_MESSAGE_BYTES,
  MAX_PATCH_FIELDS,
  parsePreviewMessage,
  previewMessage,
} from '../protocol';

/**
 * Message-schema fuzzing for the preview bridge (V03 #681, V05 #683): the
 * gate accepts exactly the well-formed messages and rejects everything else
 * without throwing.
 */

const STUDIO = 'https://studio.example';
const parent = { name: 'parent-window' };

const valid = {
  hello: previewMessage({ type: 'hello' as const }),
  reload: previewMessage({ type: 'reload' as const }),
  patch: previewMessage({ type: 'patch' as const, seq: 1, collection: 'posts', itemId: 'itm_1', fields: { title: 'Hi' } }),
  highlight: previewMessage({ type: 'highlight' as const, target: { collection: 'posts', itemId: 'itm_1', field: 'title' } }),
  ready: previewMessage({ type: 'ready' as const, path: '/posts/hello?__preview=1' }),
  focus: previewMessage({ type: 'focus' as const, target: { collection: 'posts', itemId: 'itm_1', field: 'body.0' } }),
};

describe('origin allowlist', () => {
  it('matches exact origins only', () => {
    expect(isAllowedOrigin(STUDIO, [STUDIO])).toBe(true);
    expect(isAllowedOrigin('https://studio.example.evil.com', [STUDIO])).toBe(false);
    expect(isAllowedOrigin('http://studio.example', [STUDIO])).toBe(false);
    expect(isAllowedOrigin('null', ['null'])).toBe(false);
    expect(isAllowedOrigin('https://x.example', ['*'])).toBe(false);
    expect(isAllowedOrigin('', [''])).toBe(false);
  });
});

describe('acceptPreviewMessage', () => {
  const accept = (data: unknown, origin = STUDIO, source: unknown = parent) =>
    acceptPreviewMessage('to-frontend', { origin, source, data }, { allowedOrigins: [STUDIO], expectedSource: parent });

  it('accepts every well-formed Studio → frontend message', () => {
    for (const m of [valid.hello, valid.reload, valid.patch, valid.highlight]) expect(accept(m).ok).toBe(true);
  });

  it('accepts every well-formed frontend → Studio message', () => {
    for (const m of [valid.ready, valid.focus]) {
      const r = acceptPreviewMessage('to-studio', { origin: STUDIO, source: parent, data: m }, { allowedOrigins: [STUDIO], expectedSource: parent });
      expect(r.ok).toBe(true);
    }
  });

  it('checks origin before source, size and schema', () => {
    expect(accept(valid.hello, 'https://evil.example')).toEqual({ ok: false, reason: 'origin' });
    expect(accept(valid.hello, STUDIO, { other: true })).toEqual({ ok: false, reason: 'source' });
    expect(accept({ huge: 'x'.repeat(MAX_MESSAGE_BYTES) })).toEqual({ ok: false, reason: 'size' });
    expect(accept({ ...valid.hello, type: 'eval', code: 'alert(1)' })).toEqual({ ok: false, reason: 'schema' });
  });

  it('rejects direction mix-ups, extra keys, wrong channel/version', () => {
    expect(accept(valid.focus).ok).toBe(false);
    expect(accept({ ...valid.hello, extra: 1 }).ok).toBe(false);
    expect(accept({ ...valid.hello, channel: 'other' }).ok).toBe(false);
    expect(accept({ ...valid.hello, v: 2 }).ok).toBe(false);
    expect(accept({ ...valid.patch, fields: {} }).ok).toBe(false);
    expect(accept({ ...valid.patch, fields: { '__proto__x': 1, 'a-b': 2 } }).ok).toBe(false);
    expect(accept({ ...valid.patch, collection: '../x' }).ok).toBe(false);
    expect(accept({ ...valid.patch, seq: -1 }).ok).toBe(false);
    const tooMany = Object.fromEntries(Array.from({ length: MAX_PATCH_FIELDS + 1 }, (_, i) => [`f${i}`, i]));
    expect(accept({ ...valid.patch, fields: tooMany }).ok).toBe(false);
  });

  it('never throws and never accepts random payloads (fuzz)', () => {
    fc.assert(
      fc.property(fc.anything(), (data) => {
        const r = accept(data);
        // fc.anything() cannot produce our exact envelope by chance.
        expect(r.ok).toBe(false);
      }),
      { numRuns: 1000 },
    );
  });

  it('rejects mutated valid messages unless the mutation keeps them well-formed (fuzz)', () => {
    const keys = ['channel', 'v', 'type', 'seq', 'collection', 'itemId', 'fields'] as const;
    fc.assert(
      fc.property(fc.constantFrom(...keys), fc.anything(), (key, value) => {
        const mutated = { ...valid.patch, [key]: value };
        const r = accept(mutated);
        const reparsed = parsePreviewMessage('to-frontend', mutated);
        expect(r.ok).toBe(reparsed !== null);
        if (r.ok) expect(r.message).toEqual(reparsed);
      }),
      { numRuns: 1000 },
    );
  });

  it('survives cyclic and non-serialisable payloads', () => {
    const cyclic: Record<string, unknown> = { ...valid.hello };
    cyclic.self = cyclic;
    expect(accept(cyclic)).toEqual({ ok: false, reason: 'size' });
    expect(accept(BigInt(1))).toEqual({ ok: false, reason: 'size' });
    expect(accept(undefined)).toEqual({ ok: false, reason: 'size' });
  });
});

describe('field stencils', () => {
  it('round-trips valid refs and rejects malformed ones', () => {
    const ref = { collection: 'posts', itemId: 'itm_1', field: 'title' };
    expect(decodeFieldRef(encodeFieldRef(ref))).toEqual(ref);
    for (const bad of ['', 'a/b', 'a/b/c/d', 'posts/itm 1/title', 'posts/itm_1/"><img>', null, undefined]) {
      expect(decodeFieldRef(bad)).toBeNull();
    }
  });
});
