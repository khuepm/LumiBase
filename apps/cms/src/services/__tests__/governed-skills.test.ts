import { CORE_SKILLS as SHARED_SKILLS } from '@lumibase/ai-skills';
import { describe, expect, it } from 'vitest';
import { AISecureHarness, CORE_SKILLS } from '../ai-harness';

const harness = new AISecureHarness({ db: {} as never, siteId: 'test-site' });

describe('governed skill registry', () => {
  it('keeps the harness and @lumibase/ai-skills registries in sync (same key set)', () => {
    const harnessKeys = Object.keys(CORE_SKILLS).sort();
    const sharedKeys = Object.keys(SHARED_SKILLS).sort();
    expect(harnessKeys).toEqual(sharedKeys);
  });

  it('registers the new governed skills', () => {
    for (const name of [
      'listRelations',
      'createRelation',
      'deleteRelation',
      'listRoles',
      'createRole',
      'deleteRole',
      'listPolicies',
      'createPolicy',
      'deletePolicy',
      'listIntents',
      'createIntent',
      'deleteIntent',
      'listFlows',
      'createFlow',
      'deleteFlow',
      'runFlow',
    ]) {
      expect(CORE_SKILLS[name], `missing harness skill: ${name}`).toBeDefined();
    }
  });
});

describe('governed risk classification', () => {
  const DANGEROUS = [
    'createRole',
    'deleteRole',
    'createPolicy',
    'deletePolicy',
    'createRelation',
    'deleteRelation',
    'createIntent',
    'deleteIntent',
    'createFlow',
    'deleteFlow',
    'runFlow',
  ];
  const SAFE = ['listRelations', 'listRoles', 'listPolicies', 'listIntents', 'listFlows'];

  it('classifies every governed write/delete skill as dangerous (HITL-gated)', () => {
    for (const name of DANGEROUS) {
      expect(harness.evaluateRisk(CORE_SKILLS[name]!, name), `${name} should be dangerous`).toBe(true);
    }
  });

  it('keeps read-only governed skills safe', () => {
    for (const name of SAFE) {
      expect(harness.evaluateRisk(CORE_SKILLS[name]!, name), `${name} should be safe`).toBe(false);
    }
  });

  it('does not change item CRUD risk classification', () => {
    expect(harness.evaluateRisk(CORE_SKILLS['createItem']!, 'createItem')).toBe(false);
    expect(harness.evaluateRisk(CORE_SKILLS['updateItem']!, 'updateItem')).toBe(false);
  });
});
