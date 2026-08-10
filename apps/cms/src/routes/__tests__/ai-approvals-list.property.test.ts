import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

/**
 * Feature: ai-first-cms-engine, Property 11: Approvals list query — chỉ trả về pending của site hiện tại
 *
 * For any set of approval records (mix of siteIds and statuses),
 * the approvals list query logic:
 * - Returns ONLY records with status === 'pending' AND siteId === currentSiteId
 * - Sorted by createdAt DESC (newest first)
 * - Maximum 100 records
 *
 * **Validates: Requirements 5.1, 5.2**
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ApprovalRecord {
  id: string;
  siteId: string;
  agentName: string;
  skillName: string;
  arguments: Record<string, unknown>;
  status: 'pending' | 'approved' | 'rejected';
  context: string | null;
  createdAt: Date;
  decidedAt: Date | null;
  decidedBy: string | null;
}

/** One generated approvals-list scenario: the sites in play plus the records to query. */
interface ApprovalScenario {
  siteIds: string[];
  records: ApprovalRecord[];
  currentSiteId: string;
}

// ---------------------------------------------------------------------------
// Pure function that replicates the query logic from GET /approvals endpoint
// ---------------------------------------------------------------------------

/**
 * Simulates the database query logic of the GET /approvals endpoint:
 * SELECT * FROM ai_approvals
 * WHERE siteId = currentSiteId AND status = 'pending'
 * ORDER BY createdAt DESC
 * LIMIT 100
 */
function queryPendingApprovals(
  records: ApprovalRecord[],
  currentSiteId: string,
): ApprovalRecord[] {
  return records
    .filter((r) => r.siteId === currentSiteId && r.status === 'pending')
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, 100);
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const siteIdArb = fc.string({
  unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('')),
  minLength: 1,
  maxLength: 21,
});

const statusArb = fc.constantFrom('pending', 'approved', 'rejected') as fc.Arbitrary<
  'pending' | 'approved' | 'rejected'
>;

const approvalRecordArb = (siteIds: string[]): fc.Arbitrary<ApprovalRecord> =>
  fc.record({
    id: fc.string({ minLength: 21, maxLength: 21 }),
    siteId: fc.constantFrom(...siteIds),
    agentName: fc.constant('lumibase-copilot'),
    skillName: fc.string({ minLength: 1, maxLength: 30 }),
    arguments: fc.constant({} as Record<string, unknown>),
    status: statusArb,
    context: fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: null }),
    // noInvalidDate: a bounded fc.date() may still emit `Invalid Date` (it
    // defaults to false), and these tests order records by createdAt — NaN
    // timestamps are out of scope for the ordering property.
    createdAt: fc.date({
      min: new Date('2020-01-01'),
      max: new Date('2030-12-31'),
      noInvalidDate: true,
    }),
    decidedAt: fc.option(
      fc.date({
        min: new Date('2020-01-01'),
        max: new Date('2030-12-31'),
        noInvalidDate: true,
      }),
      { nil: null },
    ),
    decidedBy: fc.option(fc.string({ minLength: 1, maxLength: 21 }), { nil: null }),
  });

