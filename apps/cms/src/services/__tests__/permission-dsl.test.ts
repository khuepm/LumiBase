import { describe, expect, it } from 'vitest';
import type { PolicyRule } from '@lumibase/contracts';
import {
  UNKNOWN_MAGIC,
  evaluate,
  resolveMagic,
  type MagicContext,
} from '../permission-dsl';

const ctx: MagicContext = {
  userId: 'user-1',
  siteId: 'site-1',
  roleId: 'role-editor',
  ip: '127.0.0.1',
  headers: { 'x-request-source': 'studio' },
  now: new Date('2026-06-04T10:00:00.000Z'),
  user: {
    id: 'user-1',
    email: 'editor@example.com',
    status: 'active',
    profile: { department: 'news' },
  },
  roles: ['role-editor', 'role-reviewer'],
  policies: ['policy_editor'],
  apiKey: { id: 'key-1', name: 'Import Bot' },
};

describe('permission DSL magic variables', () => {
  it('resolves current roles, policies, api key, nested user fields, and shifted now', () => {
    expect(resolveMagic('$CURRENT_ROLES', ctx)).toEqual(['role-editor', 'role-reviewer']);
    expect(resolveMagic('$CURRENT_POLICIES', ctx)).toEqual(['policy_editor']);
    expect(resolveMagic('$CURRENT_API_KEY', ctx)).toBe('key-1');
    expect(resolveMagic('$CURRENT_API_KEY.name', ctx)).toBe('Import Bot');
    expect(resolveMagic('$CURRENT_USER.email', ctx)).toBe('editor@example.com');
    expect(resolveMagic('$CURRENT_USER.profile.department', ctx)).toBe('news');
    expect(resolveMagic('$NOW(+2 hours)', ctx)).toBe('2026-06-04T12:00:00.000Z');
    expect(resolveMagic('$NOW(-7 days)', ctx)).toBe('2026-05-28T10:00:00.000Z');
  });

  it('returns an unknown sentinel for unsupported magic variables', () => {
    expect(resolveMagic('$CURRENT_USER.missing', ctx)).toBe(UNKNOWN_MAGIC);
    expect(resolveMagic('$NOT_REAL', ctx)).toBe(UNKNOWN_MAGIC);
    expect(resolveMagic('$NOW(next week)', ctx)).toBe(UNKNOWN_MAGIC);
  });

  it('fails closed when a rule references an unknown magic variable', () => {
    const rule = { owner: { _eq: '$CURRENT_USER.missing' } } as PolicyRule;
    expect(evaluate(rule, { owner: 'anything' }, ctx)).toBe(false);
  });
});

describe('permission DSL operators', () => {
  it('supports null and empty checks', () => {
    expect(evaluate({ subtitle: { _null: true } } as PolicyRule, { subtitle: null }, ctx)).toBe(true);
    expect(evaluate({ subtitle: { _nnull: true } } as PolicyRule, { subtitle: 'x' }, ctx)).toBe(true);
    expect(evaluate({ tags: { _empty: true } } as PolicyRule, { tags: [] }, ctx)).toBe(true);
    expect(evaluate({ title: { _nempty: true } } as PolicyRule, { title: 'Draft' }, ctx)).toBe(true);
  });

  it('supports regex and explicit case-insensitive string operators', () => {
    const item = { title: 'Published Article' };
    expect(evaluate({ title: { _regex: '^Published' } } as PolicyRule, item, ctx)).toBe(true);
    expect(evaluate({ title: { _icontains: 'article' } } as PolicyRule, item, ctx)).toBe(true);
    expect(evaluate({ title: { _istarts_with: 'published' } } as PolicyRule, item, ctx)).toBe(true);
    expect(evaluate({ title: { _iends_with: 'ARTICLE' } } as PolicyRule, item, ctx)).toBe(true);
    expect(evaluate({ title: { _regex: '[' } } as PolicyRule, item, ctx)).toBe(false);
  });
});
