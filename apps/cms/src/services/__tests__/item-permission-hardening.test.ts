import { describe, expect, it } from 'vitest';
import type { CompiledPermission } from '../permission-service';
import {
  ItemServiceError,
  assertWritablePermissionFields,
  buildPermissionSnapshot,
} from '../item-service';
import { evaluate, type MagicContext } from '../permission-dsl';
import type { PolicyRule } from '@lumibase/shared';

const ctx: MagicContext = {
  userId: 'user-1',
  siteId: 'site-1',
  roleId: 'role-1',
  ip: '127.0.0.1',
  headers: {},
  roles: ['role-1'],
  policies: ['policy_editor'],
  user: { id: 'user-1', email: 'user@example.com' },
  now: new Date('2026-06-03T00:00:00.000Z'),
};

function permission(overrides: Partial<CompiledPermission> = {}): CompiledPermission {
  return {
    collection: 'posts',
    action: 'update',
    rule: null,
    fields: ['title', 'status'],
    presets: {},
    validation: {},
    sources: [{ policyId: 'policy_editor', policyName: 'Editor' }],
    ...overrides,
  };
}

describe('ItemService permission hardening helpers', () => {
  it('rejects writes to data fields outside the permission whitelist', () => {
    expect(() =>
      assertWritablePermissionFields(
        permission(),
        ['title', 'status', 'secret'],
        { title: 'Allowed', secret: 'Denied' },
      ),
    ).toThrowError(ItemServiceError);
  });

  it('applies blacklist entries when checking writable fields', () => {
    expect(() =>
      assertWritablePermissionFields(
        permission({ fields: ['*', '-secret'] }),
        ['title', 'status', 'secret'],
        { title: 'Allowed', secret: 'Denied' },
      ),
    ).toThrowError(/secret/);
  });

  it('treats structural status as a writable permission field', () => {
    expect(() =>
      assertWritablePermissionFields(
        permission({ fields: ['title'] }),
        ['title', 'status', 'sort'],
        { title: 'Allowed' },
        { status: 'published' },
      ),
    ).toThrowError(/status/);
  });

  it('builds snapshots that permission validation can evaluate with magic vars', () => {
    const snapshot = buildPermissionSnapshot({
      data: { title: 'Post', owner: 'user-1' },
      status: 'published',
      sort: 0,
      userCreated: 'user-1',
      userUpdated: 'user-1',
    });

    const validation = {
      _and: [
        { status: { _eq: 'published' } },
        { owner: { _eq: '$CURRENT_USER' } },
      ],
    } as PolicyRule;

    expect(evaluate(validation, snapshot, ctx)).toBe(true);
  });
});
