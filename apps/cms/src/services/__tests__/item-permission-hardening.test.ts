import { describe, expect, it } from 'vitest';
import type { CompiledPermission } from '../permission-service';
import {
  ItemServiceError,
  assertPrimaryKeyAvailable,
  assertWritablePermissionFields,
  buildPermissionSnapshot,
  resolvePrimaryKey,
} from '../item-service';
import { evaluate, type MagicContext } from '../permission-dsl';
import type { PolicyRule } from '@lumibase/shared';

const ctx: MagicContext = {
  userId: 'user-1',
  siteId: 'site-1',
  roleId: 'role-1',
  ip: '127.0.0.1',
  headers: {},
  roles: ['role-1', 'role-editor'],
  policies: ['policy-editor'],
  apiKey: { id: 'key-1' },
  user: {
    id: 'user-1',
    email: 'editor@example.com',
    profile: { locale: 'vi' },
  },
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

  it('resolves expanded magic vars inside permission rules', () => {
    const rule = {
      _and: [
        { role_id: { _in: '$CURRENT_ROLES' } },
        { policy_id: { _in: '$CURRENT_POLICIES' } },
        { api_key_id: { _eq: '$CURRENT_API_KEY' } },
        { owner_email: { _eq: '$CURRENT_USER.email' } },
        { locale: { _eq: '$CURRENT_USER.profile.locale' } },
        { publish_at: { _lte: '$NOW(+1 day)' } },
      ],
    } as unknown as PolicyRule;

    expect(
      evaluate(
        rule,
        {
          role_id: 'role-editor',
          policy_id: 'policy-editor',
          api_key_id: 'key-1',
          owner_email: 'editor@example.com',
          locale: 'vi',
          publish_at: '2026-06-04T00:00:00.000Z',
        },
        ctx,
      ),
    ).toBe(true);
  });

  it('fails closed for unknown operators and unknown magic vars', () => {
    expect(
      evaluate({ owner: { _unknown: 'user-1' } } as unknown as PolicyRule, { owner: 'user-1' }, ctx),
    ).toBe(false);

    expect(
      evaluate({ owner: { _eq: '$NOT_A_MAGIC_VAR' } } as unknown as PolicyRule, { owner: '$NOT_A_MAGIC_VAR' }, ctx),
    ).toBe(false);

    expect(
      evaluate({ _not: { owner: { _eq: '$NOT_A_MAGIC_VAR' } } } as unknown as PolicyRule, { owner: 'user-1' }, ctx),
    ).toBe(false);
  });

  it('supports null, empty, regex, and case-insensitive string operators', () => {
    const item = {
      title: 'LumiBase Launch',
      subtitle: '',
      deleted_at: null,
      summary: 'Composable content platform',
    };

    expect(evaluate({ deleted_at: { _null: true } } as unknown as PolicyRule, item, ctx)).toBe(true);
    expect(evaluate({ title: { _nempty: true } } as unknown as PolicyRule, item, ctx)).toBe(true);
    expect(evaluate({ subtitle: { _empty: true } } as unknown as PolicyRule, item, ctx)).toBe(true);
    expect(evaluate({ title: { _regex: '^LumiBase' } } as unknown as PolicyRule, item, ctx)).toBe(true);
    expect(evaluate({ summary: { _icontains: 'CONTENT' } } as unknown as PolicyRule, item, ctx)).toBe(true);
    expect(evaluate({ title: { _istarts_with: 'lumi' } } as unknown as PolicyRule, item, ctx)).toBe(true);
    expect(evaluate({ title: { _iends_with: 'LAUNCH' } } as unknown as PolicyRule, item, ctx)).toBe(true);
  });
});

describe('ItemService primary key strategy helpers', () => {
  it('uses the item data value for string primary keys', () => {
    expect(
      resolvePrimaryKey(
        { field: 'id', type: 'string', storageMode: 'jsonb' },
        { id: 'post-custom-id' },
      ),
    ).toEqual({
      field: 'id',
      type: 'string',
      storageMode: 'jsonb',
      id: 'post-custom-id',
    });
  });

  it('requires a string value for string primary keys', () => {
    expect(() =>
      resolvePrimaryKey(
        { field: 'id', type: 'string', storageMode: 'jsonb' },
        { title: 'Missing id' },
      ),
    ).toThrowError(ItemServiceError);
  });

  it('generates UUID primary keys in the service layer', () => {
    const resolved = resolvePrimaryKey(
      { field: 'id', type: 'uuid', storageMode: 'jsonb' },
      {},
    );

    expect(resolved.type).toBe('uuid');
    expect(resolved.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('blocks integer sequences for jsonb storage until sequence support exists', () => {
    expect(() =>
      resolvePrimaryKey(
        { field: 'id', type: 'integer', storageMode: 'jsonb' },
        {},
      ),
    ).toThrowError(/materialized or physical/);
  });

  it('returns a 409 error for duplicate user-provided IDs', () => {
    try {
      assertPrimaryKeyAvailable('post-custom-id', true);
      throw new Error('Expected duplicate primary key to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ItemServiceError);
      expect((err as ItemServiceError).code).toBe('ITEM_ID_EXISTS');
      expect((err as ItemServiceError).status).toBe(409);
    }
  });
});
