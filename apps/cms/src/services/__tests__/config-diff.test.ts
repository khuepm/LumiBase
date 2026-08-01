import { describe, it, expect } from 'vitest';
import { CONFIG_MANIFEST_VERSION, type ConfigManifest } from '@lumibase/contracts/schemas';
import {
  buildConfigDiff,
  hasDestructiveChange,
  validateManifestIntegrity,
} from '../config-diff';

/**
 * Feature: code-first-config
 *   Req 2.3–2.5 — dangling reference + duplicate key validation.
 *   Req 3.2–3.7 — diff statuses, mode-gated deletes, risk classification.
 *   Req 6.1     — round-trip: diffing a manifest against itself is all-unchanged.
 *
 * **Validates: Requirements 2.3, 2.4, 2.5, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 6.1**
 */

function manifest(overrides: Partial<ConfigManifest> = {}): ConfigManifest {
  return {
    version: CONFIG_MANIFEST_VERSION,
    collections: [],
    fields: [],
    relations: [],
    webhooks: [],
    settings: [],
    ...overrides,
  };
}

describe('validateManifestIntegrity', () => {
  it('flags a field referencing an unknown collection (Req 2.3)', () => {
    const m = manifest({ fields: [{ collection: 'ghost', field: 'x', type: 'string', interface: 'input' }] });
    const issues = validateManifestIntegrity(m, new Set());
    expect(issues.some((i) => i.code === 'DANGLING_REFERENCE')).toBe(true);
  });

  it('accepts a field whose collection exists only in the DB (Req 2.3)', () => {
    const m = manifest({ fields: [{ collection: 'articles', field: 'x', type: 'string', interface: 'input' }] });
    const issues = validateManifestIntegrity(m, new Set(['articles']));
    expect(issues).toHaveLength(0);
  });

  it('flags a relation referencing an unknown collection (Req 2.4)', () => {
    const m = manifest({
      collections: [{ name: 'articles' }],
      relations: [{ manyCollection: 'articles', manyField: 'author', oneCollection: 'ghost' }],
    });
    const issues = validateManifestIntegrity(m, new Set());
    expect(issues.some((i) => i.code === 'DANGLING_REFERENCE' && i.path.includes('oneCollection'))).toBe(true);
  });

  it('flags duplicate stable keys (Req 2.5)', () => {
    const m = manifest({
      fields: [
        { collection: 'articles', field: 'title', type: 'string', interface: 'input' },
        { collection: 'articles', field: 'title', type: 'text', interface: 'textarea' },
      ],
      collections: [{ name: 'articles' }],
    });
    const issues = validateManifestIntegrity(m, new Set());
    expect(issues.some((i) => i.code === 'DUPLICATE_KEY')).toBe(true);
  });
});

describe('buildConfigDiff', () => {
  const current = manifest({
    collections: [{ name: 'articles', label: 'Articles' }],
    fields: [{ collection: 'articles', field: 'title', type: 'string', interface: 'input' }],
    settings: [{ key: 'k', value: 1, scope: 'site' }],
  });

  it('round-trip: a manifest diffed against itself is all-unchanged & clean (Req 6.1)', () => {
    const diff = buildConfigDiff(current, current, 'replace-all');
    expect(diff.clean).toBe(true);
    expect(diff.collections.unchanged).toBe(1);
    expect(diff.fields.unchanged).toBe(1);
    expect(diff.settings.unchanged).toBe(1);
  });

  it('marks new resources create (Req 3.3)', () => {
    const incoming = manifest({
      collections: [{ name: 'articles', label: 'Articles' }, { name: 'pages' }],
      fields: current.fields,
      settings: current.settings,
    });
    const diff = buildConfigDiff(incoming, current, 'merge');
    expect(diff.collections.create).toBe(1);
    expect(diff.collections.entries.find((e) => e.key === 'pages')?.status).toBe('create');
  });

  it('marks changed resources update with changed keys (Req 3.4)', () => {
    const incoming = manifest({
      collections: [{ name: 'articles', label: 'Renamed' }],
      fields: current.fields,
      settings: current.settings,
    });
    const diff = buildConfigDiff(incoming, current, 'merge');
    expect(diff.collections.update).toBe(1);
    expect(diff.collections.entries[0]?.changes).toContain('label');
  });

  it('does NOT propose deletes in merge mode (Req 3.6)', () => {
    const incoming = manifest({ collections: [{ name: 'articles', label: 'Articles' }], settings: current.settings });
    // `articles.title` field is absent from incoming, but merge keeps it.
    const diff = buildConfigDiff(incoming, current, 'merge');
    expect(diff.fields.delete).toBe(0);
  });

  it('proposes deletes in replace-all mode (Req 3.6)', () => {
    const incoming = manifest({ collections: [{ name: 'articles', label: 'Articles' }], settings: current.settings });
    const diff = buildConfigDiff(incoming, current, 'replace-all');
    expect(diff.fields.delete).toBe(1);
    expect(diff.fields.entries.find((e) => e.key === 'articles.title')?.status).toBe('delete');
  });

  it('only deletes managed scopes in replace-managed mode (Req 3.6)', () => {
    const cur = manifest({
      collections: [{ name: 'articles' }, { name: 'legacy' }],
    });
    const incoming = manifest({ collections: [{ name: 'articles' }], managedScopes: ['articles'] });
    const diff = buildConfigDiff(incoming, cur, 'replace-managed');
    // `legacy` is outside managedScopes → not deleted.
    expect(diff.collections.entries.find((e) => e.key === 'legacy')).toBeUndefined();
  });

  it('classifies a field type change as high risk (Req 3.7)', () => {
    const incoming = manifest({
      collections: current.collections,
      fields: [{ collection: 'articles', field: 'title', type: 'integer', interface: 'input' }],
      settings: current.settings,
    });
    const diff = buildConfigDiff(incoming, current, 'merge');
    expect(diff.fields.entries[0]?.risk).toBe('high');
    expect(hasDestructiveChange(diff)).toBe(true);
  });

  it('classifies widening onDelete to cascade as high risk (Req 3.7)', () => {
    const cur = manifest({
      collections: [{ name: 'articles' }, { name: 'users' }],
      relations: [{ manyCollection: 'articles', manyField: 'author', oneCollection: 'users', onDelete: 'set null' }],
    });
    const incoming = manifest({
      collections: cur.collections,
      relations: [{ manyCollection: 'articles', manyField: 'author', oneCollection: 'users', onDelete: 'cascade' }],
    });
    const diff = buildConfigDiff(incoming, cur, 'merge');
    expect(diff.relations.entries[0]?.risk).toBe('high');
  });
});
