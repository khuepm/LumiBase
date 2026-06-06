import { aiApprovals } from '@lumibase/database';
import type { Database } from '@lumibase/database';
import { and, eq } from 'drizzle-orm';
import type { SchemaService } from './schema-service';
import type { ItemService } from './item-service';

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
  /** Service this skill connects to (for documentation/tracing). */
  service: 'schema' | 'items' | 'ai';
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
 *
 * The `schemaService` and `itemService` fields enable real service integration.
 * When provided, CORE_SKILLS handlers delegate to these services.
 * When omitted (e.g. in tests), handlers fall back to stub responses.
 */
export interface AISecureHarnessConfig {
  db: Database;
  siteId: string;
  /** SchemaService instance for schema:read/write skills (listCollections, createCollection, deleteCollection). */
  schemaService?: SchemaService;
  /** ItemService instance for items:read/write skills (listItems, createItem, deleteItem). */
  itemService?: ItemService;
}

// ---------------------------------------------------------------------------
// Core Skills Registry Factory
// ---------------------------------------------------------------------------

/**
 * Service dependencies passed to the skill factory.
 * Both are optional — when absent, handlers return stub data.
 */
interface SkillServices {
  schemaService?: SchemaService;
  itemService?: ItemService;
}

// ---------------------------------------------------------------------------
// Field suggestion helper (for aiSuggestField skill)
// ---------------------------------------------------------------------------

interface FieldSuggestion {
  name: string;
  type: string;
  interface: string;
  required: boolean;
  description: string;
}

const FIELD_PATTERNS: Array<{ keywords: string[]; field: FieldSuggestion }> = [
  { keywords: ['title', 'name', 'heading'], field: { name: 'title', type: 'string', interface: 'input', required: true, description: 'Title or heading' } },
  { keywords: ['body', 'content', 'text', 'description', 'article'], field: { name: 'body', type: 'text', interface: 'wysiwyg', required: false, description: 'Main content body' } },
  { keywords: ['slug', 'url', 'permalink'], field: { name: 'slug', type: 'string', interface: 'slug', required: true, description: 'URL-friendly slug' } },
  { keywords: ['author', 'writer', 'creator'], field: { name: 'author', type: 'string', interface: 'input', required: false, description: 'Author name' } },
  { keywords: ['date', 'publish', 'published', 'created'], field: { name: 'publish_date', type: 'dateTime', interface: 'datetime', required: false, description: 'Publication date' } },
  { keywords: ['image', 'photo', 'thumbnail', 'cover', 'banner'], field: { name: 'featured_image', type: 'string', interface: 'file', required: false, description: 'Featured image' } },
  { keywords: ['category', 'categories', 'type'], field: { name: 'category', type: 'string', interface: 'select-dropdown', required: false, description: 'Category classification' } },
  { keywords: ['tag', 'tags', 'label'], field: { name: 'tags', type: 'json', interface: 'tags', required: false, description: 'Tags for categorization' } },
  { keywords: ['price', 'cost', 'amount'], field: { name: 'price', type: 'float', interface: 'input', required: false, description: 'Price/cost value' } },
  { keywords: ['email', 'mail'], field: { name: 'email', type: 'string', interface: 'input', required: false, description: 'Email address' } },
  { keywords: ['status', 'state'], field: { name: 'status', type: 'string', interface: 'select-dropdown', required: true, description: 'Current status' } },
  { keywords: ['sort', 'order', 'position'], field: { name: 'sort_order', type: 'integer', interface: 'input', required: false, description: 'Sort order' } },
  { keywords: ['active', 'enabled', 'visible', 'published'], field: { name: 'is_active', type: 'boolean', interface: 'toggle', required: false, description: 'Active/visible toggle' } },
  { keywords: ['summary', 'excerpt', 'intro'], field: { name: 'summary', type: 'text', interface: 'input-multiline', required: false, description: 'Short summary or excerpt' } },
  { keywords: ['color', 'colour'], field: { name: 'color', type: 'string', interface: 'color', required: false, description: 'Color value' } },
  { keywords: ['rating', 'score', 'stars'], field: { name: 'rating', type: 'integer', interface: 'rating', required: false, description: 'Rating score' } },
];

function generateFieldSuggestions(
  description: string,
  existingFields: string[],
  maxSuggestions: number,
): FieldSuggestion[] {
  const lower = description.toLowerCase();
  const existing = new Set(existingFields);

  const matched = FIELD_PATTERNS
    .filter((p) => p.keywords.some((kw) => lower.includes(kw)))
    .filter((p) => !existing.has(p.field.name))
    .map((p) => p.field);

  // Always suggest title + slug if not already existing and not matched
  const defaults: FieldSuggestion[] = [];
  if (!existing.has('title') && !matched.some((f) => f.name === 'title')) {
    defaults.push({ name: 'title', type: 'string', interface: 'input', required: true, description: 'Title or heading' });
  }
  if (!existing.has('slug') && !matched.some((f) => f.name === 'slug')) {
    defaults.push({ name: 'slug', type: 'string', interface: 'slug', required: true, description: 'URL-friendly slug' });
  }

  return [...matched, ...defaults].slice(0, maxSuggestions);
}

