import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { reviewDomainFor, sharesGoalTree } from '../reviewer-service';

/**
 * Feature: content-os, Property 8: self-review is forbidden.
 *
 * An approval that belongs to goal-tree G can never be decided by a run
 * that belongs to G. The predicate is a pure ancestry-path comparison:
 * two paths are the same tree iff they share any goal id — sharing the
 * root, sharing an intermediate ancestor, or being the same goal all count.
 *
 * **Validates: Requirements 11.3**
 */

const goalIdArb = fc.string({ minLength: 4, maxLength: 12 }).map((s) => `goal_${s}`);
const pathArb = fc.uniqueArray(goalIdArb, { minLength: 1, maxLength: 8 });

describe('Feature: content-os, Property 8: self-review forbidden', () => {
  it('any run inside the subject goal tree is rejected (shared ancestor)', () => {
    fc.assert(
      fc.property(pathArb, pathArb, fc.nat(), (subjectPath, reviewerExtra, pick) => {
        // Reviewer path shares one node with the subject path — same tree.
        const shared = subjectPath[pick % subjectPath.length]!;
        const reviewerPath = [...reviewerExtra.filter((g) => !subjectPath.includes(g)), shared];
        expect(sharesGoalTree(subjectPath, reviewerPath)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('a run reviewing its own goal is always self-review', () => {
    fc.assert(
      fc.property(pathArb, (path) => {
        expect(sharesGoalTree(path, path)).toBe(true);
        expect(sharesGoalTree(path, [path[0]!])).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('disjoint goal trees are never flagged as self-review', () => {
    fc.assert(
      fc.property(pathArb, pathArb, (subjectPath, reviewerRaw) => {
        const subject = new Set(subjectPath);
        const reviewerPath = reviewerRaw
          .filter((g) => !subject.has(g))
          .map((g) => `${g}_other`);
        fc.pre(reviewerPath.length > 0);
        expect(sharesGoalTree(subjectPath, reviewerPath)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it('the predicate is symmetric', () => {
    fc.assert(
      fc.property(pathArb, pathArb, (a, b) => {
        expect(sharesGoalTree(a, b)).toBe(sharesGoalTree(b, a));
      }),
      { numRuns: 200 },
    );
  });
});

describe('Feature: content-os, review domains (Req 11.2)', () => {
  it('schema-shaped tools require review:schema, item tools review:items', () => {
    expect(reviewDomainFor('tool_call', 'createCollection')).toBe('schema');
    expect(reviewDomainFor('tool_call', 'deleteField')).toBe('schema');
    expect(reviewDomainFor('tool_call', 'applySchemaDiff')).toBe('schema');
    expect(reviewDomainFor('tool_call', 'updateItem')).toBe('items');
    expect(reviewDomainFor('tool_call', 'deleteItem')).toBe('items');
    expect(reviewDomainFor('tool_call', undefined)).toBe('items');
    expect(reviewDomainFor('plan')).toBe('plans');
    expect(reviewDomainFor('artifact')).toBe('artifacts');
  });
});
