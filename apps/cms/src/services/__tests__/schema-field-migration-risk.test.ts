import { describe, expect, it } from 'vitest';
import {
  SchemaServiceError,
  assertFieldMutationAllowed,
  assessFieldMutationRisk,
} from '../schema-service';

const existing = { name: 'title', type: 'string' };

describe('SchemaService field migration risk', () => {
  it('does not flag presentation-only edits on populated fields', () => {
    expect(
      assessFieldMutationRisk(existing, { name: 'title', type: 'string' }, 12),
    ).toEqual({
      risky: false,
      changes: [],
      requiresMigrationPlan: false,
    });
  });

  it('rejects type changes on populated fields without a migration plan', () => {
    expect(() =>
      assertFieldMutationAllowed(existing, { name: 'title', type: 'text' }, 4),
    ).toThrowError(SchemaServiceError);

    try {
      assertFieldMutationAllowed(existing, { name: 'title', type: 'text' }, 4);
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaServiceError);
      expect((err as SchemaServiceError).code).toBe('FIELD_MIGRATION_REQUIRED');
      expect((err as SchemaServiceError).status).toBe(409);
    }
  });

  it('rejects renames on populated fields without explicit confirmation', () => {
    expect(() =>
      assertFieldMutationAllowed(existing, { name: 'headline', type: 'string' }, 2),
    ).toThrowError(/requires a migration plan/);
  });

  it('allows risky changes when a migration plan or confirmation is supplied', () => {
    expect(() =>
      assertFieldMutationAllowed(existing, { name: 'headline', type: 'text' }, 2, {
        migrationPlan: { strategy: 'copy-json-key' },
      }),
    ).not.toThrow();
    expect(() =>
      assertFieldMutationAllowed(existing, { name: 'headline', type: 'text' }, 2, {
        confirmRiskyChange: true,
      }),
    ).not.toThrow();
  });
});