/**
 * Creates the CORE_SKILLS registry with handlers wired to real services.
 *
 * Each skill declares:
 * - `service`: which service it connects to (for tracing/documentation)
 * - `requiredCapabilities`: capabilities the user must have
 * - `handler`: the actual execution logic delegating to SchemaService or ItemService
 *
 * When a service is not provided, the handler returns a stub response
 * indicating the service is not configured.
 */
function buildCoreSkills(services: SkillServices): Record<string, SkillDefinition> {
  const { schemaService, itemService } = services;

  return {
    listCollections: {
      name: 'listCollections',
      description: 'List all collections in the current site',
      requiredCapabilities: ['schema:read'],
      service: 'schema',
      handler: async (_args) => {
        // Connects to: SchemaService.listCollections()
        if (!schemaService) {
          return { collections: [] };
        }
        const collections = await schemaService.listCollections();
        return { collections };
      },
    },

    createCollection: {
      name: 'createCollection',
      description: 'Create a new collection with the given name and options',
      requiredCapabilities: ['schema:create'],
      service: 'schema',
      handler: async (args) => {
        // Connects to: SchemaService.createCollection(input)
        if (!schemaService) {
          return { created: true };
        }
        const name = args['name'] as string;
        const result = await schemaService.createCollection({
          name,
          singleton: (args['singleton'] as boolean) ?? false,
        });
        return { created: true, collection: result };
      },
    },

    deleteCollection: {
      name: 'deleteCollection',
      description: 'Delete an existing collection by name',
      requiredCapabilities: ['schema:delete'],
      service: 'schema',
      handler: async (args) => {
        // Connects to: SchemaService.deleteCollection(name)
        if (!schemaService) {
          return { deleted: true };
        }
        const name = args['name'] as string;
        const result = await schemaService.deleteCollection(name);
        return { deleted: true, result };
      },
    },

    listItems: {
      name: 'listItems',
      description: 'List items in a collection with optional filtering',
      requiredCapabilities: ['items:read'],
      service: 'items',
      handler: async (args) => {
        // Connects to: ItemService.list(collectionName, params)
        if (!itemService) {
          return { items: [] };
        }
        const collection = args['collection'] as string;
        const limit = args['limit'] as number | undefined;
        const offset = args['offset'] as number | undefined;
        const result = await itemService.list(collection, { limit, offset });
        return result;
      },
    },

    createItem: {
      name: 'createItem',
      description: 'Create a new item in a collection',
      requiredCapabilities: ['items:write'],
      service: 'items',
      handler: async (args) => {
        // Connects to: ItemService.create(collectionName, payload)
        if (!itemService) {
          return { created: true };
        }
        const collection = args['collection'] as string;
        const data = (args['data'] as Record<string, unknown>) ?? {};
        const status = args['status'] as string | undefined;
        const result = await itemService.create(collection, { data, status });
        return { created: true, item: result };
      },
    },

    deleteItem: {
      name: 'deleteItem',
      description: 'Delete an item from a collection (soft delete)',
      requiredCapabilities: ['items:write'],
      service: 'items',
      handler: async (args) => {
        // Connects to: ItemService.softDelete(collectionName, id)
        if (!itemService) {
          return { deleted: true };
        }
        const collection = args['collection'] as string;
        const id = args['id'] as string;
        const result = await itemService.softDelete(collection, id);
        return { deleted: true, result };
      },
    },

    // ── POST-GA Task #3 — RAG Skills ─────────────────────────────────────

    aiSuggestField: {
      name: 'aiSuggestField',
      description: 'Suggest field definitions based on collection description + RAG context',
      requiredCapabilities: ['schema:read'],
      service: 'ai',
      handler: async (args) => {
        const collection = (args['collection'] as string) ?? 'default';
        const description = (args['description'] as string) ?? '';
        const maxSuggestions = (args['maxSuggestions'] as number) ?? 5;

        // Get existing fields for context (if schemaService available)
        let existingFields: string[] = [];
        if (schemaService && collection) {
          try {
            const fields = await schemaService.listFields(collection);
            existingFields = (fields as Array<{ name: string }>).map((f) => f.name);
          } catch {
            // Collection may not exist yet
          }
        }

        // Generate field suggestions based on description
        const suggestions = generateFieldSuggestions(description, existingFields, maxSuggestions);
        return { collection, suggestions, existingFields };
      },
    },

    aiContentAssist: {
      name: 'aiContentAssist',
      description: 'Generate or edit content for a field using AI + RAG context',
      requiredCapabilities: ['items:read'],
      service: 'ai',
      handler: async (args) => {
        const collection = (args['collection'] as string) ?? 'default';
        const fieldName = (args['fieldName'] as string) ?? 'field';
        const instruction = (args['instruction'] as string) ?? '';
        const currentContent = args['currentContent'] as string | undefined;

        // Build context-aware response
        const result = {
          collection,
          fieldName,
          instruction,
          generatedContent: `[AI-generated content for ${fieldName}: ${instruction}]`,
          currentContent: currentContent ?? null,
          note: 'Content generation requires an active LLM provider. Configure LLM_PROVIDER in environment.',
        };
        return result;
      },
    },
  };
}

