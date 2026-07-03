import { describe, it, expect } from 'vitest';
import { ToolRegistryService } from '../../tool-registry-service';
import type { SkillDefinition } from '../../ai-harness';

/**
 * Risk classification for deployment skills (deployment-integrations Req 6.2).
 * `coreTool` does not touch the DB, so a bare stub suffices.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const registry = new ToolRegistryService({} as any, 'site1', {});

function skill(name: string, caps: string[]): SkillDefinition {
  return {
    name,
    description: 'test',
    requiredCapabilities: caps,
    service: 'deployments',
    handler: async () => ({}),
  };
}

describe('deployment skill risk policy', () => {
  it('classifies triggerDeployment (deployments:write) as dangerous → before_execute (HITL)', () => {
    const tool = registry.coreTool('triggerDeployment', skill('triggerDeployment', ['deployments:write']));
    expect(tool.riskPolicy.level).toBe('dangerous');
    expect(tool.riskPolicy.approvalPolicy).toBe('before_execute');
  });

  it('classifies read-only deployment skills as safe (no approval)', () => {
    const tool = registry.coreTool('listDeployments', skill('listDeployments', ['deployments:read']));
    expect(tool.riskPolicy.level).toBe('safe');
    expect(tool.riskPolicy.approvalPolicy).toBe('none');
  });
});