describe('Feature: ai-first-cms-engine, Property 11: Approvals list query', () => {
  it('should only return records with status pending AND matching siteId', () => {
    fc.assert(
      fc.property(
        // Generate 2-5 distinct siteIds
        fc
          .array(siteIdArb, { minLength: 2, maxLength: 5 })
          // Explicit scenario type: fast-check v4 infers readonly tuples from
          // literal shapes, so the two branches below no longer unify on their own.
          .chain((siteIds): fc.Arbitrary<ApprovalScenario> => {
            const uniqueSiteIds = [...new Set(siteIds)];
            // Ensure at least 2 unique siteIds
            if (uniqueSiteIds.length < 2) {
              return fc.constant({
                siteIds: [uniqueSiteIds[0]!, uniqueSiteIds[0]! + '_other'],
                records: [] as ApprovalRecord[],
                currentSiteId: uniqueSiteIds[0]!,
              });
            }
            return fc
              .tuple(
                fc.array(approvalRecordArb(uniqueSiteIds), { minLength: 0, maxLength: 50 }),
                fc.constantFrom(...uniqueSiteIds),
              )
              .map(([records, currentSiteId]) => ({
                siteIds: uniqueSiteIds,
                records,
                currentSiteId,
              }));
          }),
        ({ records, currentSiteId }) => {
          const result = queryPendingApprovals(records, currentSiteId);

          // Property: every returned record must have status 'pending' AND siteId === currentSiteId
          for (const record of result) {
            expect(record.status).toBe('pending');
            expect(record.siteId).toBe(currentSiteId);
          }

          // Property: no matching record should be missing from the result (up to 100)
          const expectedRecords = records.filter(
            (r) => r.siteId === currentSiteId && r.status === 'pending',
          );
          expect(result.length).toBe(Math.min(expectedRecords.length, 100));
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should sort results by createdAt DESC (newest first)', () => {
    fc.assert(
      fc.property(
        siteIdArb.chain((currentSiteId) =>
          fc
            .array(approvalRecordArb([currentSiteId]), { minLength: 2, maxLength: 50 })
            .map((records) => ({
              // Ensure some records are pending for this site
              records: records.map((r, i) => ({
                ...r,
                siteId: currentSiteId,
                status: (i % 2 === 0 ? 'pending' : r.status) as
                  | 'pending'
                  | 'approved'
                  | 'rejected',
              })),
              currentSiteId,
            })),
        ),
        ({ records, currentSiteId }) => {
          const result = queryPendingApprovals(records, currentSiteId);

          // Property: results must be sorted by createdAt descending
          for (let i = 1; i < result.length; i++) {
            expect(result[i - 1]!.createdAt.getTime()).toBeGreaterThanOrEqual(
              result[i]!.createdAt.getTime(),
            );
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should return at most 100 records', () => {
    fc.assert(
      fc.property(
        siteIdArb.chain((currentSiteId) =>
          fc
            .array(approvalRecordArb([currentSiteId]), { minLength: 100, maxLength: 150 })
            .map((records) => ({
              // Force all records to be pending for this site to exceed 100
              records: records.map((r) => ({
                ...r,
                siteId: currentSiteId,
                status: 'pending' as const,
              })),
              currentSiteId,
            })),
        ),
        ({ records, currentSiteId }) => {
          const result = queryPendingApprovals(records, currentSiteId);

          // Property: result must never exceed 100 records
          expect(result.length).toBeLessThanOrEqual(100);

          // When there are more than 100 pending records, exactly 100 should be returned
          const totalPending = records.filter(
            (r) => r.siteId === currentSiteId && r.status === 'pending',
          ).length;
          if (totalPending > 100) {
            expect(result.length).toBe(100);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should not return records from other sites', () => {
    fc.assert(
      fc.property(
        fc
          .tuple(siteIdArb, siteIdArb)
          .filter(([a, b]) => a !== b)
          .chain(([currentSiteId, otherSiteId]) =>
            fc
              .array(approvalRecordArb([currentSiteId, otherSiteId]), {
                minLength: 5,
                maxLength: 50,
              })
              .map((records) => ({ records, currentSiteId, otherSiteId })),
          ),
        ({ records, currentSiteId, otherSiteId }) => {
          const result = queryPendingApprovals(records, currentSiteId);

          // Property: no record from otherSiteId should appear in results
          for (const record of result) {
            expect(record.siteId).not.toBe(otherSiteId);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should not return approved or rejected records', () => {
    fc.assert(
      fc.property(
        siteIdArb.chain((currentSiteId) =>
          fc
            .array(approvalRecordArb([currentSiteId]), { minLength: 5, maxLength: 50 })
            .map((records) => ({ records, currentSiteId })),
        ),
        ({ records, currentSiteId }) => {
          const result = queryPendingApprovals(records, currentSiteId);

          // Property: no record with status 'approved' or 'rejected' should appear
          for (const record of result) {
            expect(record.status).not.toBe('approved');
            expect(record.status).not.toBe('rejected');
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
