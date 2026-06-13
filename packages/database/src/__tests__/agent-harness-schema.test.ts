import { describe, expect, it } from 'vitest';
import {
  agentApprovals,
  agentArtifacts,
  agentEvaluations,
  agentGoals,
  agentMemory,
  agentPermissions,
  agentPlans,
  agentRuns,
  agentToolCalls,
  agentTools,
} from '../schema/ai';

describe('agent harness schema exports', () => {
  it('exports every first-class agent harness table', () => {
    expect(agentGoals).toBeDefined();
    expect(agentRuns).toBeDefined();
    expect(agentPlans).toBeDefined();
    expect(agentToolCalls).toBeDefined();
    expect(agentTools).toBeDefined();
    expect(agentPermissions).toBeDefined();
    expect(agentApprovals).toBeDefined();
    expect(agentArtifacts).toBeDefined();
    expect(agentEvaluations).toBeDefined();
    expect(agentMemory).toBeDefined();
  });
});
