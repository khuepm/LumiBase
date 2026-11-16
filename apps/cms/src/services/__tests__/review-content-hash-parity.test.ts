/**
 * #514 — `@lumibase/sdk` `reviewContentHash` must equal the CMS hash stored as
 * `ReviewRun.contentHash`. Snapshot staleness on feedback rests entirely on
 * the client sending the hash of the draft it shows now; if the two
 * implementations drift, every snapshot accept turns into a false 409
 * `REVIEW_STALE` (or a real change goes undetected).
 */
import { reviewContentHash as sdkReviewContentHash } from '@lumibase/sdk';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { reviewContentHash as cmsReviewContentHash } from '../review-service';

describe('review content hash: SDK ↔ CMS parity', () => {
  it.each([
    ['flat draft', { title: 'Summer sale', body: 'Buy now' }],
    ['nested, unsorted, with arrays', { body: { y: [2, { b: 1, a: 2 }], x: 1 }, title: 'A' }],
    ['undefined dropped, null kept', { title: 'A', extra: undefined, empty: null }],
    ['dates serialised', { publishedAt: new Date('2026-10-14T00:00:00.000Z') }],
    ['Vietnamese text', { title: 'Tiêu đề bài viết', body: 'Nội dung có dấu: ă â đ ê ô ơ ư' }],
  ])('agrees on %s', async (_name, values) => {
    expect(await sdkReviewContentHash(values)).toBe(await cmsReviewContentHash(values));
  });

  it('agrees on arbitrary JSON objects', async () => {
    await fc.assert(
      fc.asyncProperty(fc.dictionary(fc.string(), fc.jsonValue()), async (values) => {
        expect(await sdkReviewContentHash(values)).toBe(await cmsReviewContentHash(values));
      }),
      { numRuns: 200 },
    );
  });
});
