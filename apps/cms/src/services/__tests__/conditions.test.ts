import { describe, it, expect } from 'vitest';
import { evaluateRule, applyConditions, FieldCondition } from '../conditions';

describe('evaluateRule', () => {
  describe('operators', () => {
    it('handles _eq and _neq', () => {
      expect(evaluateRule({ status: { _eq: 'published' } }, { status: 'published' })).toBe(true);
      expect(evaluateRule({ status: { _eq: 'published' } }, { status: 'draft' })).toBe(false);

      expect(evaluateRule({ status: { _neq: 'draft' } }, { status: 'published' })).toBe(true);
      expect(evaluateRule({ status: { _neq: 'draft' } }, { status: 'draft' })).toBe(false);
    });

    it('handles _in and _nin', () => {
      expect(evaluateRule({ role: { _in: ['admin', 'editor'] } }, { role: 'admin' })).toBe(true);
      expect(evaluateRule({ role: { _in: ['admin', 'editor'] } }, { role: 'user' })).toBe(false);

      expect(evaluateRule({ role: { _nin: ['banned', 'guest'] } }, { role: 'user' })).toBe(true);
      expect(evaluateRule({ role: { _nin: ['banned', 'guest'] } }, { role: 'guest' })).toBe(false);
    });

    it('handles numeric operators (_gt, _gte, _lt, _lte)', () => {
      expect(evaluateRule({ age: { _gt: 18 } }, { age: 20 })).toBe(true);
      expect(evaluateRule({ age: { _gt: 18 } }, { age: 18 })).toBe(false);

      expect(evaluateRule({ age: { _gte: 18 } }, { age: 18 })).toBe(true);
      expect(evaluateRule({ age: { _gte: 18 } }, { age: 17 })).toBe(false);

      expect(evaluateRule({ age: { _lt: 65 } }, { age: 60 })).toBe(true);
      expect(evaluateRule({ age: { _lt: 65 } }, { age: 65 })).toBe(false);

      expect(evaluateRule({ age: { _lte: 65 } }, { age: 65 })).toBe(true);
      expect(evaluateRule({ age: { _lte: 65 } }, { age: 66 })).toBe(false);
    });

    it('handles string operators (_contains, _starts_with, _ends_with)', () => {
      expect(evaluateRule({ email: { _contains: '@' } }, { email: 'test@example.com' })).toBe(true);
      expect(evaluateRule({ email: { _contains: '@' } }, { email: 'invalid' })).toBe(false);

      expect(evaluateRule({ username: { _starts_with: 'admin_' } }, { username: 'admin_test' })).toBe(true);
      expect(evaluateRule({ username: { _starts_with: 'admin_' } }, { username: 'user_test' })).toBe(false);

      expect(evaluateRule({ filename: { _ends_with: '.jpg' } }, { filename: 'image.jpg' })).toBe(true);
      expect(evaluateRule({ filename: { _ends_with: '.jpg' } }, { filename: 'image.png' })).toBe(false);
    });

    it('handles null checks (_null, _nnull)', () => {
      expect(evaluateRule({ deleted_at: { _null: true } }, { deleted_at: null })).toBe(true);
      expect(evaluateRule({ deleted_at: { _null: true } }, { deleted_at: undefined })).toBe(true);
      expect(evaluateRule({ deleted_at: { _null: true } }, { deleted_at: '2023-01-01' })).toBe(false);
      expect(evaluateRule({ deleted_at: { _null: false } }, { deleted_at: null })).toBe(false);
      expect(evaluateRule({ deleted_at: { _null: false } }, { deleted_at: '2023-01-01' })).toBe(true);

      expect(evaluateRule({ author_id: { _nnull: true } }, { author_id: 123 })).toBe(true);
      expect(evaluateRule({ author_id: { _nnull: true } }, { author_id: null })).toBe(false);
      expect(evaluateRule({ author_id: { _nnull: false } }, { author_id: 123 })).toBe(false);
      expect(evaluateRule({ author_id: { _nnull: false } }, { author_id: null })).toBe(true);
    });

    it('returns false for unknown operators', () => {
      expect(evaluateRule({ field: { _unknown: true } as any }, { field: 'value' })).toBe(false);
    });
  });

  describe('logical operators', () => {
    it('handles _and', () => {
      const rule = {
        _and: [
          { status: { _eq: 'published' } },
          { author_id: { _nnull: true } }
        ]
      };

      expect(evaluateRule(rule, { status: 'published', author_id: 1 })).toBe(true);
      expect(evaluateRule(rule, { status: 'draft', author_id: 1 })).toBe(false);
      expect(evaluateRule(rule, { status: 'published', author_id: null })).toBe(false);
    });

    it('handles _or', () => {
      const rule = {
        _or: [
          { role: { _eq: 'admin' } },
          { role: { _eq: 'editor' } }
        ]
      };

      expect(evaluateRule(rule, { role: 'admin' })).toBe(true);
      expect(evaluateRule(rule, { role: 'editor' })).toBe(true);
      expect(evaluateRule(rule, { role: 'user' })).toBe(false);
    });

    it('handles multiple field rules in same object (implicit AND)', () => {
      const rule = {
        status: { _eq: 'published' },
        category: { _eq: 'news' }
      };

      expect(evaluateRule(rule, { status: 'published', category: 'news' })).toBe(true);
      expect(evaluateRule(rule, { status: 'published', category: 'blog' })).toBe(false);
    });
  });
});

describe('applyConditions', () => {
  it('returns empty object when no conditions provided', () => {
    expect(applyConditions([], { status: 'draft' })).toEqual({});
  });

  it('applies basic effects when conditions match', () => {
    const conditions: FieldCondition[] = [
      {
        rule: { status: { _eq: 'published' } },
        readonly: true,
        required: true
      }
    ];

    expect(applyConditions(conditions, { status: 'published' })).toEqual({
      readonly: true,
      required: true
    });

    expect(applyConditions(conditions, { status: 'draft' })).toEqual({});
  });

  it('later conditions override earlier ones', () => {
    const conditions: FieldCondition[] = [
      {
        rule: { role: { _eq: 'admin' } },
        hidden: true,
        readonly: true
      },
      {
        rule: { is_superadmin: { _eq: true } },
        hidden: false,
        readonly: false
      }
    ];

    // matches first condition
    expect(applyConditions(conditions, { role: 'admin', is_superadmin: false })).toEqual({
      hidden: true,
      readonly: true
    });

    // matches both, later overrides earlier
    expect(applyConditions(conditions, { role: 'admin', is_superadmin: true })).toEqual({
      hidden: false,
      readonly: false
    });
  });

  it('ignores conditions that do not match', () => {
    const conditions: FieldCondition[] = [
      {
        rule: { category: { _eq: 'private' } },
        hidden: true
      },
      {
        rule: { is_owner: { _eq: true } },
        hidden: false
      }
    ];

    expect(applyConditions(conditions, { category: 'public', is_owner: false })).toEqual({});
  });
});
