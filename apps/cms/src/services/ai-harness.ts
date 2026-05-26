import { aiApprovals } from '@lumibase/database';
import type { Database } from '@lumibase/database';

// ---------------------------------------------------------------------------
// Types & Interfaces
// ---------------------------------------------------------------------------

/**
 * Defines a single AI skill that the harness can execute.
 */
export interface SkillDefinition {
  name: string;
  description: string;
  requiredCapabilities: string[];
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Result returned by the harness after evaluating and/or executing a skill.
 */
export interface HarnessExecutionResult {
  status: 'executed' | 'pending_approval' | 'denied';
  data?: unknown;
  approvalId?: string;
  message?: string;
}

/**
 * Configuration required to instantiate the AISecureHarness.
 */
export interface AISecureHarnessConfig {
  db: Database;
  siteId: string;
}

// ---------------------------------------------------------------------------
// Core Skills Registry
// ---------------------------------------------------------------------------

/**
 * CORE_SKILLS — registry of all skills the AI agent can invoke.
 * Each skill declares its required capabilities and a handler function.
 */
export const CORE_SKILLS: Record<string, SkillDefinition> = {
  listCollections: {
    name: 'listCollections',
    description: 'List all collections in the current site',
    requiredCapabilities: ['schema:read'],
    handler: async (_args) => {
      // Stub: will be connected to SchemaService in task 7.1
      return { collections: [] };
    },
  },
  createCollection: {
    name: 'createCollection',
    description: 'Create a new collection',
    requiredCapabilities: ['schema:write'],
    handler: async (_args) => {
      // Stub: will be connected to SchemaService in task 7.1
      return { created: true };
    },
  },
  deleteCollection: {
    name: 'deleteCollection',
    description: 'Delete an existing collection',
    requiredCapabilities: ['schema:write'],
    handler: async (_args) => {
      // Stub: will be connected to SchemaService in task 7.1
      return { deleted: true };
    },
  },
  listItems: {
    name: 'listItems',
    description: 'List items in a collection',
    requiredCapabilities: ['items:read'],
    handler: async (_args) => {
      // Stub: will be connected to ItemService in task 7.1
      return { items: [] };
    },
  },
  createItem: {
    name: 'createItem',
    description: 'Create a new item in a collection',
    requiredCapabilities: ['items:write'],
    handler: async (_args) => {
      // Stub: will be connected to ItemService in task 7.1
      return { created: true };
    },
  },
  deleteItem: {
    name: 'deleteItem',
    description: 'Delete an item from a collection',
    requiredCapabilities: ['items:write'],
    handler: async (_args) => {
      // Stub: will be connected to ItemService in task 7.1
      return { deleted: true };
    },
  },
};

// ---------------------------------------------------------------------------
// AI Secure Harness
// ---------------------------------------------------------------------------

/**
 * AISecureHarness — orchestrates safe AI skill execution.
 *
 * Responsibilities:
 * - Validate that a requested skill exists in CORE_SKILLS
 * - Check that the user session has all required capabilities
 * - Evaluate risk and decide whether to execute directly or require approval
 * - Execute skills after approval
 */
export class AISecureHarness {
  private readonly db: Database;
  private readonly siteId: string;

  constructor(config: AISecureHarnessConfig) {
    this.db = config.db;
    this.siteId = config.siteId;
  }

  // ---------- Validation ----------

  /**
   * Validates that a skill exists in the CORE_SKILLS registry.
   * @returns The SkillDefinition if found, or undefined if the skill is not registered.
   */
  validateSkill(skillName: string): SkillDefinition | undefined {
    if (!Object.hasOwn(CORE_SKILLS, skillName)) {
      return undefined;
    }
    return CORE_SKILLS[skillName];
  }

  /**
   * Checks whether the user has all capabilities required by a skill.
   * The wildcard capability '*' satisfies all requirements.
   *
   * @returns true if the user has sufficient capabilities, false otherwise.
   */
  checkCapabilities(
    skill: SkillDefinition,
    userCapabilities: string[],
  ): boolean {
    // Wildcard grants all capabilities
    if (userCapabilities.includes('*')) {
      return true;
    }

    // Every required capability must be present in the user's set
    return skill.requiredCapabilities.every((required) =>
      userCapabilities.includes(required),
    );
  }

  // ---------- Risk Evaluation ----------

  /**
   * Evaluates whether a skill is dangerous and requires HITL approval.
   * A skill is considered dangerous if:
   * - It requires the 'schema:write' capability, OR
   * - Its name starts with 'delete'
   *
   * @returns true if the skill is classified as dangerous, false otherwise.
   */
  evaluateRisk(skill: SkillDefinition, skillName: string): boolean {
    if (skill.requiredCapabilities.includes('schema:write')) {
      return true;
    }
    if (skillName.startsWith('delete')) {
      return true;
    }
    return false;
  }

  // ---------- Execution ----------

  /**
   * Full execution flow: validate → check capabilities → evaluate risk → execute or create approval.
   */
  async execute(
    skillName: string,
    args: Record<string, unknown>,
    userCapabilities: string[],
    contextMessage?: string,
  ): Promise<HarnessExecutionResult> {
    // Step 1: Validate skill exists
    const skill = this.validateSkill(skillName);
    if (!skill) {
      return { status: 'denied', message: `Unknown skill: ${skillName}` };
    }

    // Step 2: Check capabilities
    if (!this.checkCapabilities(skill, userCapabilities)) {
      return { status: 'denied', message: 'Insufficient capabilities' };
    }

    // Step 3: Evaluate risk
    const isDangerous = this.evaluateRisk(skill, skillName);

    if (isDangerous) {
      // Create approval record and return pending_approval
      const [record] = await this.db
        .insert(aiApprovals)
        .values({
          siteId: this.siteId,
          skillName,
          arguments: args,
          status: 'pending',
          context: contextMessage ?? null,
        })
        .returning();

      return { status: 'pending_approval', approvalId: record!.id };
    }

    // Step 4: Safe skill — execute directly
    const result = await this.runSkill(skillName, args);
    if (result.success) {
      return { status: 'executed', data: result.data };
    }
    return { status: 'denied', message: result.error };
  }

  /**
   * Executes a skill handler with error handling and a 30-second timeout.
   * Uses Promise.race to enforce the timeout.
   */
  async runSkill(
    skillName: string,
    args: Record<string, unknown>,
  ): Promise<{ success: true; data: unknown } | { success: false; error: string }> {
    if (!Object.hasOwn(CORE_SKILLS, skillName)) {
      return { success: false, error: `Skill not found: ${skillName}` };
    }
    const skill = CORE_SKILLS[skillName]!;

    const TIMEOUT_MS = 30_000;

    try {
      const result = await Promise.race([
        skill.handler(args),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => {
            reject(new Error(`Skill execution timed out after ${TIMEOUT_MS}ms`));
          }, TIMEOUT_MS);
        }),
      ]);

      return { success: true, data: result };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown execution error';
      return { success: false, error: message };
    }
  }
}
