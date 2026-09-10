import { describe, expect, it } from 'vitest';
import { CORE_SKILLS } from '../ai-harness';

/**
 * G1 (#453) — a missing required service must fail explicitly.
 *
 * The offline registry (`CORE_SKILLS`, built with no services) is what a
 * production path gets whenever a dependency was not wired — and the legacy
 * approval route wired only a subset, so this was reachable in production.
 * A write handler that returns `{ created: true }` / `{ deleted: true }` with
 * no service is a success-shaped stub: the approval resolves, the audit trail
 * records success, and nothing happened.
 *
 * Reads may legitimately return an empty set offline; writes may not.
 */

/** Write-shaped skills whose success response would be a lie without a service. */
const WRITE_SKILLS: Array<[string, Record<string, unknown>]> = [
  ['createCollection', { name: 'posts' }],
  ['deleteCollection', { name: 'posts' }],
  ['createField', { collection: 'posts', name: 'title', type: 'string' }],
  ['deleteField', { collection: 'posts', name: 'title' }],
  ['createItem', { collection: 'posts', data: {} }],
  ['updateItem', { collection: 'posts', id: 'i1', data: {} }],
  ['deleteItem', { collection: 'posts', id: 'i1' }],
  ['createRelation', { collection: 'posts', field: 'author', type: 'm2o' }],
  ['deleteRelation', { id: 'rel_1' }],
];

describe('G1 — missing service fails explicitly instead of stubbing success', () => {
  for (const [name, args] of WRITE_SKILLS) {
    it(`${name} rejects when its service is not configured`, async () => {
      const skill = CORE_SKILLS[name];
      expect(skill, `${name} must exist in CORE_SKILLS`).toBeDefined();

      await expect(skill!.handler(args)).rejects.toThrow(/NOT_CONFIGURED/);
    });
  }

  it('read skills may still answer offline, but never claim a write happened', async () => {
    const result = (await CORE_SKILLS['listCollections']!.handler({})) as Record<string, unknown>;
    expect(result).toEqual({ collections: [] });
  });
});
