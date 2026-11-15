import { describe, expect, it } from 'vitest';
import {
  effectivePublicationState,
  isPublishWrite,
  matchesPublicationState,
  publicationStamps,
  sameItemData,
} from '../publication-state';
import { parseRevisionRetention } from '../revision-retention';

const now = new Date('2026-11-15T10:00:00Z');
const earlier = new Date('2026-01-01T00:00:00Z');

describe('publicationStamps (#687)', () => {
  it('first publish stamps both timestamps and clears the flag', () => {
    expect(publicationStamps({ status: 'draft' }, { status: 'published', dataChanged: false }, now)).toEqual({
      publishedAt: now,
      firstPublishedAt: now,
      hasUnpublishedChanges: false,
    });
  });

  it('a create straight into published is a first publish', () => {
    expect(publicationStamps(null, { status: 'published', dataChanged: true }, now)).toMatchObject({
      firstPublishedAt: now,
      publishedAt: now,
    });
  });

  it('a re-publish never moves firstPublishedAt', () => {
    const stamps = publicationStamps(
      { status: 'draft', firstPublishedAt: earlier, hasUnpublishedChanges: true },
      { status: 'published', dataChanged: false },
      now,
    );
    expect(stamps).toEqual({ publishedAt: now, hasUnpublishedChanges: false });
  });

  it('editing a published item flips hasUnpublishedChanges', () => {
    expect(
      publicationStamps(
        { status: 'published', firstPublishedAt: earlier, hasUnpublishedChanges: false },
        { status: 'published', dataChanged: true },
        now,
      ),
    ).toEqual({ hasUnpublishedChanges: true });
  });

  it('an explicit status: published on a live item is a re-publish and clears the flag', () => {
    const prev = { status: 'published', firstPublishedAt: earlier, hasUnpublishedChanges: true };
    expect(isPublishWrite(prev, { status: 'published', dataChanged: true, publishRequested: true })).toBe(true);
    expect(publicationStamps(prev, { status: 'published', dataChanged: true, publishRequested: true }, now)).toEqual({
      publishedAt: now,
      hasUnpublishedChanges: false,
    });
  });

  it('editing a never-published draft changes nothing', () => {
    expect(publicationStamps({ status: 'draft' }, { status: 'draft', dataChanged: true }, now)).toEqual({});
  });

  it('editing an unpublished (previously published) item marks it modified', () => {
    expect(
      publicationStamps({ status: 'draft', firstPublishedAt: earlier }, { status: 'draft', dataChanged: true }, now),
    ).toEqual({ hasUnpublishedChanges: true });
  });

  it('a no-op save or a status-only unpublish leaves the stamps alone', () => {
    const prev = { status: 'published', firstPublishedAt: earlier, hasUnpublishedChanges: false };
    expect(publicationStamps(prev, { status: 'published', dataChanged: false }, now)).toEqual({});
    expect(publicationStamps(prev, { status: 'archived', dataChanged: false }, now)).toEqual({});
  });
});

describe('sameItemData', () => {
  it('ignores key order and undefined keys', () => {
    expect(sameItemData({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1, d: undefined })).toBe(true);
    expect(sameItemData({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameItemData({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
  });
});

describe('publication cohorts (#688)', () => {
  it('anonymous callers are clamped to live; unset stays unset', () => {
    expect(effectivePublicationState('preview', true)).toBe('live');
    expect(effectivePublicationState('all', true)).toBe('live');
    expect(effectivePublicationState('preview', false)).toBe('preview');
    expect(effectivePublicationState(undefined, true)).toBeUndefined();
  });

  it('live honours the publish window', () => {
    const past = new Date(now.getTime() - 1000);
    const future = new Date(now.getTime() + 1000);
    expect(matchesPublicationState({ status: 'published' }, 'live', now)).toBe(true);
    expect(matchesPublicationState({ status: 'published', publishAt: future }, 'live', now)).toBe(false);
    expect(matchesPublicationState({ status: 'published', unpublishAt: past }, 'live', now)).toBe(false);
    expect(matchesPublicationState({ status: 'draft' }, 'live', now)).toBe(false);
  });

  it('preview is draft + published; all is everything', () => {
    expect(matchesPublicationState({ status: 'draft' }, 'preview', now)).toBe(true);
    expect(matchesPublicationState({ status: 'archived' }, 'preview', now)).toBe(false);
    expect(matchesPublicationState({ status: 'archived' }, 'all', now)).toBe(true);
  });
});

describe('parseRevisionRetention (#693)', () => {
  it('reads a valid policy and rejects nonsense', () => {
    expect(parseRevisionRetention({ revisionRetention: { maxRevisions: 5, maxAgeDays: 30 } })).toEqual({
      maxRevisions: 5,
      maxAgeDays: 30,
    });
    expect(parseRevisionRetention({ revisionRetention: { maxRevisions: 0 } })).toBeNull();
    expect(parseRevisionRetention({ revisionRetention: { maxRevisions: 2.5, maxAgeDays: -1 } })).toBeNull();
    expect(parseRevisionRetention({})).toBeNull();
    expect(parseRevisionRetention(null)).toBeNull();
  });
});
