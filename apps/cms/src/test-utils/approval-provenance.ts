/**
 * Approval provenance fixtures for suites that drive `executeApproved` against a
 * mocked database.
 *
 * ## Why these exist
 *
 * `executeApproved` used to check only the decider's capabilities. Since #472 it
 * re-resolves the **requester** as well and runs with the intersection, which
 * means it now reads `agent_approvals.requested_by_principal` and then reads the
 * RBAC bundle for whoever is named there.
 *
 * Suites that model the database with a shallow chainable mock cannot satisfy the
 * second read: the resolver walks users, memberships, roles and policies, and a
 * mock that answers every `select()` with the same array would resolve to
 * something arbitrary. Those suites are about other properties — "a failing skill
 * leaves the approval pending", "a concurrent decision wins" — so the resolution
 * is stubbed to a known answer rather than simulated.
 *
 * The real behaviour is measured where it can be: `g2-approval-requester.db.integration.test.ts`
 * exercises revoke / expire / demote / deactivate / lost-membership /
 * disabled-role / missing-and-malformed provenance against Postgres, including
 * the positive least-privilege case. Stubbing here does not reduce that coverage;
 * it keeps these suites measuring what they were written for.
 */

import type { ApprovalRequester, ApprovalRequesterResolution } from '../services/approval-requester';

/**
 * Stored provenance for a user requester on `siteId`.
 *
 * Shaped to survive the real `parseApprovalRequester`, so a suite using it still
 * exercises parsing even when resolution is stubbed.
 */
export function requesterProvenance(siteId: string, userId = 'requester-user'): ApprovalRequester {
  return { kind: 'principal', ref: { type: 'user', siteId, userId } };
}

/** Resolution stub: requester still allowed, with no enumerated limit. */
export const REQUESTER_ALLOWED_UNLIMITED: ApprovalRequesterResolution = {
  allowed: true,
  capabilities: ['*'],
};

/**
 * Factory for `vi.mock('../approval-requester', …)`.
 *
 * Keeps `parseApprovalRequester` and `effectiveApprovalCapabilities` real — the
 * first is pure and the second is the intersection rule under test elsewhere —
 * and replaces only the database-backed resolution.
 */
export async function approvalRequesterModuleMock(
  importOriginal: () => Promise<unknown>,
  resolution: ApprovalRequesterResolution = REQUESTER_ALLOWED_UNLIMITED,
): Promise<Record<string, unknown>> {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveApprovalRequester: async () => resolution,
  };
}
