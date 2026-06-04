import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  detectAccessConflicts,
  type AccessPermissionInput,
} from '../access-conflicts';
import type { PermissionAction } from '../permission-service';

const actionArb = fc.constantFrom<PermissionAction>('create', 'read', 'update', 'delete', 'share');
const collectionArb = fc.constantFrom('posts', 'pages', 'articles', 'products');
const fieldArb = fc.constantFrom('title', 'status', 'body', 'owner', 'category');
const valueArb = fc.oneof(
  fc.string({ minLength: 1, maxLength: 12 }),
  fc.integer({ min: -10, max: 10 }),
  fc.boolean(),
);

function permission(patch: Partial<AccessPermissionInput> = {}): AccessPermissionInput {
  return {
    policyId: 'policy_a',
    policyName: 'Policy A',
    collection: 'posts',
    action: 'read',
    permissions: { status: { _eq: 'published' } },
    validation: {},
    presets: {},
    fields: ['title'],
    ...patch,
  };
}

function pair(
  a: AccessPermissionInput,
  b: AccessPermissionInput,
) {
  return {
    policies: [
      { id: a.policyId, name: a.policyName },
      { id: b.policyId, name: b.policyName },
    ],
    permissions: [a, b],
  };
}

describe('detectAccessConflicts properties', () => {
  it('does not report conflicts for identical permission rows regardless of field order', () => {
    fc.assert(
      fc.property(
        collectionArb,
        actionArb,
        fc.uniqueArray(fieldArb, { minLength: 1 }),
        (collection, action, fields) => {
          const a = permission({
            policyId: 'policy_a',
            policyName: 'Policy A',
            collection,
            action,
            fields,
            permissions: { status: { _eq: 'published' } },
            validation: { status: { _in: ['published', 'draft'] } },
            presets: { owner: '$CURRENT_USER' },
          });
          const b = permission({
            ...a,
            policyId: 'policy_b',
            policyName: 'Policy B',
            fields: [...fields].reverse(),
          });

          const report = detectAccessConflicts(pair(a, b));
          expect(report.ok).toBe(true);
          expect(report.conflicts).toHaveLength(0);
          expect(report.warnings).toHaveLength(0);
        },
      ),
    );
  });

  it('always blocks unconditional rules mixed with restricted rules on the same target', () => {
    fc.assert(
      fc.property(collectionArb, actionArb, fieldArb, valueArb, (collection, action, field, value) => {
        const report = detectAccessConflicts(pair(
          permission({
            policyId: 'policy_a',
            policyName: 'All rows',
            collection,
            action,
            permissions: {},
          }),
          permission({
            policyId: 'policy_b',
            policyName: 'Restricted rows',
            collection,
            action,
            permissions: { [field]: { _eq: value } },
          }),
        ));

        expect(report.ok).toBe(false);
        expect(report.conflicts.map((c) => c.reason)).toContain(
          'UNCONDITIONAL_RULE_WIDENS_RESTRICTED_RULE',
        );
      }),
    );
  });

  it('always blocks all-fields access mixed with a field whitelist', () => {
    fc.assert(
      fc.property(
        collectionArb,
        actionArb,
        fc.uniqueArray(fieldArb, { minLength: 1 }).filter((fields) => !fields.includes('*')),
        (collection, action, fields) => {
          const report = detectAccessConflicts(pair(
            permission({
              policyId: 'policy_a',
              policyName: 'All fields',
              collection,
              action,
              fields: ['*'],
            }),
            permission({
              policyId: 'policy_b',
              policyName: 'Limited fields',
              collection,
              action,
              fields,
            }),
          ));

          expect(report.ok).toBe(false);
          expect(report.conflicts.map((c) => c.reason)).toContain(
            'ALL_FIELDS_WIDENS_FIELD_WHITELIST',
          );
        },
      ),
    );
  });

  it('always blocks conflicting validation or preset values for an overlapping field', () => {
    fc.assert(
      fc.property(collectionArb, actionArb, fieldArb, valueArb, valueArb, (collection, action, field, aValue, bValue) => {
        fc.pre(JSON.stringify(aValue) !== JSON.stringify(bValue));

        const report = detectAccessConflicts(pair(
          permission({
            policyId: 'policy_a',
            policyName: 'Validation A',
            collection,
            action,
            validation: { [field]: { _eq: aValue } },
            presets: { [field]: aValue },
          }),
          permission({
            policyId: 'policy_b',
            policyName: 'Validation B',
            collection,
            action,
            validation: { [field]: { _eq: bValue } },
            presets: { [field]: bValue },
          }),
        ));

        expect(report.ok).toBe(false);
        expect(report.conflicts.map((c) => c.reason)).toContain(
          'CONFLICTING_VALIDATION_FOR_SAME_FIELD',
        );
      }),
    );
  });

  it('warns rather than blocks for compatible conditional overlap that still needs review', () => {
    fc.assert(
      fc.property(collectionArb, actionArb, fieldArb, fieldArb, (collection, action, aField, bField) => {
        fc.pre(aField !== bField);

        const report = detectAccessConflicts(pair(
          permission({
            policyId: 'policy_a',
            policyName: 'Condition A',
            collection,
            action,
            fields: ['title'],
            permissions: { [aField]: { _eq: 'a' } },
            validation: {},
            presets: {},
          }),
          permission({
            policyId: 'policy_b',
            policyName: 'Condition B',
            collection,
            action,
            fields: ['title', 'status'],
            permissions: { [bField]: { _eq: 'b' } },
            validation: {},
            presets: {},
          }),
        ));

        expect(report.ok).toBe(true);
        expect(report.conflicts).toHaveLength(0);
        expect(report.warnings.map((w) => w.reason)).toContain(
          'OVERLAPPING_PERMISSION_REQUIRES_REVIEW',
        );
      }),
    );
  });
});
