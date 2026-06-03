import { describe, expect, it } from 'vitest';
import {
  detectAccessConflicts,
  type AccessPermissionInput,
} from '../access-conflicts';

const basePermission = (
  patch: Partial<AccessPermissionInput>,
): AccessPermissionInput => ({
  policyId: 'policy_a',
  policyName: 'Policy A',
  collection: 'posts',
  action: 'read',
  permissions: {},
  validation: {},
  presets: {},
  fields: ['*'],
  ...patch,
});

describe('detectAccessConflicts', () => {
  it('blocks an unconditional rule combined with a restricted rule', () => {
    const report = detectAccessConflicts({
      policies: [
        { id: 'policy_a', name: 'All posts' },
        { id: 'policy_b', name: 'Published posts' },
      ],
      permissions: [
        basePermission({ policyId: 'policy_a', policyName: 'All posts' }),
        basePermission({
          policyId: 'policy_b',
          policyName: 'Published posts',
          permissions: { status: { _eq: 'published' } },
        }),
      ],
    });

    expect(report.ok).toBe(false);
    expect(report.conflicts).toEqual([
      expect.objectContaining({
        severity: 'blocking',
        collection: 'posts',
        action: 'read',
        reason: 'UNCONDITIONAL_RULE_WIDENS_RESTRICTED_RULE',
      }),
    ]);
  });

  it('blocks all-fields access combined with a field whitelist', () => {
    const report = detectAccessConflicts({
      policies: [
        { id: 'policy_a', name: 'All fields' },
        { id: 'policy_b', name: 'Limited fields' },
      ],
      permissions: [
        basePermission({ policyId: 'policy_a', policyName: 'All fields' }),
        basePermission({
          policyId: 'policy_b',
          policyName: 'Limited fields',
          fields: ['title', 'status'],
        }),
      ],
    });

    expect(report.ok).toBe(false);
    expect(report.conflicts[0]).toMatchObject({
      reason: 'ALL_FIELDS_WIDENS_FIELD_WHITELIST',
    });
  });

  it('blocks conflicting validation or preset values for the same field', () => {
    const report = detectAccessConflicts({
      policies: [
        { id: 'policy_a', name: 'Draft validation' },
        { id: 'policy_b', name: 'Review validation' },
      ],
      permissions: [
        basePermission({
          policyId: 'policy_a',
          policyName: 'Draft validation',
          fields: ['status'],
          validation: { status: { _eq: 'draft' } },
          presets: { owner: '$CURRENT_USER' },
        }),
        basePermission({
          policyId: 'policy_b',
          policyName: 'Review validation',
          fields: ['status'],
          validation: { status: { _eq: 'review' } },
          presets: { owner: 'system' },
        }),
      ],
    });

    expect(report.ok).toBe(false);
    expect(report.conflicts.map((c) => c.reason)).toContain(
      'CONFLICTING_VALIDATION_FOR_SAME_FIELD',
    );
  });

  it('warns on overlapping conditional permissions that require review', () => {
    const report = detectAccessConflicts({
      policies: [
        { id: 'policy_a', name: 'Own posts' },
        { id: 'policy_b', name: 'Published posts' },
      ],
      permissions: [
        basePermission({
          policyId: 'policy_a',
          policyName: 'Own posts',
          fields: ['title'],
          permissions: { user_created: { _eq: '$CURRENT_USER' } },
        }),
        basePermission({
          policyId: 'policy_b',
          policyName: 'Published posts',
          fields: ['title', 'status'],
          permissions: { status: { _eq: 'published' } },
        }),
      ],
    });

    expect(report.ok).toBe(true);
    expect(report.warnings).toEqual([
      expect.objectContaining({
        severity: 'warning',
        reason: 'OVERLAPPING_PERMISSION_REQUIRES_REVIEW',
      }),
    ]);
  });

  it('blocks admin bypass mixed with granular policies', () => {
    const report = detectAccessConflicts({
      policies: [
        { id: 'policy_admin', name: 'Administrator', adminAccess: true },
        { id: 'policy_editor', name: 'Editor' },
      ],
      permissions: [],
    });

    expect(report.ok).toBe(false);
    expect(report.conflicts[0]).toMatchObject({
      reason: 'ADMIN_POLICY_WITH_GRANULAR_POLICY',
    });
  });

  it('blocks TFA policies for API key targets', () => {
    const report = detectAccessConflicts({
      targetType: 'api_key',
      policies: [{ id: 'policy_tfa', name: 'TFA policy', enforceTfa: true }],
      permissions: [],
    });

    expect(report.ok).toBe(false);
    expect(report.conflicts[0]).toMatchObject({
      reason: 'TFA_POLICY_CANNOT_ATTACH_TO_API_KEY',
    });
  });
});
