import { describe, it, expect } from 'vitest';
import { ToolRegistryService } from '../services/tool-registry-service';
import { isControlPlaneSkill, type SkillDefinition } from '../services/ai-harness';
import { CORE_SKILLS } from '@lumibase/ai-skills';

/**
 * Change Feed skills — risk/HITL classification (Req 7.4, task 12.2).
 * `deleteCdcSubscription` must be control-plane purely via the `delete` name
 * prefix (rule #4 CLAUDE.md); the manage/read skills stay safe. `coreTool`
 * does not touch the DB, so a bare stub suffices (deploy-skill-risk pattern).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const registry = new ToolRegistryService({} as any, 'site1', {});

function skill(name: string, caps: string[]): SkillDefinition {
  return {
    name,
    description: 'test',
    requiredCapabilities: caps,
    service: 'cdc-feed',
    handler: async () => ({}),
  };
}

describe('cdc-feed skill risk policy (HITL)', () => {
  it('classifies deleteCdcSubscription as control-plane via the delete prefix', () => {
    expect(
      isControlPlaneSkill(
        { requiredCapabilities: ['cdc:manage'], dangerous: undefined },
        'deleteCdcSubscription',
      ),
    ).toBe(true);
    const tool = registry.coreTool(
      'deleteCdcSubscription',
      skill('deleteCdcSubscription', ['cdc:manage']),
    );
    expect(tool.riskPolicy.level).toBe('dangerous');
    expect(tool.riskPolicy.approvalPolicy).toBe('before_execute');
  });

  it('keeps list/get/create/replay skills out of the control-plane class', () => {
    for (const name of [
      'listCdcSubscriptions',
      'getCdcSubscriptionStatus',
      'createCdcSubscription',
      'replayCdcSubscription',
    ]) {
      expect(
        isControlPlaneSkill({ requiredCapabilities: ['cdc:manage'], dangerous: undefined }, name),
        name,
      ).toBe(false);
    }
  });

  it('registers all 5 skills in the shared registry with cdc:manage', () => {
    for (const name of [
      'listCdcSubscriptions',
      'getCdcSubscriptionStatus',
      'createCdcSubscription',
      'replayCdcSubscription',
      'deleteCdcSubscription',
    ]) {
      const def = (CORE_SKILLS as Record<string, { requiredCapabilities: string[] }>)[name];
      expect(def, name).toBeDefined();
      expect(def!.requiredCapabilities).toContain('cdc:manage');
    }
  });
});
