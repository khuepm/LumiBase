import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  detectAccessConflicts,
  type AccessConflictReport,
  type AccessPermissionInput,
} from '../access-conflicts';
import type { PermissionAction } from '../permission-service';

const collectionArb = fc.constantFrom('posts', 'pages', 'products');
const actionArb = fc.constantFrom<PermissionAction>('create', 'read', 'update', 'delete', 'share');
const fieldArb = fc.constantFrom('title', 'status', 'owner', 'category');
const valueArb = fc.constantFrom('draft', 'review', 'published', '$CURRENT_USER', 'system');

function permission(patch: Partial<AccessPermissionInput>): AccessPermissionInput {
  return {
    policyId: 'policy_a',
    policyName: 'Policy A',
    collection: 'posts',
    action: 'read',
    permissions: {},
    validation: {},
    presets: {},
    fields: ['*'],
    ...patch,
  };
}

function pairFor(
  base: Pick<AccessPermissionInput, 'collection' | 'action'>,
  a: Partial<AccessPermissionInput>,
  b: Partial<AccessPermissionInput>,
): AccessPermissionInput[] {
  return [
    permission({
      ...base,
      policyId: 'policy_a',
      policyName: 'Policy A',
      ...a,
    }),
    permission({
      ...base,
      policyId: 'policy_b',
      policyName: 'Policy B',
      ...b,
    }),
  ];
}

function reportFor(permissions: AccessPermissionInput[]): AccessConflictReport {
  return detectAccessConflicts({
    policies: [
      { id: 'policy_a', name: 'Policy A' },
      { id: 'policy_b', name: 'Policy B' },
    ],
    permissions,
  });
}

function hasConflict(report: AccessConflictReport, reason: string): boolean {
  return report.conflicts.some((conflict) => conflict.reason === reason);
}

function hasWarning(report: AccessConflictReport, reason: string): boolean {
  return report.warnings.some((warning) => warning.reason === reason);
}

describe('detectAccessConflicts properties', () => {
  it('blocks unconditional rows combined with restricted rows on the same collection/action', () => {
    fc.assert(
      fc.property(collectionArb, actionArb, fieldArb, valueArb, (collection, action, field, value) => {
        const report = reportFor(
          pairFor(
            { collection, action },
            { permissions: {} },
            { permissions: { [field]: { _eq: value } } },
          ),
        );

        expect(report.ok).toBe(false);
        expect(hasConflict(report, 'UNCONDITIONAL_RULE_WIDENS_RESTRICTED_RULE')).toBe(true);
      }),
    );
  });

  it('blocks all-fields rows combined with whitelisted rows on the same collection/action', () => {
    fc.assert(
      fc.property(collectionArb, actionArb, fieldArb, (collection, action, field) => {
        const report = reportFor(
          pairFor(
            { collection, action },
            { permissions: { status: { _eq: 'published' } }, fields: ['*'] },
            { permissions: { status: { _eq: 'published' } }, fields: [field] },
          ),
        );

        expect(report.ok).toBe(false);
        expect(hasConflict(report, 'ALL_FIELDS_WIDENS_FIELD_WHITELIST')).toBe(true);
      }),
    );
  });

  it('blocks conflicting validation values for the same field', () => {
    fc.assert(
      fc.property(collectionArb, actionArb, fieldArb, (collection, action, field) => {
        const report = reportFor(
          pairFor(
            { collection, action },
            {
              permissions: { status: { _eq: 'published' } },
              fields: ['title'],
              validation: { [field]: { _eq: 'draft' } },
            },
            {
              permissions: { status: { _eq: 'published' } },
              fields: ['title'],
              validation: { [field]: { _eq: 'review' } },
            },
          ),
        );

        expect(report.ok).toBe(false);
        expect(hasConflict(report, 'CONFLICTING_VALIDATION_FOR_SAME_FIELD')).toBe(true);
      }),
    );
  });

  it('blocks conflicting preset values for the same field', () => {
    fc.assert(
      fc.property(collectionArb, actionArb, fieldArb, (collection, action, field) => {
        const report = reportFor(
          pairFor(
            { collection, action },
            {
              permissions: { status: { _eq: 'published' } },
              fields: ['title'],
              presets: { [field]: '$CURRENT_USER' },
            },
            {
              permissions: { status: { _eq: 'published' } },
              fields: ['title'],
              presets: { [field]: 'system' },
            },
          ),
        );

        expect(report.ok).toBe(false);
        expect(hasConflict(report, 'CONFLICTING_PRESET_FOR_SAME_FIELD')).toBe(true);
      }),
    );
  });

  it('warns for conditional overlaps without blocking field, validation, or preset conflicts', () => {
    fc.assert(
      fc.property(collectionArb, actionArb, (collection, action) => {
        const report = reportFor(
          pairFor(
            { collection, action },
            {
              permissions: { owner: { _eq: '$CURRENT_USER' } },
              fields: ['title'],
              validation: { status: { _eq: 'published' } },
              presets: { owner: '$CURRENT_USER' },
            },
            {
              permissions: { status: { _eq: 'published' } },
              fields: ['title', 'status'],
              validation: { category: { _eq: 'news' } },
              presets: { reviewed_by: 'system' },
            },
          ),
        );

        expect(report.ok).toBe(true);
        expect(report.conflicts).toHaveLength(0);
        expect(hasWarning(report, 'OVERLAPPING_PERMISSION_REQUIRES_REVIEW')).toBe(true);
      }),
    );
  });

  it('does not report identical permission rows', () => {
    fc.assert(
      fc.property(collectionArb, actionArb, fieldArb, valueArb, (collection, action, field, value) => {
        const row = {
          permissions: { [field]: { _eq: value } },
          validation: { status: { _eq: 'published' } },
          presets: { owner: '$CURRENT_USER' },
          fields: ['title', 'status'],
        };

        const report = reportFor(pairFor({ collection, action }, row, row));

        expect(report.ok).toBe(true);
        expect(report.conflicts).toHaveLength(0);
        expect(report.warnings).toHaveLength(0);
      }),
    );
  });

  it('does not compare rows with different collection or action keys', () => {
    fc.assert(
      fc.property(collectionArb, actionArb, actionArb, (collection, action, otherAction) => {
        fc.pre(action !== otherAction);

        const report = reportFor([
          permission({
            policyId: 'policy_a',
            policyName: 'Policy A',
            collection,
            action,
            permissions: {},
          }),
          permission({
            policyId: 'policy_b',
            policyName: 'Policy B',
            collection,
            action: otherAction,
            permissions: { status: { _eq: 'published' } },
          }),
          permission({
            policyId: 'policy_c',
            policyName: 'Policy C',
            collection: `${collection}_archive`,
            action,
            permissions: { status: { _eq: 'published' } },
          }),
        ]);

        expect(report.ok).toBe(true);
        expect(report.conflicts).toHaveLength(0);
        expect(report.warnings).toHaveLength(0);
      }),
    );
  });

  it('blocks TFA policies attached to API key targets', () => {
    fc.assert(
      fc.property(fc.boolean(), (adminAccess) => {
        const report = detectAccessConflicts({
          targetType: 'api_key',
          policies: [{ id: 'policy_tfa', name: 'TFA policy', enforceTfa: true, adminAccess }],
          permissions: [],
        });

        expect(report.ok).toBe(false);
        expect(hasConflict(report, 'TFA_POLICY_CANNOT_ATTACH_TO_API_KEY')).toBe(true);
      }),
    );
  });
});
