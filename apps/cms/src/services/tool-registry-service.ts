import { agentToolCalls, agentTools, type Database } from '@lumibase/database';
import { and, desc, eq, gte } from 'drizzle-orm';
import type { SkillDefinition } from './ai-harness';

export type AgentRiskLevel = 'safe' | 'review_required' | 'dangerous' | 'blocked';

export interface AgentToolDefinition extends SkillDefinition {
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  riskPolicy: { level: AgentRiskLevel; approvalPolicy?: string };
  rateLimit: { maxCallsPerMinute?: number; maxCallsPerRun?: number };
  enabled: boolean;
  owner: string;
  extensionId?: string | null;
}

export interface ToolPolicyResult {
  allowed: boolean;
  message?: string;
  risk: AgentRiskLevel;
  approvalPolicy: string;
}

function normalizeCapabilities(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function normalizeRiskPolicy(value: unknown): AgentToolDefinition['riskPolicy'] {
  if (value && typeof value === 'object') {
    const raw = value as Record<string, unknown>;
    const level = raw['level'];
    if (level === 'safe' || level === 'review_required' || level === 'dangerous' || level === 'blocked') {
      return {
        level,
        approvalPolicy: typeof raw['approvalPolicy'] === 'string' ? raw['approvalPolicy'] : undefined,
      };
    }
  }
  return { level: 'safe' };
}

function normalizeRateLimit(value: unknown): AgentToolDefinition['rateLimit'] {
  if (!value || typeof value !== 'object') {
    return {};
  }
  const raw = value as Record<string, unknown>;
  return {
    maxCallsPerMinute: typeof raw['maxCallsPerMinute'] === 'number' ? raw['maxCallsPerMinute'] : undefined,
    maxCallsPerRun: typeof raw['maxCallsPerRun'] === 'number' ? raw['maxCallsPerRun'] : undefined,
  };
}

export class ToolRegistryService {
  constructor(
    private readonly db: Database,
    private readonly siteId: string,
    private readonly coreSkills: Record<string, SkillDefinition>,
  ) {}

  coreTool(name: string, skill: SkillDefinition): AgentToolDefinition {
    const mutatesSchema = skill.requiredCapabilities.some((capability) => capability.startsWith('schema:') && capability !== 'schema:read');
    const deletes = name.startsWith('delete');
    const level: AgentRiskLevel = skill.dangerous || mutatesSchema || deletes ? 'dangerous' : 'safe';

    return {
      ...skill,
      inputSchema: {},
      outputSchema: {},
      riskPolicy: { level, approvalPolicy: level === 'safe' ? 'none' : 'before_execute' },
      rateLimit: {},
      enabled: true,
      owner: 'core',
      extensionId: null,
    };
  }

  async getTool(name: string): Promise<AgentToolDefinition | undefined> {
    const [override] = await this.db
      .select()
      .from(agentTools)
      .where(and(eq(agentTools.siteId, this.siteId), eq(agentTools.name, name)))
      .orderBy(desc(agentTools.updatedAt))
      .limit(1);

    const core = this.coreSkills[name];
    if (!core && !override) {
      return undefined;
    }

    const base = core ? this.coreTool(name, core) : {
      name,
      description: override?.description ?? name,
      requiredCapabilities: [],
      service: 'ai' as const,
      handler: async () => ({ skipped: true }),
      inputSchema: {},
      outputSchema: {},
      riskPolicy: { level: 'safe' as AgentRiskLevel },
      rateLimit: {},
      enabled: true,
      owner: 'db',
      extensionId: null,
    };

    if (!override) {
      return base;
    }

    return {
      ...base,
      description: override.description,
      inputSchema: (override.inputSchema as Record<string, unknown>) ?? {},
      outputSchema: (override.outputSchema as Record<string, unknown>) ?? {},
      requiredCapabilities: normalizeCapabilities(override.requiredCapabilities),
      riskPolicy: normalizeRiskPolicy(override.riskPolicy),
      rateLimit: normalizeRateLimit(override.rateLimit),
      enabled: override.enabled,
      owner: override.owner,
      extensionId: override.extensionId,
    };
  }

  async listTools(): Promise<AgentToolDefinition[]> {
    const coreTools = Object.entries(this.coreSkills).map(([name, skill]) => this.coreTool(name, skill));
    const overrides = await this.db
      .select()
      .from(agentTools)
      .where(eq(agentTools.siteId, this.siteId));
    const byName = new Map(coreTools.map((tool) => [tool.name, tool]));

    for (const override of overrides) {
      const base = byName.get(override.name) ?? this.coreTool(override.name, {
        name: override.name,
        description: override.description,
        requiredCapabilities: [],
        service: 'ai',
        handler: async () => ({ skipped: true }),
      });
      byName.set(override.name, {
        ...base,
        description: override.description,
        inputSchema: (override.inputSchema as Record<string, unknown>) ?? {},
        outputSchema: (override.outputSchema as Record<string, unknown>) ?? {},
        requiredCapabilities: normalizeCapabilities(override.requiredCapabilities),
        riskPolicy: normalizeRiskPolicy(override.riskPolicy),
        rateLimit: normalizeRateLimit(override.rateLimit),
        enabled: override.enabled,
        owner: override.owner,
        extensionId: override.extensionId,
      });
    }

    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async evaluatePolicy(tool: AgentToolDefinition, runId: string): Promise<ToolPolicyResult> {
    if (!tool.enabled) {
      return { allowed: false, message: `Tool disabled: ${tool.name}`, risk: 'blocked', approvalPolicy: 'none' };
    }

    const risk = tool.riskPolicy.level;
    if (risk === 'blocked') {
      return { allowed: false, message: `Tool blocked by policy: ${tool.name}`, risk, approvalPolicy: 'none' };
    }

    const maxPerRun = tool.rateLimit.maxCallsPerRun;
    if (maxPerRun !== undefined) {
      const calls = await this.db
        .select({ id: agentToolCalls.id })
        .from(agentToolCalls)
        .where(and(eq(agentToolCalls.siteId, this.siteId), eq(agentToolCalls.runId, runId), eq(agentToolCalls.toolName, tool.name)))
        .limit(maxPerRun + 1);
      if (calls.length >= maxPerRun) {
        return { allowed: false, message: `Tool rate limit exceeded for run: ${tool.name}`, risk: 'blocked', approvalPolicy: 'none' };
      }
    }

    const maxPerMinute = tool.rateLimit.maxCallsPerMinute;
    if (maxPerMinute !== undefined) {
      const since = new Date(Date.now() - 60_000);
      const calls = await this.db
        .select({ id: agentToolCalls.id })
        .from(agentToolCalls)
        .where(and(eq(agentToolCalls.siteId, this.siteId), eq(agentToolCalls.toolName, tool.name), gte(agentToolCalls.createdAt, since)))
        .limit(maxPerMinute + 1);
      if (calls.length >= maxPerMinute) {
        return { allowed: false, message: `Tool rate limit exceeded per minute: ${tool.name}`, risk: 'blocked', approvalPolicy: 'none' };
      }
    }

    return {
      allowed: true,
      risk,
      approvalPolicy: tool.riskPolicy.approvalPolicy ?? (risk === 'safe' ? 'none' : 'before_execute'),
    };
  }
}