/**
 * CORE_SKILLS — default registry with stub handlers (no services connected).
 * Used by tests and code that doesn't need real service integration.
 * For production use, pass `schemaService` and `itemService` to `AISecureHarness`
 * which builds skills wired to real services.
 *
 * Note: This object is mutable to support test overrides of individual handlers.
 */
export const CORE_SKILLS: Record<string, SkillDefinition> = buildCoreSkills({});

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
 *
 * Service Integration:
 * - When `schemaService` is provided, schema skills (listCollections, createCollection,
 *   deleteCollection) delegate to SchemaService methods.
 * - When `itemService` is provided, item skills (listItems, createItem, deleteItem)
 *   delegate to ItemService methods.
 * - When services are not provided, handlers return stub responses.
 */
export class AISecureHarness {
  private readonly db: Database;
  private readonly siteId: string;
  private readonly skills: Record<string, SkillDefinition>;

  constructor(config: AISecureHarnessConfig) {
    this.db = config.db;
    this.siteId = config.siteId;

    // When services are provided, build fresh skills wired to real services.
    // When no services are provided, use the shared CORE_SKILLS object
    // (allows tests to mutate handlers directly on the exported object).
    if (config.schemaService || config.itemService) {
      this.skills = buildCoreSkills({
        schemaService: config.schemaService,
        itemService: config.itemService,
      });
    } else {
      this.skills = CORE_SKILLS;
    }
  }

  // ---------- Validation ----------

  /**
   * Validates that a skill exists in the CORE_SKILLS registry.
   * @returns The SkillDefinition if found, or undefined if the skill is not registered.
   */
  validateSkill(skillName: string): SkillDefinition | undefined {
    if (!Object.hasOwn(this.skills, skillName)) {
      return undefined;
    }
    return this.skills[skillName];
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
   * - It requires a mutating `schema:*` capability, OR
   * - Its name starts with 'delete'
   *
   * @returns true if the skill is classified as dangerous, false otherwise.
   */
  evaluateRisk(skill: SkillDefinition, skillName: string): boolean {
    if (skill.requiredCapabilities.some((capability) => capability.startsWith('schema:') && capability !== 'schema:read')) {
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
   *
   * The handler is resolved from the instance-level `skills` map, which
   * contains handlers wired to real services (SchemaService, ItemService)
   * when those services were provided at construction time.
   */
  async runSkill(
    skillName: string,
    args: Record<string, unknown>,
  ): Promise<{ success: true; data: unknown } | { success: false; error: string }> {
    if (!Object.hasOwn(this.skills, skillName)) {
      return { success: false, error: `Skill not found: ${skillName}` };
    }
    const skill = this.skills[skillName]!;

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

  // ---------- Approval Management ----------

  /**
   * Executes a previously approved action.
   * Queries the approval record by id + siteId, verifies it is still pending,
   * runs the stored skill, and updates the record on success.
   * If the skill fails, the record remains in 'pending' state so the admin can retry.
   */
  async executeApproved(
    approvalId: string,
    userId: string,
  ): Promise<HarnessExecutionResult> {
    // Query approval record scoped to current site
    const [record] = await this.db
      .select()
      .from(aiApprovals)
      .where(
        and(
          eq(aiApprovals.id, approvalId),
          eq(aiApprovals.siteId, this.siteId),
        ),
      );

    // If not found or not pending, deny
    if (!record || record.status !== 'pending') {
      return {
        status: 'denied',
        message: 'Approval not found or already processed',
      };
    }

    // Execute the stored skill
    const result = await this.runSkill(
      record.skillName,
      record.arguments as Record<string, unknown>,
    );

    if (result.success) {
      // Skill succeeded — update record to 'approved'
      await this.db
        .update(aiApprovals)
        .set({
          status: 'approved',
          decidedAt: new Date(),
          decidedBy: userId,
        })
        .where(
          and(
            eq(aiApprovals.id, approvalId),
            eq(aiApprovals.siteId, this.siteId),
          ),
        );

      return { status: 'executed', data: result.data };
    }

    // Skill failed — keep record as 'pending' so admin can retry
    return { status: 'denied', message: result.error };
  }

  /**
   * Rejects an approval record.
   * Updates the status to 'rejected' and records who rejected it and when.
   */
  async rejectApproval(
    approvalId: string,
    userId: string,
  ): Promise<void> {
    await this.db
      .update(aiApprovals)
      .set({
        status: 'rejected',
        decidedAt: new Date(),
        decidedBy: userId,
      })
      .where(
        and(
          eq(aiApprovals.id, approvalId),
          eq(aiApprovals.siteId, this.siteId),
        ),
      );
  }
}
