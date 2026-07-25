import { describe, it, expect } from 'vitest';
import { ToolRegistryService } from '../services/tool-registry-service';
import {
  isControlPlaneSkill,
  CORE_SKILLS as HARNESS_SKILLS,
  type SkillDefinition,
} from '../services/ai-harness';
import { CORE_SKILLS } from '@lumibase/ai-skills';

/**
 * Change Feed skills — risk/HITL classification (Req 7.4, task 12.2).
 * `deleteCdcSubscription` is control-plane via the `delete` name prefix
 * (rule #4 CLAUDE.md). `createCdcSubscription`/`replayCdcSubscription` are
 * control-plane via an explicit `dangerous` flag so the agent/MCP path
 * matches the REST posture (whole `/api/v1/cdc` surface is admin-only). Only
 * the read skills (`list*`/`get*Status`) stay safe. `coreTool` does not touch
 * the DB, so a bare stub suffices (deploy-skill-risk pattern).
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

  it('classifies create/replay as control-plane via the explicit dangerous flag', () => {
    // Risk classification lives on the harness registry (`buildCoreSkills`),
    // not the `@lumibase/ai-skills` metadata registry (which never carries
    // `dangerous` — same as every other governed skill).
    for (const name of ['createCdcSubscription', 'replayCdcSubscription'] as const) {
      const def = HARNESS_SKILLS[name] as SkillDefinition;
      expect(def.dangerous, name).toBe(true);
      expect(isControlPlaneSkill(def, name), name).toBe(true);
      const tool = registry.coreTool(name, def);
      expect(tool.riskPolicy.level, name).toBe('dangerous');
      expect(tool.riskPolicy.approvalPolicy, name).toBe('before_execute');
    }
  });

  it('keeps read skills (list/get) out of the control-plane class', () => {
    for (const name of ['listCdcSubscriptions', 'getCdcSubscriptionStatus']) {
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
