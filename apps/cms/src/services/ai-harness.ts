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
}
