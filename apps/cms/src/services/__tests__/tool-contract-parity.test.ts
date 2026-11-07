import { CORE_SKILLS as COPILOT_SKILLS } from '@lumibase/ai-skills';
import { agentToolNamesWithSchema, jsonSchemaFor, validateAgentToolInput } from '@lumibase/contracts';
import { describe, expect, it } from 'vitest';
import { CORE_SKILLS, isControlPlaneSkill } from '../ai-harness';
import { mergeOverrideCapabilities, ToolRegistryService } from '../tool-registry-service';

/**
 * Contract parity tripwire (#585).
 *
 * One logical tool has four descriptions that must agree:
 *
 *   1. the harness registry (`CORE_SKILLS` in `ai-harness.ts`): the handler, the
 *      capabilities that are enforced and the risk inputs;
 *   2. the canonical Zod contract (`AgentToolSchemas`): what is validated;
 *   3. the advertised schema (`inputSchema` on `tools/list` and `/agent/tools`);
 *   4. the Copilot descriptor (`@lumibase/ai-skills`): what the LLM is shown.
 *
 * `governed-skills.test.ts` pins the key sets and `g2-agent-tool-schemas.test.ts`
 * pins 4 ⊆ 2 for properties. This file pins the rest, so a drift in schema,
 * permission or risk fails CI before release. Every exception list here may
 * only shrink.
 */

/** Same rule as `isWriteSkill` in the harness, plus explicitly dangerous skills. */
function isWriteCapable(name: string): boolean {
  const skill = CORE_SKILLS[name]!;
  return skill.dangerous === true || skill.requiredCapabilities.some((c) => /:(write|update|create|delete)$/.test(c));
}

/**
 * Write-capable skills that may stay without a canonical schema, with the reason.
 * `generateSeedData` returns an artifact and persists nothing.
 */
const NO_SCHEMA_ALLOWED: Record<string, string> = {
  generateSeedData: 'returns a seed-data artifact; writes no row',
};

describe('tool contract parity', () => {
  it('every write-capable skill has a canonical schema (validation is not fail-open for writes)', () => {
    const missing = Object.keys(CORE_SKILLS).filter(
      (name) => isWriteCapable(name) && jsonSchemaFor(name) === undefined && !(name in NO_SCHEMA_ALLOWED),
    );
    expect(missing).toEqual([]);
    // The exception list only names skills that still need it.
    for (const name of Object.keys(NO_SCHEMA_ALLOWED)) {
      expect(jsonSchemaFor(name), `${name} has a schema now; drop it from NO_SCHEMA_ALLOWED`).toBeUndefined();
    }
  });

  it('every canonical schema belongs to a registered skill', () => {
    expect(agentToolNamesWithSchema().filter((name) => CORE_SKILLS[name] === undefined)).toEqual([]);
  });

  it('the advertised schema is the validated schema wherever one exists', () => {
    const drift = agentToolNamesWithSchema().filter(
      (name) => JSON.stringify(CORE_SKILLS[name]!.inputSchema) !== JSON.stringify(jsonSchemaFor(name)),
    );
    expect(drift).toEqual([]);
  });

  it('the Copilot descriptor requires exactly what the canonical schema requires', () => {
    const drift: string[] = [];
    for (const name of agentToolNamesWithSchema()) {
      const descriptor = COPILOT_SKILLS[name];
      if (!descriptor) continue; // reported by g2-agent-tool-schemas.test.ts
      const canonical = [...((jsonSchemaFor(name)!['required'] as string[] | undefined) ?? [])].sort();
      const advertised = [...descriptor.parameters.required].sort();
      if (canonical.join(',') !== advertised.join(',')) drift.push(`${name}: canonical=${canonical} copilot=${advertised}`);
    }
    expect(drift).toEqual([]);
  });

  it('the Copilot descriptor names the capabilities the harness enforces', () => {
    const drift: string[] = [];
    for (const [name, skill] of Object.entries(CORE_SKILLS)) {
      const descriptor = COPILOT_SKILLS[name];
      if (!descriptor) continue; // key-set parity is governed-skills.test.ts
      const enforced = [...skill.requiredCapabilities].sort().join(',');
      const described = [...descriptor.requiredCapabilities].sort().join(',');
      if (enforced !== described) drift.push(`${name}: harness=${enforced} copilot=${described}`);
    }
    expect(drift).toEqual([]);
  });

  it('the MCP admin backstop and the tool registry agree on which skills are dangerous', () => {
    const registry = new ToolRegistryService({} as never, 'site', CORE_SKILLS);
    const drift = Object.entries(CORE_SKILLS)
      .filter(([name, skill]) => isControlPlaneSkill(skill, name) !== (registry.coreTool(name, skill).riskPolicy.level === 'dangerous'))
      .map(([name]) => name);
    expect(drift).toEqual([]);
  });

  it('the reconciler payloads satisfy the canonical contracts they are validated against', () => {
    // `goal-dispatch-service.ts` builds these two argument sets; a stricter schema
    // that refused them would block every repair goal at the boundary.
    expect(
      validateAgentToolInput('repairTranslation', {
        collection: 'posts',
        itemId: 'itm_1',
        field: 'title',
        locale: 'vi',
        versionKey: 'drift-abc',
      }).ok,
    ).toBe(true);
    expect(validateAgentToolInput('promoteVersion', { collection: 'posts', itemId: 'itm_1', key: 'drift-abc' }).ok).toBe(true);
  });
});

describe('agent_tools override capabilities', () => {
  it('keeps every core capability and adds the override’s', () => {
    expect(mergeOverrideCapabilities(['schema:create'], [])).toEqual(['schema:create']);
    expect(mergeOverrideCapabilities(['schema:create'], ['schema:audit'])).toEqual(['schema:create', 'schema:audit']);
    expect(mergeOverrideCapabilities(['schema:create'], 'not-a-list')).toEqual(['schema:create']);
  });

  it('a tool that exists only in the database keeps the row’s capabilities', () => {
    expect(mergeOverrideCapabilities(undefined, ['x:read', 7])).toEqual(['x:read']);
  });
});
