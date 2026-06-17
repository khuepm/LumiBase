import { describe, it, expect } from 'vitest';
import {
  applyTransition,
  canTransition,
  assertEditorialGate,
  statusForEditorialState,
  editorialStateFromStatus,
  EditorialError,
} from '../editorial-service';

describe('editorial transition table (Req 8.4)', () => {
  it('allows the canonical review path', () => {
    expect(applyTransition('draft', 'submit_review')).toBe('in_review');
    expect(applyTransition('in_review', 'approve')).toBe('approved');
    expect(applyTransition('approved', 'publish')).toBe('published');
  });

  it('supports schedule then publish', () => {
    expect(applyTransition('approved', 'schedule')).toBe('scheduled');
    expect(applyTransition('scheduled', 'publish')).toBe('published');
  });

  it('rejects then revises back to draft and resubmits', () => {
    expect(applyTransition('in_review', 'reject')).toBe('rejected');
    expect(applyTransition('rejected', 'revise')).toBe('draft');
    expect(applyTransition('rejected', 'submit_review')).toBe('in_review');
  });

  it('throws INVALID_TRANSITION for illegal moves', () => {
    expect(() => applyTransition('draft', 'approve')).toThrowError(EditorialError);
    try {
      applyTransition('draft', 'publish');
    } catch (e) {
      expect((e as EditorialError).code).toBe('INVALID_TRANSITION');
      expect((e as EditorialError).status).toBe(409);
    }
    expect(canTransition('published', 'approve')).toBe(false);
  });
});

describe('editorial gate (Req 8.2)', () => {
  it('blocks direct draft -> published', () => {
    try {
      assertEditorialGate('draft', 'published');
      throw new Error('expected to throw');
    } catch (e) {
      expect((e as EditorialError).code).toBe('EDITORIAL_GATE_REQUIRED');
      expect((e as EditorialError).status).toBe(409);
    }
    expect(() => assertEditorialGate('in_review', 'published')).toThrow();
  });

  it('allows publish from approved/scheduled/published', () => {
    expect(() => assertEditorialGate('approved', 'published')).not.toThrow();
    expect(() => assertEditorialGate('scheduled', 'published')).not.toThrow();
    expect(() => assertEditorialGate('published', 'published')).not.toThrow();
  });

  it('ignores non-published targets', () => {
    expect(() => assertEditorialGate('draft', 'draft')).not.toThrow();
    expect(() => assertEditorialGate('draft', 'archived')).not.toThrow();
  });
});

describe('editorial <-> status mapping (Req 8.1)', () => {
  it('maps published state to published status, others to draft', () => {
    expect(statusForEditorialState('published')).toBe('published');
    expect(statusForEditorialState('approved')).toBe('draft');
    expect(statusForEditorialState('in_review')).toBe('draft');
  });

  it('derives editorial state from status', () => {
    expect(editorialStateFromStatus('published')).toBe('published');
    expect(editorialStateFromStatus('draft')).toBe('draft');
    expect(editorialStateFromStatus('archived')).toBe('draft');
  });
});
