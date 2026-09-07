import { agentApprovals, aiApprovals, flowRuns, flows } from '@lumibase/database';
import type { Database } from '@lumibase/database';
import { and, eq } from 'drizzle-orm';
import type { SchemaService } from './schema-service';
import type { ItemService } from './item-service';
import type { AccessService } from './access-service';
import type { ConfigService } from './config-service';
import type { ExtensionsService } from './extensions-service';
import type { IntentService } from './intent-service';
import { runFlow, type FlowGraph } from './flow-service';
import { ContentVersionService } from './content-version-service';
import type { ConfiguredLLM } from './llm-provider';
import type { KeyProvider, QueueProvider } from '@lumibase/runtime';
import type { AgentNotifier } from '../modules/notifications/agent-notifications';
import { agentAutonomousOpsTotal } from './agent-metrics';
import { AgentRunService, type AgentRunEnvelope } from './agent-run-service';
import { AUTONOMY_LEVELS, AutonomyService } from './autonomy-service';
import { KillSwitchService } from './kill-switch-service';
import { getLoadGuard } from './load-guard-service';
import { ToolRegistryService } from './tool-registry-service';
import { VetoService } from './veto-service';

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
  service: 'schema' | 'items' | 'ai' | 'access' | 'intents' | 'flows' | 'deployments' | 'cdc-feed';
  handler: (args: Record<string, unknown>) => Promise<unknown>;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  owner?: string;
  /**
   * Forces the skill to be classified dangerous (HITL/autonomy gated) even when
   * its capabilities/name don't match the auto rules. Used for governed
   * namespaces (`access:*`, `intents:*`, `flows:*`, …) whose write/delete ops
   * must never execute without the trust gradient. Item CRUD stays unflagged so
   * its existing autonomy behaviour is unchanged.
   */
  dangerous?: boolean;
}

/**
 * Result returned by the harness after evaluating and/or executing a skill.
 */
export interface HarnessExecutionResult {
  status: 'executed' | 'pending_approval' | 'denied';
  data?: unknown;
  approvalId?: string;
  agentApprovalId?: string;
  goalId?: string;
  runId?: string;
  toolCallId?: string;
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
  /**
   * Configured LLM for generation skills (`createConfiguredLLMProvider`).
   * Pass `null` when the environment was checked and no provider exists —
   * generation skills then fail with LLM_NOT_CONFIGURED instead of stubbing.
   * Omit entirely to keep offline deterministic handlers (tests).
   */
  llm?: ConfiguredLLM | null;
  /** Queue provider for veto-window commit jobs and dead letters. */
  queue?: QueueProvider;
  /**
   * KeyProvider for deployment skills — decrypts/encrypts Provider tokens.
   * When omitted, deployment skills fall back to a clear error instead of
   * stubbing (they have no meaningful offline behaviour).
   */
  keys?: KeyProvider;
  /** AccessService for governed RBAC + identity skills (roles/policies/api-keys/users/teams). */
  accessService?: AccessService;
  /** IntentService for governed content-intent (SLO) skills. */
  intentService?: IntentService;
  /** ConfigService for governed config skills (settings/translations/webhooks). */
  configService?: ConfigService;
  /** ExtensionsService for governed extension skills. */
  extensionsService?: ExtensionsService;
  /** Enables first-class agent_goals/runs/tool_calls audit for tests or non-service callers. */
  enableAgentHarnessAudit?: boolean;
  /**
   * Optional push-notification sink (push-noti feature). When provided, a
   * newly created HITL approval is pushed in-app / via Web Push so a reviewer
   * is reached immediately. Best-effort — never blocks execution.
   */
  notify?: AgentNotifier;
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
  /** Governed RBAC + identity service (roles/policies/api-keys/users/teams). */
  accessService?: AccessService;
  /** Governed content-intent (SLO) service. */
  intentService?: IntentService;
  /** Governed config service (settings/translations/webhooks). */
  configService?: ConfigService;
  /** Governed extensions service. */
  extensionsService?: ExtensionsService;
  /** Tenant-scoped DB handle for governed skills with no dedicated service (flows). */
  db?: Database;
  siteId?: string;
  /** KeyProvider for deployment token encryption/decryption. */
  keys?: KeyProvider;
  /**
   * Configured LLM for generation skills.
   * - key absent: offline deterministic handlers (shared CORE_SKILLS test registry).
   * - `null`: the caller resolved the environment and found no provider —
   *   generation skills fail with LLM_NOT_CONFIGURED instead of stubbing.
   * - object: real LLM execution.
   */
  llm?: ConfiguredLLM | null;
}

// ---------------------------------------------------------------------------
// LLM JSON completion helpers (generation skills)
// ---------------------------------------------------------------------------

/** Rough token estimate (~4 chars/token) for run cost metrics. */
function estimateTokens(...texts: Array<string | null | undefined>): number {
  return Math.ceil(texts.reduce((sum, t) => sum + (t?.length ?? 0), 0) / 4);
}

/**
 * Extracts the first JSON value from an LLM response, tolerating prose or
 * markdown fences around it.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.replace(/```(?:json)?/g, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall back to the outermost {...} or [...] block.
    for (const [open, close] of [['{', '}'], ['[', ']']] as const) {
      const start = trimmed.indexOf(open);
      const end = trimmed.lastIndexOf(close);
      if (start !== -1 && end > start) {
        try {
          return JSON.parse(trimmed.slice(start, end + 1));
        } catch {
          // try next bracket pair
        }
      }
    }
  }
  throw new Error('LLM_INVALID_JSON: model response did not contain valid JSON');
}

interface LLMJsonResult<T> {
  value: T;
  meta: { provider: string; model: string; estimatedTokens: number };
}

/** A skill counts against the write budget when it mutates data or schema. */
function isWriteSkill(tool: { requiredCapabilities?: unknown }): boolean {
  const caps = Array.isArray(tool.requiredCapabilities)
    ? (tool.requiredCapabilities as string[])
    : [];
  return caps.some((cap) => /:(write|update|create|delete)$/.test(cap));
}

/**
 * Pure classifier: is this skill a control-plane / dangerous operation?
 *
 * Mirrors {@link AISecureHarness.evaluateRisk} exactly so callers outside the
 * harness (e.g. the MCP route's admin backstop) agree byte-for-byte on which
 * skills are control-plane. A skill is control-plane when it is explicitly
 * flagged `dangerous`, requires a mutating `schema:*` capability, or its name
 * starts with `delete` (covers `deleteCollection`, `deleteRole`, …). Keep this
 * and `evaluateRisk` in lockstep.
 */
export function isControlPlaneSkill(
  skill: Pick<SkillDefinition, 'requiredCapabilities' | 'dangerous'>,
  skillName: string,
): boolean {
  if (skill.dangerous) return true;
  if (
    skill.requiredCapabilities.some(
      (capability) => capability.startsWith('schema:') && capability !== 'schema:read',
    )
  ) {
    return true;
  }
  return skillName.startsWith('delete');
}

/**
 * Skills whose effects cannot be reverted from revisions (dropped schema
 * loses data). The autonomy resolver hard-caps them at L2 — they never
 * stage into the veto window or run on autopilot (Req 12.7).
 */
const IRREVERSIBLE_SKILLS = new Set([
  'deleteCollection',
  'deleteField',
  'deleteRole',
  'deletePolicy',
  'deleteRelation',
  'revokeApiKey',
  'removeUser',
]);

/** The capability whose autonomy grant governs a dangerous skill. */
function primaryDangerousCapability(
  tool: { requiredCapabilities?: unknown },
  skillName: string,
): string {
  const caps = Array.isArray(tool.requiredCapabilities)
    ? (tool.requiredCapabilities as string[])
    : [];
  return caps.find((cap) => /:(write|update|create|delete)$/.test(cap)) ?? caps[0] ?? skillName;
}

/**
 * Only single-item data patches stage into the veto window in v1 — the
 * staged delta has a well-defined before/after and commit path.
 */
function isStageableItemPatch(skillName: string, args: Record<string, unknown>): boolean {
  return (
    skillName === 'updateItem' &&
    typeof args['collection'] === 'string' &&
    typeof args['id'] === 'string' &&
    typeof args['data'] === 'object' &&
    args['data'] !== null &&
    !Array.isArray(args['data']) &&
    Object.keys(args['data'] as Record<string, unknown>).length > 0 &&
    args['status'] === undefined
  );
}

/**
 * Lifts LLM usage metadata returned by generation skills into run metrics
 * (model + estimated tokens/cost; Req 2.3).
 */
function extractLLMMeta(data: unknown): Record<string, unknown> {
  if (data && typeof data === 'object' && 'meta' in data) {
    const meta = (data as { meta?: unknown }).meta;
    if (meta && typeof meta === 'object') {
      return { llm: meta };
    }
  }
  return {};
}

/**
 * Runs a single system+user completion and parses the response as JSON.
 * Throws LLM_NOT_CONFIGURED when no provider is available (no stub fallback)
 * and surfaces provider errors with an explicit code.
 */
async function completeJson<T = unknown>(
  llm: ConfiguredLLM | null | undefined,
  system: string,
  user: string,
): Promise<LLMJsonResult<T>> {
  if (!llm) {
    throw new Error(
      'LLM_NOT_CONFIGURED: set LLM_PROVIDER and provider credentials to enable AI generation skills',
    );
  }
  let content: string | null;
  try {
    const response = await llm.provider.chat([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ]);
    content = response.content;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`LLM_PROVIDER_ERROR: ${message}`);
  }
  if (!content) {
    throw new Error('LLM_EMPTY_RESPONSE: model returned no content');
  }
  return {
    value: extractJson(content) as T,
    meta: {
      provider: llm.name,
      model: llm.model,
      estimatedTokens: estimateTokens(system, user, content),
    },
  };
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

interface CollectionFieldSummary {
  name: string;
  type: string;
  required: boolean;
}

/** Reads real field definitions for the given collections (best-effort). */
async function describeCollections(
  schemaService: SchemaService | undefined,
  collections: string[],
): Promise<Record<string, CollectionFieldSummary[]>> {
  const result: Record<string, CollectionFieldSummary[]> = {};
  if (!schemaService) return result;
  for (const name of collections) {
    try {
      const fields = (await schemaService.listFields(name)) as Array<{
        name: string;
        type: string;
        nullable?: boolean;
      }>;
      result[name] = fields.map((f) => ({
        name: f.name,
        type: f.type,
        required: f.nullable === false,
      }));
    } catch {
      result[name] = [];
    }
  }
  return result;
}

/** Maps LumiBase field types onto OpenAPI schema types. */
function openApiType(fieldType: string): string {
  switch (fieldType) {
    case 'integer':
      return 'integer';
    case 'float':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'json':
      return 'object';
    default:
      return 'string';
  }
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
  const { schemaService, itemService, accessService, intentService, configService, extensionsService, db, siteId } = services;
  /** Distinguishes "offline test registry" from "environment has no LLM". */
  const llmResolved = 'llm' in services;
  const llm = services.llm ?? null;

  /**
   * Lazily construct a site-scoped DeploymentService for deployment skills.
   * Requires db/siteId/keys; without them (offline registry) the skill fails
   * with a clear error instead of stubbing.
   */
  /**
   * A write handler whose service is absent must FAIL, not return a
   * success-shaped stub (#453). An unwired dependency and a completed side
   * effect are otherwise indistinguishable to the approval/audit trail: the
   * approval resolves "executed", provenance records success, and nothing
   * happened. Reads may still answer empty offline; writes may not.
   *
   * Mirrors the existing DEPLOYMENTS_NOT_CONFIGURED / CDC_FEED_NOT_CONFIGURED
   * / LLM_NOT_CONFIGURED convention.
   */
  function requireService<T>(service: T | undefined, name: string): T {
    if (!service) {
      throw new Error(
        `${name}_NOT_CONFIGURED: this skill performs a write and requires its service to be wired`,
      );
    }
    return service;
  }

  const deploymentService = async () => {
    if (!services.db || !services.siteId || !services.keys) {
      throw new Error('DEPLOYMENTS_NOT_CONFIGURED: deployment skills require a runtime KeyProvider');
    }
    // Lazy import keeps the harness decoupled from the deployment module.
    const { DeploymentService } = await import('./deployment/deployment-service');
    return new DeploymentService({ db: services.db, siteId: services.siteId, keys: services.keys });
  };

  const cdcFeedService = async () => {
    if (!services.db || !services.siteId) {
      throw new Error('CDC_FEED_NOT_CONFIGURED: change-feed skills require a tenant db context');
    }
    // Lazy import keeps the harness decoupled from the change-feed module.
    const [{ SubscriptionService }, { DrizzleCdcEventStore }, { readRetentionDays }] =
      await Promise.all([
        import('../modules/cdc/change-feed/subscription-service'),
        import('../modules/cdc/change-feed/feed-reader'),
        import('../modules/cdc/change-feed/retention'),
      ]);
    const retentionDays = await readRetentionDays(services.db, services.siteId);
    return new SubscriptionService({
      db: services.db,
      siteId: services.siteId,
      eventStore: new DrizzleCdcEventStore(services.db),
      retentionDays,
    });
  };

  /**
   * Content-version service for the versioning skills. Needs item access (to
   * snapshot/promote main) plus a tenant db context; without them (offline
   * registry) the skill returns a stub so the shared CORE_SKILLS registry
   * stays offline-safe.
   */
  const contentVersionService = (): ContentVersionService | null => {
    if (!itemService || !db || !siteId) return null;
    // Agent-authored versions: createdBy stays null (the run stamps revision
    // provenance separately via ItemService.setProvenance on promote).
    return new ContentVersionService({ db, siteId, userId: null, items: itemService });
  };

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
        const schemaServiceRef = requireService(schemaService, 'SCHEMA_SERVICE');
        const name = args['name'] as string;
        const result = await schemaServiceRef.createCollection({
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
        const schemaServiceRef = requireService(schemaService, 'SCHEMA_SERVICE');
        const name = args['name'] as string;
        const result = await schemaServiceRef.deleteCollection(name);
        return { deleted: true, result };
      },
    },

    createField: {
      name: 'createField',
      description: 'Append a new field to an existing collection',
      requiredCapabilities: ['schema:update'],
      service: 'schema',
      handler: async (args) => {
        // Connects to: SchemaService.createField(collectionName, input)
        const schemaServiceRef = requireService(schemaService, 'SCHEMA_SERVICE');
        const collection = args['collection'] as string;
        const name = args['name'] as string;
        const type = args['type'] as string;
        const required = (args['required'] as boolean) ?? false;
        const result = await schemaServiceRef.createField(collection, { name, type, interface: 'input', required });
        return { created: true, field: result };
      },
    },

    deleteField: {
      name: 'deleteField',
      description: 'Delete a field from an existing collection',
      requiredCapabilities: ['schema:delete'],
      service: 'schema',
      handler: async (args) => {
        // Connects to: SchemaService.deleteField(collectionName, fieldName)
        const schemaServiceRef = requireService(schemaService, 'SCHEMA_SERVICE');
        const collection = args['collection'] as string;
        const name = args['name'] as string;
        const result = await schemaServiceRef.deleteField(collection, name);
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
        const itemServiceRef = requireService(itemService, 'ITEM_SERVICE');
        const collection = args['collection'] as string;
        const data = (args['data'] as Record<string, unknown>) ?? {};
        const status = args['status'] as string | undefined;
        const result = await itemServiceRef.create(collection, { data, status });
        return { created: true, item: result };
      },
    },

    updateItem: {
      name: 'updateItem',
      description: 'Update fields of an existing item in a collection',
      requiredCapabilities: ['items:update'],
      service: 'items',
      handler: async (args) => {
        // Connects to: ItemService.patch(collectionName, id, patch)
        const itemServiceRef = requireService(itemService, 'ITEM_SERVICE');
        const collection = args['collection'] as string;
        const id = args['id'] as string;
        const data = (args['data'] as Record<string, unknown>) ?? {};
        const status = args['status'] as string | undefined;
        const result = await itemServiceRef.patch(collection, id, { data, ...(status ? { status } : {}) });
        return { updated: true, item: result };
      },
    },

    deleteItem: {
      name: 'deleteItem',
      description: 'Delete an item from a collection (soft delete)',
      requiredCapabilities: ['items:write'],
      service: 'items',
      handler: async (args) => {
        // Connects to: ItemService.softDelete(collectionName, id)
        const itemServiceRef = requireService(itemService, 'ITEM_SERVICE');
        const collection = args['collection'] as string;
        const id = args['id'] as string;
        const result = await itemServiceRef.softDelete(collection, id);
        return { deleted: true, result };
      },
    },

    // ── Content versions — named parallel draft branches of an item ──────────
    // Reads (list/compare) are safe. Writes are forced dangerous so they run
    // through the HITL + autonomy gradient (Wave 2, `docs/en/mcp/`): a version
    // create/update/delete guards the draft branch, and `promoteVersion` applies
    // a branch to main — the highest-risk step (autonomy hard-capped ≤ L2 unless
    // a role earns higher). Mirrors the REST surface in `routes/items.ts`.

    listVersions: {
      name: 'listVersions',
      description: 'List the named version branches of an item (with a mainChanged flag per branch).',
      requiredCapabilities: ['items:read'],
      service: 'items',
      inputSchema: {
        type: 'object',
        properties: { collection: { type: 'string' }, itemId: { type: 'string' } },
        required: ['collection', 'itemId'],
      },
      handler: async (args) => {
        const svc = contentVersionService();
        if (!svc) return { versions: [] };
        const versions = await svc.list(args['collection'] as string, args['itemId'] as string);
        return { versions };
      },
    },

    compareVersion: {
      name: 'compareVersion',
      description: 'Compare a version branch against the item’s current main data (returns field-level changes).',
      requiredCapabilities: ['items:read'],
      service: 'items',
      inputSchema: {
        type: 'object',
        properties: {
          collection: { type: 'string' },
          itemId: { type: 'string' },
          key: { type: 'string' },
        },
        required: ['collection', 'itemId', 'key'],
      },
      handler: async (args) => {
        const svc = contentVersionService();
        if (!svc) return { main: {}, version: {}, changes: [] };
        return svc.compare(args['collection'] as string, args['itemId'] as string, args['key'] as string);
      },
    },

    createVersion: {
      name: 'createVersion',
      description: 'Snapshot the item’s current data into a new named version branch.',
      requiredCapabilities: ['items:write'],
      service: 'items',
      dangerous: true,
      inputSchema: {
        type: 'object',
        properties: {
          collection: { type: 'string' },
          itemId: { type: 'string' },
          key: { type: 'string' },
          name: { type: 'string' },
        },
        required: ['collection', 'itemId', 'key', 'name'],
      },
      handler: async (args) => {
        const svc = contentVersionService();
        if (!svc) return { created: true };
        const version = await svc.create(
          args['collection'] as string,
          args['itemId'] as string,
          args['key'] as string,
          args['name'] as string,
        );
        return { created: true, version };
      },
    },

    updateVersion: {
      name: 'updateVersion',
      description: 'Update a version branch’s draft data and/or display name.',
      requiredCapabilities: ['items:write'],
      service: 'items',
      dangerous: true,
      inputSchema: {
        type: 'object',
        properties: {
          collection: { type: 'string' },
          itemId: { type: 'string' },
          key: { type: 'string' },
          data: { type: 'object' },
          name: { type: 'string' },
        },
        required: ['collection', 'itemId', 'key'],
      },
      handler: async (args) => {
        const svc = contentVersionService();
        if (!svc) return { updated: true };
        const patch: { data?: Record<string, unknown>; name?: string } = {};
        if (args['data'] !== undefined) patch.data = args['data'] as Record<string, unknown>;
        if (args['name'] !== undefined) patch.name = args['name'] as string;
        const version = await svc.update(
          args['collection'] as string,
          args['itemId'] as string,
          args['key'] as string,
          patch,
        );
        return { updated: true, version };
      },
    },

    deleteVersion: {
      name: 'deleteVersion',
      description: 'Delete a version branch (does not touch main).',
      requiredCapabilities: ['items:write'],
      service: 'items',
      inputSchema: {
        type: 'object',
        properties: {
          collection: { type: 'string' },
          itemId: { type: 'string' },
          key: { type: 'string' },
        },
        required: ['collection', 'itemId', 'key'],
      },
      handler: async (args) => {
        const svc = contentVersionService();
        if (!svc) return { deleted: true };
        await svc.remove(args['collection'] as string, args['itemId'] as string, args['key'] as string);
        return { deleted: true, key: args['key'] };
      },
    },

    promoteVersion: {
      name: 'promoteVersion',
      description:
        'Apply a version branch’s data to main (writes a revision + invalidates caches), then delete the branch. Reports whether main had diverged from the snapshot.',
      requiredCapabilities: ['items:write'],
      service: 'items',
      dangerous: true,
      inputSchema: {
        type: 'object',
        properties: {
          collection: { type: 'string' },
          itemId: { type: 'string' },
          key: { type: 'string' },
        },
        required: ['collection', 'itemId', 'key'],
      },
      handler: async (args) => {
        const svc = contentVersionService();
        if (!svc) return { promoted: true };
        const result = await svc.promote(
          args['collection'] as string,
          args['itemId'] as string,
          args['key'] as string,
        );
        return { promoted: true, ...result };
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

        if (!llmResolved) {
          // Offline registry: deterministic keyword-based suggestions.
          const suggestions = generateFieldSuggestions(description, existingFields, maxSuggestions);
          return { collection, suggestions, existingFields };
        }

        const { value, meta } = await completeJson<unknown>(
          llm,
          'You design CMS field schemas. Reply with ONLY a JSON array of field suggestions, each: ' +
            '{"name": string (snake_case), "type": one of string|text|integer|float|boolean|dateTime|json, ' +
            '"interface": one of input|input-multiline|wysiwyg|slug|datetime|file|select-dropdown|tags|toggle|color|rating, ' +
            '"required": boolean, "description": string}. Never duplicate existing fields.',
          `Collection: ${collection}\nExisting fields: ${existingFields.join(', ') || '(none)'}\n` +
            `Description: ${description}\nReturn at most ${maxSuggestions} suggestions.`,
        );
        const suggestions = (Array.isArray(value) ? value : [])
          .filter(
            (entry): entry is FieldSuggestion =>
              typeof entry === 'object' &&
              entry !== null &&
              typeof (entry as FieldSuggestion).name === 'string' &&
              typeof (entry as FieldSuggestion).type === 'string',
          )
          .filter((entry) => !existingFields.includes(entry.name))
          .slice(0, maxSuggestions);
        return { collection, suggestions, existingFields, meta };
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

        if (!llmResolved) {
          // Offline registry: deterministic placeholder.
          return {
            collection,
            fieldName,
            instruction,
            generatedContent: `[AI-generated content for ${fieldName}: ${instruction}]`,
            currentContent: currentContent ?? null,
            note: 'Content generation requires an active LLM provider. Configure LLM_PROVIDER in environment.',
          };
        }

        // Retrieval context: sample existing items so generated content
        // matches the collection's real tone and structure.
        let samples: unknown[] = [];
        if (itemService) {
          try {
            const listed = await itemService.list(collection, { limit: 3 });
            samples = (listed as { data?: unknown[] }).data ?? [];
          } catch {
            // Collection may not exist or be empty; generate without samples.
          }
        }

        const { value, meta } = await completeJson<{ content?: unknown }>(
          llm,
          'You write CMS field content. Reply with ONLY JSON: {"content": string}. ' +
            'Match the tone and structure of the sample items when provided. ' +
            'Plain text or HTML depending on what the samples use; no markdown fences.',
          `Collection: ${collection}\nField: ${fieldName}\nInstruction: ${instruction}\n` +
            (currentContent ? `Current content to edit:\n${currentContent}\n` : '') +
            (samples.length > 0 ? `Sample items for context:\n${JSON.stringify(samples).slice(0, 4000)}` : ''),
        );
        const generatedContent = typeof value?.content === 'string' ? value.content : null;
        if (generatedContent === null) {
          throw new Error('LLM_INVALID_JSON: expected {"content": string}');
        }
        return {
          collection,
          fieldName,
          instruction,
          generatedContent,
          currentContent: currentContent ?? null,
          ragSamples: samples.length,
          meta,
        };
      },
    },

    generateAppSpec: {
      name: 'generateAppSpec',
      description: 'Generate page and component specs from selected collections',
      requiredCapabilities: ['schema:read', 'items:read'],
      service: 'ai',
      inputSchema: {
        type: 'object',
        properties: {
          collections: { type: 'array', items: { type: 'string' } },
          targetApp: { type: 'string' },
        },
      },
      handler: async (args) => {
        const collections = Array.isArray(args['collections'])
          ? (args['collections'] as unknown[]).filter((entry): entry is string => typeof entry === 'string')
          : ['products', 'orders', 'customers'];
        const targetApp = (args['targetApp'] as string) ?? 'storefront';

        if (!llmResolved) {
          // Offline registry: deterministic skeleton spec.
          return {
            artifacts: [
              {
                type: 'page_spec',
                title: `${targetApp} page spec`,
                content: { targetApp, collections, pages: collections.map((collection) => ({ collection, route: `/${collection}` })) },
              },
              {
                type: 'component_spec',
                title: `${targetApp} component spec`,
                content: { targetApp, components: collections.map((collection) => `${collection}List`) },
              },
            ],
          };
        }

        const fieldsByCollection = await describeCollections(schemaService, collections);
        const { value, meta } = await completeJson<{ pages?: unknown[]; components?: unknown[] }>(
          llm,
          'You design app specs for a headless CMS frontend. Reply with ONLY JSON: ' +
            '{"pages": [{"collection": string, "route": string, "title": string, ' +
            '"sections": [{"id": string, "component": string, ' +
            '"source": {"collection": string, "limit": number, "orderBy": string}}]}], ' +
            '"components": [{"name": string, "collection": string, "props": object}]}. ' +
            'Every section that renders collection data MUST declare a "source" binding ' +
            'so it hydrates through the single-roundtrip Delivery API.',
          `Target app: ${targetApp}\nCollections and their fields:\n${JSON.stringify(fieldsByCollection, null, 2)}`,
        );
        const pages = Array.isArray(value?.pages) ? value.pages : [];
        const components = Array.isArray(value?.components) ? value.components : [];
        if (pages.length === 0) {
          throw new Error('LLM_INVALID_JSON: expected at least one page in app spec');
        }
        return {
          artifacts: [
            {
              type: 'page_spec',
              title: `${targetApp} page spec`,
              content: { targetApp, collections, pages },
            },
            {
              type: 'component_spec',
              title: `${targetApp} component spec`,
              content: { targetApp, components },
            },
          ],
          meta,
        };
      },
    },

    generateApiDocs: {
      name: 'generateApiDocs',
      description: 'Generate API documentation artifact from schema and permissions',
      requiredCapabilities: ['schema:read'],
      service: 'ai',
      handler: async (args) => {
        let collections = Array.isArray(args['collections'])
          ? (args['collections'] as unknown[]).filter((entry): entry is string => typeof entry === 'string')
          : [];

        if (!llmResolved || !schemaService) {
          // Offline registry: path skeleton without field-level schemas.
          return {
            artifacts: [
              {
                type: 'api_spec',
                title: 'Generated API spec',
                content: {
                  openapi: '3.1.0',
                  info: { title: 'LumiBase generated API', version: '0.1.0' },
                  paths: Object.fromEntries(collections.map((collection) => [`/items/${collection}`, { get: { summary: `List ${collection}` } }])),
                },
              },
            ],
          };
        }

        // Schema-driven generation: the source of truth is the live schema,
        // so the spec is derived deterministically rather than asked of an LLM.
        if (collections.length === 0) {
          const all = await schemaService.listCollections();
          collections = (all as Array<{ name: string }>).map((c) => c.name);
        }
        const fieldsByCollection = await describeCollections(schemaService, collections);
        const paths: Record<string, unknown> = {};
        const schemas: Record<string, unknown> = {};
        for (const [name, fields] of Object.entries(fieldsByCollection)) {
          const properties: Record<string, unknown> = {
            id: { type: 'string' },
            status: { type: 'string' },
          };
          for (const field of fields) {
            properties[field.name] = { type: openApiType(field.type), description: field.type };
          }
          schemas[name] = { type: 'object', properties };
          const ref = { $ref: `#/components/schemas/${name}` };
          paths[`/api/v1/items/${name}`] = {
            get: {
              summary: `List ${name}`,
              responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: ref } } } } } } },
            },
            post: { summary: `Create ${name}`, requestBody: { content: { 'application/json': { schema: ref } } }, responses: { '201': { description: 'Created' } } },
          };
          paths[`/api/v1/items/${name}/{id}`] = {
            get: { summary: `Get one ${name}`, responses: { '200': { description: 'OK', content: { 'application/json': { schema: ref } } } } },
            patch: { summary: `Update ${name}`, requestBody: { content: { 'application/json': { schema: ref } } }, responses: { '200': { description: 'OK' } } },
            delete: { summary: `Soft-delete ${name}`, responses: { '204': { description: 'Deleted' } } },
          };
        }
        return {
          artifacts: [
            {
              type: 'api_spec',
              title: 'Generated API spec',
              content: {
                openapi: '3.1.0',
                info: { title: 'LumiBase generated API', version: '0.1.0' },
                paths,
                components: { schemas },
              },
            },
          ],
        };
      },
    },

    generateSeedData: {
      name: 'generateSeedData',
      description: 'Generate seed data artifact for selected collections',
      requiredCapabilities: ['items:write'],
      service: 'ai',
      handler: async (args) => {
        const collection = (args['collection'] as string) ?? 'products';
        const count = Math.max(1, Math.min(Number(args['count'] ?? 3), 20));

        if (!llmResolved) {
          // Offline registry: deterministic placeholder rows.
          return {
            artifacts: [
              {
                type: 'seed_data',
                title: `Seed data for ${collection}`,
                content: {
                  collection,
                  rows: Array.from({ length: count }, (_entry, index) => ({
                    title: `${collection} sample ${index + 1}`,
                    status: 'draft',
                  })),
                },
              },
            ],
          };
        }

        const fieldsByCollection = await describeCollections(schemaService, [collection]);
        const { value, meta } = await completeJson<unknown>(
          llm,
          'You generate realistic seed data for a CMS collection. Reply with ONLY a JSON array ' +
            `of exactly ${count} row objects. Keys must match the field names given; values must ` +
            'fit the field types. Vary the data realistically; never repeat identical rows.',
          `Collection: ${collection}\nFields:\n${JSON.stringify(fieldsByCollection[collection] ?? [], null, 2)}`,
        );
        const rows = (Array.isArray(value) ? value : [])
          .filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
          .slice(0, count)
          .map((row) => ({ status: 'draft', ...row }));
        if (rows.length === 0) {
          throw new Error('LLM_INVALID_JSON: expected a non-empty array of seed rows');
        }
        return {
          artifacts: [
            {
              type: 'seed_data',
              title: `Seed data for ${collection}`,
              content: { collection, rows },
            },
          ],
          meta,
        };
      },
    },

    // ── Governed surface skills (Content OS) ─────────────────────────────────
    // Reads are safe; writes/deletes are forced dangerous so RBAC/intent/flow
    // mutations always run through HITL + the autonomy gradient (Req 4 / 10–13).

    listRelations: {
      name: 'listRelations',
      description: 'List all relations configured in the schema.',
      requiredCapabilities: ['schema:read'],
      service: 'schema',
      handler: async () => {
        if (!schemaService) return { relations: [] };
        return { relations: await schemaService.listRelations() };
      },
    },

    createRelation: {
      name: 'createRelation',
      description: 'Create a relation between two collections (m2o, o2m, m2m, m2a).',
      requiredCapabilities: ['schema:create'],
      service: 'schema',
      handler: async (args) => {
        const schemaServiceRef = requireService(schemaService, 'SCHEMA_SERVICE');
        const relation = await schemaServiceRef.createRelation(args as never);
        return { created: true, relation };
      },
    },

    deleteRelation: {
      name: 'deleteRelation',
      description: 'Delete a relation by id.',
      requiredCapabilities: ['schema:delete'],
      service: 'schema',
      handler: async (args) => {
        const schemaServiceRef = requireService(schemaService, 'SCHEMA_SERVICE');
        await schemaServiceRef.deleteRelation(args['id'] as string);
        return { deleted: true, id: args['id'] };
      },
    },

    listRoles: {
      name: 'listRoles',
      description: 'List RBAC roles for the current site.',
      requiredCapabilities: ['access:read'],
      service: 'access',
      handler: async () => {
        if (!accessService) return { roles: [] };
        return { roles: await accessService.listRoles() };
      },
    },

    createRole: {
      name: 'createRole',
      description: 'Create a new RBAC role.',
      requiredCapabilities: ['access:create'],
      service: 'access',
      dangerous: true,
      handler: async (args) => {
        const accessServiceRef = requireService(accessService, 'ACCESS_SERVICE');
        const role = await accessServiceRef.createRole({
          name: args['name'] as string,
          key: args['key'] as string | undefined,
          description: args['description'] as string | undefined,
          icon: args['icon'] as string | undefined,
          parentId: (args['parentId'] as string | null | undefined) ?? undefined,
          adminAccess: args['adminAccess'] as boolean | undefined,
          appAccess: args['appAccess'] as boolean | undefined,
        });
        return { created: true, role };
      },
    },

    deleteRole: {
      name: 'deleteRole',
      description: 'Delete an RBAC role and its bindings.',
      requiredCapabilities: ['access:delete'],
      service: 'access',
      dangerous: true,
      handler: async (args) => {
        const accessServiceRef = requireService(accessService, 'ACCESS_SERVICE');
        return accessServiceRef.deleteRole(args['id'] as string);
      },
    },

    listPolicies: {
      name: 'listPolicies',
      description: 'List reusable access policies for the current site.',
      requiredCapabilities: ['access:read'],
      service: 'access',
      handler: async () => {
        if (!accessService) return { policies: [] };
        return { policies: await accessService.listPolicies() };
      },
    },

    createPolicy: {
      name: 'createPolicy',
      description: 'Create a new reusable access policy.',
      requiredCapabilities: ['access:create'],
      service: 'access',
      dangerous: true,
      handler: async (args) => {
        const accessServiceRef = requireService(accessService, 'ACCESS_SERVICE');
        const policy = await accessServiceRef.createPolicy({
          name: args['name'] as string,
          key: args['key'] as string | undefined,
          description: args['description'] as string | undefined,
          icon: args['icon'] as string | undefined,
          adminAccess: args['adminAccess'] as boolean | undefined,
          appAccess: args['appAccess'] as boolean | undefined,
          rules: args['rules'] as Record<string, unknown> | undefined,
        });
        return { created: true, policy };
      },
    },

    deletePolicy: {
      name: 'deletePolicy',
      description: 'Delete a reusable access policy.',
      requiredCapabilities: ['access:delete'],
      service: 'access',
      dangerous: true,
      handler: async (args) => {
        const accessServiceRef = requireService(accessService, 'ACCESS_SERVICE');
        return accessServiceRef.deletePolicy(args['id'] as string);
      },
    },

    listIntents: {
      name: 'listIntents',
      description: 'List content intents (SLOs) for the current site.',
      requiredCapabilities: ['intents:read'],
      service: 'intents',
      handler: async () => {
        if (!intentService) return { intents: [] };
        return { intents: await intentService.list() };
      },
    },

    createIntent: {
      name: 'createIntent',
      description: 'Create a content intent (declarative SLO) for a collection.',
      requiredCapabilities: ['intents:write'],
      service: 'intents',
      dangerous: true,
      handler: async (args) => {
        const intentServiceRef = requireService(intentService, 'INTENT_SERVICE');
        const intent = await intentServiceRef.create(args as never);
        return { created: true, intent };
      },
    },

    deleteIntent: {
      name: 'deleteIntent',
      description: 'Delete a content intent by id.',
      requiredCapabilities: ['intents:write'],
      service: 'intents',
      dangerous: true,
      handler: async (args) => {
        const intentServiceRef = requireService(intentService, 'INTENT_SERVICE');
        return intentServiceRef.remove(args['id'] as string);
      },
    },

    listFlows: {
      name: 'listFlows',
      description: 'List automation flows for the current site.',
      requiredCapabilities: ['flows:read'],
      service: 'flows',
      handler: async () => {
        if (!db || !siteId) return { flows: [] };
        const rows = await db.select().from(flows).where(eq(flows.siteId, siteId));
        return { flows: rows };
      },
    },

    createFlow: {
      name: 'createFlow',
      description: 'Create an automation flow (trigger + operation graph).',
      requiredCapabilities: ['flows:write'],
      service: 'flows',
      dangerous: true,
      handler: async (args) => {
        if (!db || !siteId) return { created: true };
        const [row] = await db
          .insert(flows)
          .values({
            siteId,
            name: args['name'] as string,
            description: args['description'] as string | undefined,
            status: (args['status'] as 'active' | 'inactive' | 'draft' | undefined) ?? 'draft',
            triggerType: args['triggerType'] as 'webhook' | 'event' | 'schedule' | 'manual',
            triggerOptions: (args['triggerOptions'] as Record<string, unknown>) ?? {},
            graph: (args['graph'] as Record<string, unknown>) ?? { nodes: [] },
          })
          .returning();
        return { created: true, flow: row };
      },
    },

    deleteFlow: {
      name: 'deleteFlow',
      description: 'Delete an automation flow by id.',
      requiredCapabilities: ['flows:write'],
      service: 'flows',
      dangerous: true,
      handler: async (args) => {
        if (!db || !siteId) return { deleted: true };
        await db
          .delete(flows)
          .where(and(eq(flows.id, args['id'] as string), eq(flows.siteId, siteId)));
        return { deleted: true, id: args['id'] };
      },
    },

    runFlow: {
      name: 'runFlow',
      description: 'Trigger a manual run of an automation flow.',
      requiredCapabilities: ['flows:run'],
      service: 'flows',
      dangerous: true,
      handler: async (args) => {
        if (!db || !siteId) return { skipped: true };
        const id = args['id'] as string;
        const [flow] = await db
          .select()
          .from(flows)
          .where(and(eq(flows.id, id), eq(flows.siteId, siteId)));
        if (!flow) throw new Error('FLOW_NOT_FOUND: no flow with that id');
        const input = (args['input'] as Record<string, unknown>) ?? {};
        const [run] = await db
          .insert(flowRuns)
          .values({ siteId, flowId: id, status: 'running', input })
          .returning();
        const result = await runFlow(flow.graph as FlowGraph, input, { db, siteId });
        await db
          .update(flowRuns)
          .set({
            status: result.status,
            steps: result.steps,
            error: result.error ?? null,
            finishedAt: new Date(),
          })
          .where(eq(flowRuns.id, run!.id));
        return { runId: run!.id, ...result };
      },
    },

    // ── Identity & access (api-keys / users / teams) ─────────────────────────
    listApiKeys: {
      name: 'listApiKeys',
      description: 'List API keys for the current site (token values are never returned).',
      requiredCapabilities: ['api-keys:read'],
      service: 'access',
      handler: async () => {
        if (!accessService) return { apiKeys: [] };
        return { apiKeys: await accessService.listApiKeys() };
      },
    },

    createApiKey: {
      name: 'createApiKey',
      description: 'Create an API key. The plaintext token is returned exactly once.',
      requiredCapabilities: ['api-keys:create'],
      service: 'access',
      dangerous: true,
      handler: async (args) => {
        const accessServiceRef = requireService(accessService, 'ACCESS_SERVICE');
        return accessServiceRef.createApiKey({
          name: args['name'] as string,
          description: args['description'] as string | undefined,
          expiresAt: (args['expiresAt'] as string | null | undefined) ?? undefined,
          metadata: args['metadata'] as Record<string, unknown> | undefined,
        });
      },
    },

    rotateApiKey: {
      name: 'rotateApiKey',
      description: 'Rotate an API key — issues a new token (returned once) and invalidates the old one.',
      requiredCapabilities: ['api-keys:write'],
      service: 'access',
      dangerous: true,
      handler: async (args) => {
        const accessServiceRef = requireService(accessService, 'ACCESS_SERVICE');
        return accessServiceRef.rotateApiKey(args['id'] as string, args['expiresAt'] as string | null | undefined);
      },
    },

    revokeApiKey: {
      name: 'revokeApiKey',
      description: 'Revoke an API key permanently.',
      requiredCapabilities: ['api-keys:delete'],
      service: 'access',
      dangerous: true,
      handler: async (args) => {
        const accessServiceRef = requireService(accessService, 'ACCESS_SERVICE');
        return accessServiceRef.revokeApiKey(args['id'] as string);
      },
    },

    listUsers: {
      name: 'listUsers',
      description: 'List users belonging to the current site.',
      requiredCapabilities: ['users:read'],
      service: 'access',
      handler: async () => {
        if (!accessService) return { users: [] };
        return { users: await accessService.listUsers() };
      },
    },

    inviteUser: {
      name: 'inviteUser',
      description: 'Invite a user by email and bind them to the site, optionally with a role.',
      requiredCapabilities: ['users:write'],
      service: 'access',
      dangerous: true,
      handler: async (args) => {
        const accessServiceRef = requireService(accessService, 'ACCESS_SERVICE');
        const user = await accessServiceRef.inviteUser({
          email: args['email'] as string,
          roleId: args['roleId'] as string | undefined,
        });
        return { invited: true, user };
      },
    },

    updateUser: {
      name: 'updateUser',
      description: "Update a user's site membership (role and/or status).",
      requiredCapabilities: ['users:write'],
      service: 'access',
      dangerous: true,
      handler: async (args) => {
        const accessServiceRef = requireService(accessService, 'ACCESS_SERVICE');
        return accessServiceRef.updateUser(args['id'] as string, {
          roleId: (args['roleId'] as string | null | undefined),
          status: args['status'] as string | undefined,
        });
      },
    },

    removeUser: {
      name: 'removeUser',
      description: 'Remove a user from the site.',
      requiredCapabilities: ['users:delete'],
      service: 'access',
      dangerous: true,
      handler: async (args) => {
        const accessServiceRef = requireService(accessService, 'ACCESS_SERVICE');
        return accessServiceRef.removeUser(args['id'] as string);
      },
    },

    listTeams: {
      name: 'listTeams',
      description: 'List teams in the current site.',
      requiredCapabilities: ['teams:read'],
      service: 'access',
      handler: async () => {
        if (!accessService) return { teams: [] };
        return { teams: await accessService.listTeams() };
      },
    },

    createTeam: {
      name: 'createTeam',
      description: 'Create a team.',
      requiredCapabilities: ['teams:write'],
      service: 'access',
      dangerous: true,
      handler: async (args) => {
        const accessServiceRef = requireService(accessService, 'ACCESS_SERVICE');
        const team = await accessServiceRef.createTeam({
          name: args['name'] as string,
          description: (args['description'] as string | null | undefined) ?? undefined,
        });
        return { created: true, team };
      },
    },

    deleteTeam: {
      name: 'deleteTeam',
      description: 'Delete a team.',
      requiredCapabilities: ['teams:delete'],
      service: 'access',
      dangerous: true,
      handler: async (args) => {
        const accessServiceRef = requireService(accessService, 'ACCESS_SERVICE');
        return accessServiceRef.deleteTeam(args['id'] as string);
      },
    },

    addTeamMember: {
      name: 'addTeamMember',
      description: 'Add a user to a team.',
      requiredCapabilities: ['teams:write'],
      service: 'access',
      dangerous: true,
      handler: async (args) => {
        const accessServiceRef = requireService(accessService, 'ACCESS_SERVICE');
        return accessServiceRef.addTeamMember(args['teamId'] as string, args['userId'] as string);
      },
    },

    removeTeamMember: {
      name: 'removeTeamMember',
      description: 'Remove a user from a team.',
      requiredCapabilities: ['teams:write'],
      service: 'access',
      dangerous: true,
      handler: async (args) => {
        const accessServiceRef = requireService(accessService, 'ACCESS_SERVICE');
        return accessServiceRef.removeTeamMember(args['teamId'] as string, args['userId'] as string);
      },
    },

    // ── Config (settings / translations / webhooks) ──────────────────────────
    listSettings: {
      name: 'listSettings',
      description: 'List site settings, optionally filtered by scope.',
      requiredCapabilities: ['config:read'],
      service: 'access',
      handler: async (args) => {
        if (!configService) return { settings: [] };
        return { settings: await configService.listSettings(args['scope'] as string | undefined) };
      },
    },

    upsertSetting: {
      name: 'upsertSetting',
      description: 'Create or update a site setting (upsert by key).',
      requiredCapabilities: ['config:write'],
      service: 'access',
      dangerous: true,
      handler: async (args) => {
        const configServiceRef = requireService(configService, 'CONFIG_SERVICE');
        const setting = await configServiceRef.upsertSetting({
          key: args['key'] as string,
          value: (args['value'] as Record<string, unknown>) ?? {},
          scope: args['scope'] as string | undefined,
        });
        return { upserted: true, setting };
      },
    },

    deleteSetting: {
      name: 'deleteSetting',
      description: 'Delete a site setting by key.',
      requiredCapabilities: ['config:delete'],
      service: 'access',
      dangerous: true,
      handler: async (args) => {
        const configServiceRef = requireService(configService, 'CONFIG_SERVICE');
        return configServiceRef.deleteSetting(args['key'] as string);
      },
    },

    listTranslations: {
      name: 'listTranslations',
      description: 'List i18n translation strings, optionally filtered by namespace/language.',
      requiredCapabilities: ['config:read'],
      service: 'access',
      handler: async (args) => {
        if (!configService) return { translations: [] };
        return {
          translations: await configService.listTranslations({
            namespace: args['namespace'] as string | undefined,
            language: args['language'] as string | undefined,
          }),
        };
      },
    },

    createTranslation: {
      name: 'createTranslation',
      description: 'Create a translation string.',
      requiredCapabilities: ['config:write'],
      service: 'access',
      dangerous: true,
      handler: async (args) => {
        const configServiceRef = requireService(configService, 'CONFIG_SERVICE');
        const translation = await configServiceRef.createTranslation({
          language: args['language'] as string,
          namespace: args['namespace'] as string,
          key: args['key'] as string,
          value: args['value'] as string,
          status: args['status'] as string | undefined,
        });
        return { created: true, translation };
      },
    },

    updateTranslation: {
      name: 'updateTranslation',
      description: 'Update a translation string by id.',
      requiredCapabilities: ['config:write'],
      service: 'access',
      dangerous: true,
      handler: async (args) => {
        const configServiceRef = requireService(configService, 'CONFIG_SERVICE');
        const { id, ...patch } = args as Record<string, string>;
        return configServiceRef.updateTranslation(String(id), patch);
      },
    },

    deleteTranslation: {
      name: 'deleteTranslation',
      description: 'Delete a translation string by id.',
      requiredCapabilities: ['config:delete'],
      service: 'access',
      dangerous: true,
      handler: async (args) => {
        const configServiceRef = requireService(configService, 'CONFIG_SERVICE');
        return configServiceRef.deleteTranslation(args['id'] as string);
      },
    },

    listWebhooks: {
      name: 'listWebhooks',
      description: 'List outbound webhooks for the current site.',
      requiredCapabilities: ['config:read'],
      service: 'access',
      handler: async () => {
        if (!configService) return { webhooks: [] };
        return { webhooks: await configService.listWebhooks() };
      },
    },

    createWebhook: {
      name: 'createWebhook',
      description: 'Create an outbound webhook on item events.',
      requiredCapabilities: ['config:write'],
      service: 'access',
      dangerous: true,
      handler: async (args) => {
        const configServiceRef = requireService(configService, 'CONFIG_SERVICE');
        const webhook = await configServiceRef.createWebhook({
          name: args['name'] as string,
          url: args['url'] as string,
          actions: args['actions'] as string[] | undefined,
          collections: args['collections'] as string[] | undefined,
          headers: args['headers'] as Record<string, string> | undefined,
          status: args['status'] as 'active' | 'inactive' | undefined,
          secret: args['secret'] as string | null | undefined,
        });
        return { created: true, webhook };
      },
    },

    updateWebhook: {
      name: 'updateWebhook',
      description: 'Update an outbound webhook by id.',
      requiredCapabilities: ['config:write'],
      service: 'access',
      dangerous: true,
      handler: async (args) => {
        const configServiceRef = requireService(configService, 'CONFIG_SERVICE');
        const { id, ...patch } = args as Record<string, unknown>;
        return configServiceRef.updateWebhook(id as string, patch);
      },
    },

    deleteWebhook: {
      name: 'deleteWebhook',
      description: 'Delete an outbound webhook by id.',
      requiredCapabilities: ['config:delete'],
      service: 'access',
      dangerous: true,
      handler: async (args) => {
        const configServiceRef = requireService(configService, 'CONFIG_SERVICE');
        return configServiceRef.deleteWebhook(args['id'] as string);
      },
    },

    // ── Extensions ───────────────────────────────────────────────────────────
    listExtensions: {
      name: 'listExtensions',
      description: 'List extensions installed on the current site.',
      requiredCapabilities: ['extensions:read'],
      service: 'access',
      handler: async () => {
        if (!extensionsService) return { extensions: [] };
        return { extensions: await extensionsService.listExtensions() };
      },
    },

    installExtension: {
      name: 'installExtension',
      description: 'Install (register) an extension on the site from a bundle URL.',
      requiredCapabilities: ['extensions:write'],
      service: 'access',
      dangerous: true,
      handler: async (args) => {
        const extensionsServiceRef = requireService(extensionsService, 'EXTENSIONS_SERVICE');
        const extension = await extensionsServiceRef.installExtension({
          key: args['key'] as string | undefined,
          name: args['name'] as string,
          version: args['version'] as string,
          type: args['type'] as string,
          enabled: args['enabled'] as boolean | undefined,
          bundleUrl: args['bundleUrl'] as string,
          manifest: args['manifest'] as Record<string, string> | undefined,
          capabilities: args['capabilities'] as string[] | undefined,
        });
        return { installed: true, extension };
      },
    },

    updateExtension: {
      name: 'updateExtension',
      description: 'Update an installed extension (enable/disable, version, config).',
      requiredCapabilities: ['extensions:write'],
      service: 'access',
      dangerous: true,
      handler: async (args) => {
        const extensionsServiceRef = requireService(extensionsService, 'EXTENSIONS_SERVICE');
        const { id, ...patch } = args as Record<string, unknown>;
        return extensionsServiceRef.updateExtension(id as string, patch);
      },
    },

    uninstallExtension: {
      name: 'uninstallExtension',
      description: 'Uninstall an extension from the site.',
      requiredCapabilities: ['extensions:delete'],
      service: 'access',
      dangerous: true,
      handler: async (args) => {
        const extensionsServiceRef = requireService(extensionsService, 'EXTENSIONS_SERVICE');
        return extensionsServiceRef.uninstallExtension(args['id'] as string);
      },
    },

    // ── Deployment integrations (spec: deployment-integrations, Req 6) ───────
    // Handlers build a site-scoped DeploymentService from db/siteId/keys; with
    // no tenant context (offline test registry) they fail with a clear error
    // rather than stubbing, since deploy has no meaningful offline behaviour.

    listDeploymentTargets: {
      name: 'listDeploymentTargets',
      description: 'List the configured deployment targets (Vercel/Netlify) for the site.',
      requiredCapabilities: ['deployments:read'],
      service: 'deployments',
      handler: async () => {
        const service = await deploymentService();
        return { targets: await service.listTargets() };
      },
    },

    listDeployments: {
      name: 'listDeployments',
      description: 'List recent deployments, optionally filtered by target or status.',
      requiredCapabilities: ['deployments:read'],
      service: 'deployments',
      handler: async (args) => {
        const service = await deploymentService();
        const deploymentsList = await service.listDeployments({
          targetId: args['targetId'] ? String(args['targetId']) : undefined,
          status: args['status'] ? String(args['status']) : undefined,
        });
        return { deployments: deploymentsList };
      },
    },

    getDeploymentStatus: {
      name: 'getDeploymentStatus',
      description: 'Get the current status and details of a single deployment by id.',
      requiredCapabilities: ['deployments:read'],
      service: 'deployments',
      handler: async (args) => {
        const service = await deploymentService();
        const row = await service.getDeployment(String(args['deploymentId'] ?? ''));
        if (!row) throw new Error('Deployment not found');
        return row;
      },
    },

    triggerDeployment: {
      name: 'triggerDeployment',
      description:
        'Trigger a build/deploy on a deployment target. High-risk: gated by HITL approval below autopilot autonomy.',
      requiredCapabilities: ['deployments:write'],
      service: 'deployments',
      dangerous: true,
      handler: async (args) => {
        const service = await deploymentService();
        const row = await service.trigger(String(args['targetId'] ?? ''), {
          branch: args['branch'] ? String(args['branch']) : undefined,
          reason: args['reason'] ? String(args['reason']) : 'agent deployment',
          source: 'agent',
          triggeredBy: args['__runId'] ? String(args['__runId']) : undefined,
        });
        return { deploymentId: row.id, status: row.status, provider: row.provider };
      },
    },

    // ── Change Feed (spec: cdc-extension-integration, Req 7.4) ─────────────
    // `deleteCdcSubscription` is control-plane purely via the `delete` name
    // prefix in `isControlPlaneSkill` — no manual `dangerous` flag needed.
    // `createCdcSubscription`/`replayCdcSubscription` carry an explicit
    // `dangerous` flag so the agent/MCP path matches the REST posture: the
    // whole `/api/v1/cdc` surface is admin-only (CONTROL_PLANE_PATHS +
    // `authorizeSiteAdmin`), so mutating the change feed via a skill must
    // likewise be control-plane (MCP admin backstop + pre-execute HITL).

    listCdcSubscriptions: {
      name: 'listCdcSubscriptions',
      description: 'List the change-feed subscriptions for the site with their status and lag.',
      requiredCapabilities: ['cdc:manage'],
      service: 'cdc-feed',
      handler: async () => {
        const service = await cdcFeedService();
        return { subscriptions: await service.list() };
      },
    },
    getCdcSubscriptionStatus: {
      name: 'getCdcSubscriptionStatus',
      description: 'Get one change-feed subscription (status, checkpoint cursor, lag).',
      requiredCapabilities: ['cdc:manage'],
      service: 'cdc-feed',
      handler: async (args) => {
        const service = await cdcFeedService();
        return await service.get(String(args['subscriptionId'] ?? ''));
      },
    },
    createCdcSubscription: {
      name: 'createCdcSubscription',
      description:
        'Create a change-feed subscription (pull, webhook, or extension) with optional filters. Control-plane: requires HITL approval below autopilot.',
      requiredCapabilities: ['cdc:manage'],
      service: 'cdc-feed',
      dangerous: true,
      handler: async (args) => {
        const service = await cdcFeedService();
        const { CdcSubscriptionCreateSchema } = await import('@lumibase/contracts/schemas');
        const input = CdcSubscriptionCreateSchema.parse({
          name: String(args['name'] ?? ''),
          kind: String(args['kind'] ?? 'pull'),
          collections: Array.isArray(args['collections']) ? args['collections'] : [],
          operations: Array.isArray(args['operations']) ? args['operations'] : [],
          webhook_id: args['webhookId'] ? String(args['webhookId']) : undefined,
          extension_name: args['extensionName'] ? String(args['extensionName']) : undefined,
        });
        return await service.create(input);
      },
    },
    replayCdcSubscription: {
      name: 'replayCdcSubscription',
      description:
        'Rewind a subscription checkpoint inside the retention window (resets dead/stale to active). Control-plane: requires HITL approval below autopilot.',
      requiredCapabilities: ['cdc:manage'],
      service: 'cdc-feed',
      dangerous: true,
      handler: async (args) => {
        const service = await cdcFeedService();
        return await service.replay(
          String(args['subscriptionId'] ?? ''),
          { occurredAfter: String(args['occurredAfter'] ?? '') },
          { type: 'agent', id: args['__runId'] ? String(args['__runId']) : null },
        );
      },
    },
    deleteCdcSubscription: {
      name: 'deleteCdcSubscription',
      description:
        'Delete a change-feed subscription. Control-plane: requires HITL approval below autopilot.',
      requiredCapabilities: ['cdc:manage'],
      service: 'cdc-feed',
      handler: async (args) => {
        const service = await cdcFeedService();
        await service.remove(String(args['subscriptionId'] ?? ''));
        return { ok: true };
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
  private readonly agentHarnessEnabled: boolean;
  private readonly runService: AgentRunService;
  private readonly toolRegistry: ToolRegistryService;
  private readonly itemService?: ItemService;
  private readonly queue?: QueueProvider;
  private readonly notify?: AgentNotifier;

  constructor(config: AISecureHarnessConfig) {
    this.db = config.db;
    this.siteId = config.siteId;
    this.itemService = config.itemService;
    this.queue = config.queue;
    this.notify = config.notify;
    const hasService = Boolean(
      config.schemaService ||
        config.itemService ||
        config.accessService ||
        config.intentService ||
        config.configService ||
        config.extensionsService ||
        config.keys,
    );
    this.agentHarnessEnabled = config.enableAgentHarnessAudit ?? hasService;

    // When services are provided, build fresh skills wired to real services.
    // When no services are provided, use the shared CORE_SKILLS object
    // (allows tests to mutate handlers directly on the exported object).
    if (hasService) {
      this.skills = buildCoreSkills({
        schemaService: config.schemaService,
        itemService: config.itemService,
        accessService: config.accessService,
        intentService: config.intentService,
        configService: config.configService,
        extensionsService: config.extensionsService,
        db: config.db,
        siteId: config.siteId,
        // Tenant context + KeyProvider enable the deployment skills.
        keys: config.keys,
        // Preserve the "offline registry" mode when callers never resolved
        // an LLM; forward null/instance when they did (Req 2.1/2.2).
        ...('llm' in config ? { llm: config.llm ?? null } : {}),
      });
    } else {
      this.skills = CORE_SKILLS;
    }

    this.runService = new AgentRunService(this.db, this.siteId, config.queue, config.notify);
    this.toolRegistry = new ToolRegistryService(this.db, this.siteId, this.skills);
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
   * The wildcard capability '*' or admin role satisfies all requirements.
   *
   * @returns true if the user has sufficient capabilities, false otherwise.
   */
  checkCapabilities(
    skill: SkillDefinition,
    userCapabilities: string[],
  ): boolean {
    // Wildcard and admin roles grant all capabilities.
    if (userCapabilities.includes('*') || userCapabilities.includes('admin')) {
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
    return isControlPlaneSkill(skill, skillName);
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
    envelope: AgentRunEnvelope = {},
  ): Promise<HarnessExecutionResult> {
    if (!this.agentHarnessEnabled) {
      return this.executeLegacy(skillName, args, userCapabilities, contextMessage);
    }

    // Kill switch (Req 14.2/14.4): a frozen site/role blocks before any
    // goal/run is created; an in-flight run hitting this boundary is
    // cancelled with stopReason 'frozen'. Reads are untouched.
    const killSwitch = new KillSwitchService({ db: this.db, siteId: this.siteId });
    const frozenScope = await killSwitch.frozenScopeFor(envelope.agentName ?? 'lumibase-copilot');
    if (frozenScope) {
      if (envelope.runId) {
        await this.runService.cancelRun(envelope.runId, 'frozen');
      }
      return {
        status: 'denied',
        message: `frozen: agent runtime is frozen for this ${frozenScope}`,
        ...(envelope.goalId ? { goalId: envelope.goalId } : {}),
        ...(envelope.runId ? { runId: envelope.runId } : {}),
      };
    }

    const run = await this.runService.ensureRun({
      ...envelope,
      title: envelope.title ?? `Run ${skillName}`,
      contextMessage: contextMessage ?? envelope.contextMessage,
    });

    // Tool-call boundary: cancellation (and freeze) wins before any new
    // tool call starts (Req 3.5).
    if (await this.runService.isCancelled(run.runId)) {
      return { status: 'denied', message: 'Run was cancelled', ...run };
    }

    // Backpressure: reconciler-origin work yields to real user traffic.
    // The run is deferred (not failed) and retries when load subsides;
    // human-triggered runs are never auto-paused (Req 9.4).
    const loadGuard = getLoadGuard();
    if (loadGuard.shouldPause(envelope.origin)) {
      if (loadGuard.markIncidentOnce(this.siteId)) {
        await new AutonomyService({ db: this.db, siteId: this.siteId, notify: this.notify }).recordIncident({
          agentRole: 'reconciler',
          source: 'load_guard',
          severity: 'low',
          detail: { activationId: loadGuard.backpressure.activationId },
        });
      }
      return {
        status: 'denied',
        message: 'Deferred by backpressure: runtime under load; retry when load subsides',
        ...run,
      };
    }
    const startedAt = Date.now();
    const maxToolCalls = typeof envelope.budget?.['maxToolCalls'] === 'number'
      ? envelope.budget['maxToolCalls']
      : undefined;
    if (maxToolCalls !== undefined) {
      const existingCalls = await this.runService.countToolCalls(run.runId);
      if (existingCalls >= maxToolCalls) {
        const message = `Run budget exceeded: maxToolCalls=${maxToolCalls}`;
        await this.runService.failRun(run.runId, message, {
          stopReason: 'max_tool_calls',
          maxToolCalls,
          existingCalls,
        });
        return { status: 'denied', message, ...run };
      }
    }

    // Step 1: Validate skill exists
    const tool = await this.toolRegistry.getTool(skillName);
    const toolCallId = await this.runService.appendToolCall({
      runId: run.runId,
      toolName: skillName,
      input: args,
      status: 'running',
    });

    if (!tool) {
      const message = `Unknown skill: ${skillName}`;
      await this.runService.finishToolCall(toolCallId, {
        status: 'denied',
        error: message,
        latencyMs: Date.now() - startedAt,
      });
      await this.runService.failRun(run.runId, message);
      return { status: 'denied', message, ...run, toolCallId };
    }

    // Step 2: Check capabilities. A role-attributed run is narrowed to
    // role ∩ grant first (Module C, Req 10.4): the role can never exceed
    // the caller's token, and the token can never exceed the role.
    let effectiveCapabilities = userCapabilities;
    if (envelope.agentRole) {
      const { AgentRoleService } = await import('./agent-role-service');
      effectiveCapabilities = await new AgentRoleService({
        db: this.db,
        siteId: this.siteId,
      }).effectiveCapabilities(envelope.agentRole, userCapabilities);
    }
    if (!this.checkCapabilities(tool, effectiveCapabilities)) {
      const message = 'Insufficient capabilities';
      await this.runService.finishToolCall(toolCallId, {
        status: 'denied',
        error: message,
        latencyMs: Date.now() - startedAt,
      });
      await this.runService.failRun(run.runId, message);
      return { status: 'denied', message, ...run, toolCallId };
    }

    const policy = await this.toolRegistry.evaluatePolicy(tool, run.runId);
    if (!policy.allowed) {
      const message = policy.message ?? 'Tool denied by policy';
      await this.runService.finishToolCall(toolCallId, {
        status: 'denied',
        error: message,
        latencyMs: Date.now() - startedAt,
      });
      await this.runService.failRun(run.runId, message);
      return { status: 'denied', message, ...run, toolCallId };
    }

    // Write rate budget (Req 9.3): per-intent maxWritesPerMinute defers
    // write-capable tool calls at the boundary. The run is NOT failed —
    // it resumes when quota returns to the sliding window.
    const writeLimit = Number((envelope.budget ?? {})['maxWritesPerMinute'] ?? 0);
    if (writeLimit > 0 && isWriteSkill(tool)) {
      const scopeKey = `${this.siteId}:${envelope.intentId ?? run.goalId}`;
      const budgetCheck = loadGuard.tryConsumeWrite(scopeKey, writeLimit);
      if (!budgetCheck.allowed) {
        const message = `write_budget_exceeded: retry in ${Math.ceil(budgetCheck.retryAfterMs / 1000)}s`;
        await this.runService.finishToolCall(toolCallId, {
          status: 'denied',
          error: message,
          latencyMs: Date.now() - startedAt,
        });
        return { status: 'denied', message, ...run, toolCallId };
      }
    }

    // Step 3: Evaluate risk
    const isDangerous = this.evaluateRisk(tool, skillName) || policy.risk === 'dangerous' || policy.risk === 'review_required';

    if (isDangerous) {
      // Trust gradient (L0-L4): the effective level decides whether the
      // dangerous action awaits approval (≤L2), stages into the veto
      // window (L3) or executes directly (L4). Irreversible skills never
      // resolve above L2 via the resolver's hard ceiling.
      const autonomy = new AutonomyService({ db: this.db, siteId: this.siteId, notify: this.notify });
      const agentRole = envelope.agentName ?? run.agentName;
      const capability = primaryDangerousCapability(tool, skillName);
      const level = await autonomy.resolve(agentRole, capability, {
        dangerous: true,
        intentCap: envelope.autonomyCap ?? null,
        irreversible: IRREVERSIBLE_SKILLS.has(skillName),
      });

      // L3 veto window: stageable item writes execute into staging and
      // auto-commit at the deadline unless a human vetoes (Req 13.1).
      // Gated by contentOs.vetoWindow (task 20.1): with the flag off, L3
      // falls through to classic pre-execute HITL — pre-Content-OS
      // behaviour exactly.
      const vetoWindowEnabled =
        level === AUTONOMY_LEVELS.VETO_WINDOW &&
        (await import('./feature-flags')
          .then(({ getContentOsFlags }) => getContentOsFlags(this.db, this.siteId))
          .then((flags) => flags.vetoWindow)
          .catch(() => false));
      if (vetoWindowEnabled && isStageableItemPatch(skillName, args)) {
        const vetoWindowMs = Number((envelope.budget ?? {})['vetoWindowMs']) || undefined;
        const veto = new VetoService({ db: this.db, siteId: this.siteId, vetoWindowMs, notify: this.notify });
        // Pin the active constitution to the run before staging (Req 15.3,
        // Property 12): the staged revision carries the hash the run
        // started with, even if a new version activates before commit.
        let constitutionHash: string | null = null;
        try {
          const { ConstitutionService } = await import('./constitution-service');
          constitutionHash = await new ConstitutionService({ db: this.db, siteId: this.siteId }).pinToRun(
            run.runId,
          );
        } catch {
          constitutionHash = null;
        }
        try {
          const staged = await veto.stageItemPatch({
            runId: run.runId,
            agentRole,
            capability,
            collection: String(args['collection']),
            itemId: String(args['id']),
            patch: args['data'] as Record<string, unknown>,
            ...(constitutionHash ? { provenance: { constitutionHash } } : {}),
          });
          await this.runService.finishToolCall(toolCallId, {
            status: 'pending_approval',
            output: {
              staged: true,
              vetoApprovalId: staged.approvalId,
              revisionId: staged.revisionId,
              autoCommitAt: staged.autoCommitAt.toISOString(),
              reviewPath: staged.reviewPath,
            },
            approvalId: staged.approvalId,
            latencyMs: Date.now() - startedAt,
          });
          await this.runService.closeRun(run.runId, {
            toolCalls: 1,
            stopReason: 'staged_veto_window',
            vetoApprovalId: staged.approvalId,
          });
          await veto.scheduleCommit(staged, this.queue);
          agentAutonomousOpsTotal.inc({ level: 'L3' });
          return {
            status: 'pending_approval',
            approvalId: staged.approvalId,
            agentApprovalId: staged.approvalId,
            message: `Staged; auto-commits at ${staged.autoCommitAt.toISOString()} unless vetoed`,
            ...run,
            toolCallId,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await this.runService.finishToolCall(toolCallId, {
            status: 'failed',
            error: message,
            latencyMs: Date.now() - startedAt,
          });
          await this.runService.failRun(run.runId, message);
          return { status: 'denied', message, ...run, toolCallId };
        }
      }

      // L4 autopilot: execute directly within capability and budget.
      if (level >= AUTONOMY_LEVELS.AUTOPILOT) {
        agentAutonomousOpsTotal.inc({ level: 'L4' });
        const result = await this.runSkill(skillName, args, { runId: run.runId });
        if (result.success) {
          await this.runService.finishToolCall(toolCallId, {
            status: 'executed',
            output: result.data,
            latencyMs: Date.now() - startedAt,
          });
          await this.runService.closeRun(run.runId, {
            toolCalls: 1,
            lastToolLatencyMs: Date.now() - startedAt,
            autonomyLevel: level,
            ...extractLLMMeta(result.data),
          });
          return { status: 'executed', data: result.data, ...run, toolCallId };
        }
        await this.runService.finishToolCall(toolCallId, {
          status: 'failed',
          error: result.error,
          latencyMs: Date.now() - startedAt,
        });
        await this.runService.failRun(run.runId, result.error, { toolCalls: 1 });
        return { status: 'denied', message: result.error, ...run, toolCallId };
      }

      // ≤L2 (or L3 without a stageable patch): classic pre-execute HITL.
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

      const [agentApproval] = await this.db
        .insert(agentApprovals)
        .values({
          runId: run.runId,
          siteId: this.siteId,
          legacyApprovalId: record!.id,
          subjectType: 'tool_call',
          subjectId: toolCallId,
          status: 'pending',
          approvalPolicy: policy.approvalPolicy,
          requestedByAgent: run.agentName,
        })
        .returning();

      this.notify?.({
        kind: 'approval',
        severity: 'info',
        title: 'Approval requested',
        body: `${run.agentName} requests approval to run "${skillName}"`,
        deepLink: `/mission-control/inbox?entry=approval:${agentApproval!.id}`,
        entityId: agentApproval!.id,
      });

      await this.runService.finishToolCall(toolCallId, {
        status: 'pending_approval',
        output: { approvalId: record!.id, agentApprovalId: agentApproval!.id },
        approvalId: agentApproval!.id,
        latencyMs: Date.now() - startedAt,
      });

      // Park the run while the approval is pending; the approval decision
      // resumes it without re-running completed tool calls (Req 3.1/3.4).
      await this.runService.awaitApproval(run.runId);

      return {
        status: 'pending_approval',
        approvalId: record!.id,
        agentApprovalId: agentApproval!.id,
        ...run,
        toolCallId,
      };
    }

    // Step 4: Safe skill — execute directly
    const result = await this.runSkill(skillName, args, { runId: run.runId });
    if (result.success) {
      await this.runService.finishToolCall(toolCallId, {
        status: 'executed',
        output: result.data,
        latencyMs: Date.now() - startedAt,
      });
      await this.runService.closeRun(run.runId, {
        toolCalls: 1,
        lastToolLatencyMs: Date.now() - startedAt,
        ...extractLLMMeta(result.data),
      });
      return { status: 'executed', data: result.data, ...run, toolCallId };
    }
    await this.runService.finishToolCall(toolCallId, {
      status: 'failed',
      error: result.error,
      latencyMs: Date.now() - startedAt,
    });
    await this.runService.failRun(run.runId, result.error, { toolCalls: 1 });
    return { status: 'denied', message: result.error, ...run, toolCallId };
  }

  private async executeLegacy(
    skillName: string,
    args: Record<string, unknown>,
    userCapabilities: string[],
    contextMessage?: string,
  ): Promise<HarnessExecutionResult> {
    const skill = this.validateSkill(skillName);
    if (!skill) {
      return { status: 'denied', message: `Unknown skill: ${skillName}` };
    }

    if (!this.checkCapabilities(skill, userCapabilities)) {
      return { status: 'denied', message: 'Insufficient capabilities' };
    }

    const isDangerous = this.evaluateRisk(skill, skillName);
    if (isDangerous) {
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

    const result = await this.runSkill(skillName, args);
    return result.success
      ? { status: 'executed', data: result.data }
      : { status: 'denied', message: result.error };
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
    runContext?: { runId?: string; model?: string },
  ): Promise<{ success: true; data: unknown } | { success: false; error: string }> {
    if (!Object.hasOwn(this.skills, skillName)) {
      return { success: false, error: `Skill not found: ${skillName}` };
    }
    const skill = this.skills[skillName]!;

    // Item writes performed by skills are agent-authored: stamp revision
    // provenance with the executing run before the handler touches data.
    this.itemService?.setProvenance({
      authorType: 'agent',
      runId: runContext?.runId ?? null,
      model: runContext?.model ?? null,
    });
    // Coalescing window: N writes to one collection inside this handler
    // flush exactly one invalidation at the boundary (Load Guard, Req 9.1).
    this.itemService?.beginWriteCoalescing();

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
    } finally {
      // Tool-call boundary: writes that happened (even on failure) flush
      // their deferred invalidations exactly once per collection (Req 9.1).
      await this.itemService?.flushCoalescedWrites().catch(() => {});
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
    userCapabilities: string[],
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

    const skill = this.validateSkill(record.skillName);
    if (!skill) {
      return { status: 'denied', message: `Unknown skill: ${record.skillName}` };
    }

    if (!this.checkCapabilities(skill, userCapabilities)) {
      return { status: 'denied', message: 'Insufficient capabilities' };
    }

    // Execute the stored skill
    if (this.agentHarnessEnabled) {
      return this.executeApprovedWithAudit(record, userId);
    }

    const result = await this.runSkill(
      record.skillName,
      record.arguments as Record<string, unknown>,
    );

    if (result.success) {
      // Skill succeeded — commit the decision. The UPDATE is guarded by
      // `status = 'pending'` and uses .returning() so that if a concurrent
      // decide/reject already moved the record out of 'pending' (CWE-362/367
      // TOCTOU), this write affects zero rows and we report a conflict instead
      // of silently overwriting the other decision.
      const committed = await this.db
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
            eq(aiApprovals.status, 'pending'),
          ),
        )
        .returning({ id: aiApprovals.id });

      if (committed.length === 0) {
        return {
          status: 'denied',
          message: 'Approval was already processed by another request',
        };
      }

      return { status: 'executed', data: result.data };
    }

    // Skill failed — keep record as 'pending' so admin can retry
    return { status: 'denied', message: result.error };
  }

  private async executeApprovedWithAudit(
    record: typeof aiApprovals.$inferSelect,
    userId: string,
  ): Promise<HarnessExecutionResult> {
    const [existingAgentApproval] = await this.db
      .select()
      .from(agentApprovals)
      .where(
        and(
          eq(agentApprovals.legacyApprovalId, record.id),
          eq(agentApprovals.siteId, this.siteId),
        ),
      )
      .limit(1);

    const run = existingAgentApproval
      ? { goalId: '', runId: existingAgentApproval.runId, agentName: existingAgentApproval.requestedByAgent }
      : await this.runService.ensureRun({
        agentName: record.agentName,
        title: `Approved ${record.skillName}`,
        contextMessage: record.context ?? undefined,
      });
    if (existingAgentApproval) {
      if (existingAgentApproval.expiresAt && existingAgentApproval.expiresAt <= new Date()) {
        return { status: 'denied', message: 'Approval expired', runId: run.runId };
      }

      // CLAIM the decision atomically before doing any work (#453).
      //
      // Reading `status === 'pending'` and then acting on it is a
      // read-then-act window: two decisions (two humans, two agent reviewers,
      // or one of each) both observe `pending` and both execute, so the side
      // effect happens twice. The conditional UPDATE below is the
      // serialization point — the database decides the winner, and exactly one
      // caller sees a row come back.
      //
      // `deciding` is deliberately not a terminal status: if this process dies
      // mid-execution the row is visibly stuck rather than silently recorded as
      // approved. `releaseClaim` below returns it to `pending` on every path
      // that does not complete.
      const claimed = await this.db
        .update(agentApprovals)
        .set({
          status: 'deciding',
          decidedBy: userId,
          // Stamped at CLAIM time, not just at decision time: it is what tells
          // the sweeper how long a `deciding` row has been held, and there is
          // no `updatedAt` on this table to infer it from. Overwritten with the
          // real decision timestamp on the success path, and cleared again by
          // `releaseClaim` so a released row does not look decided.
          decidedAt: new Date(),
        })
        .where(
          and(
            eq(agentApprovals.id, existingAgentApproval.id),
            eq(agentApprovals.siteId, this.siteId),
            eq(agentApprovals.status, 'pending'),
          ),
        )
        .returning({ id: agentApprovals.id });

      if (claimed.length === 0) {
        return { status: 'denied', message: 'Approval not found or already processed', runId: run.runId };
      }

      // Cancellation wins over a late approval (Req 3.5). Checked after the
      // claim so the row is released rather than left in `deciding`.
      if (await this.runService.isCancelled(run.runId)) {
        await this.releaseClaim(existingAgentApproval.id);
        return { status: 'denied', message: 'Run was cancelled', runId: run.runId };
      }
      // Resume the parked run; only the approved tool call executes —
      // previously completed tool calls are never re-run (Req 3.4).
      await this.runService.markRunning(run.runId);
    }

    // Kill switch wins over approvals: a frozen site/role denies the
    // approved execution at this boundary (Req 14.2).
    const approvalKillSwitch = new KillSwitchService({ db: this.db, siteId: this.siteId });
    const approvalFrozenScope = await approvalKillSwitch.frozenScopeFor(record.agentName);
    if (approvalFrozenScope) {
      if (existingAgentApproval) await this.releaseClaim(existingAgentApproval.id);
      return {
        status: 'denied',
        message: `frozen: agent runtime is frozen for this ${approvalFrozenScope}`,
        runId: run.runId,
      };
    }
    const startedAt = Date.now();
    const toolCallId = await this.runService.appendToolCall({
      runId: run.runId,
      toolName: record.skillName,
      input: record.arguments as Record<string, unknown>,
      status: 'running',
      approvalId: existingAgentApproval?.id ?? null,
    });

    let result;
    try {
      result = await this.runSkill(
        record.skillName,
        record.arguments as Record<string, unknown>,
        { runId: run.runId },
      );
    } catch (err) {
      // A throwing skill must not strand the claim in `deciding`, where the
      // approval disappears from the operator's pending inbox.
      if (existingAgentApproval) await this.releaseClaim(existingAgentApproval.id);
      const message = err instanceof Error ? err.message : String(err);
      await this.runService.finishToolCall(toolCallId, {
        status: 'failed',
        error: message,
        approvalId: existingAgentApproval?.id ?? null,
        latencyMs: Date.now() - startedAt,
      });
      await this.runService.failRun(run.runId, message);
      return { status: 'denied', message, runId: run.runId, toolCallId };
    }

    if (result.success) {
      // Commit the legacy record, guarded on `pending` so a concurrent
      // decide/reject is not silently overwritten (CWE-362/367). The result is
      // CHECKED: previously it was discarded, so a losing race still reported
      // `executed` and the two records could disagree about what happened.
      const legacyCommitted = await this.db
        .update(aiApprovals)
        .set({
          status: 'approved',
          decidedAt: new Date(),
          decidedBy: userId,
        })
        .where(
          and(
            eq(aiApprovals.id, record.id),
            eq(aiApprovals.siteId, this.siteId),
            eq(aiApprovals.status, 'pending'),
          ),
        )
        .returning({ id: aiApprovals.id });

      if (legacyCommitted.length === 0) {
        // Another decision (e.g. a reject) took the legacy record while this
        // skill was running. The side effect already happened and cannot be
        // undone here, so report it rather than claiming success: the tool call
        // and run record it, and the claim is released so the mismatch is
        // visible instead of being papered over with a false `approved`.
        if (existingAgentApproval) await this.releaseClaim(existingAgentApproval.id);
        await this.runService.finishToolCall(toolCallId, {
          status: 'executed',
          output: result.data,
          approvalId: existingAgentApproval?.id ?? null,
          latencyMs: Date.now() - startedAt,
        });
        await this.runService.failRun(
          run.runId,
          'decision changed while the approved action was executing',
        );
        return {
          status: 'denied',
          message:
            'Approval was decided by another request while the action was executing; the action ran but the decision was not committed',
          runId: run.runId,
          toolCallId,
        };
      }

      if (existingAgentApproval) {
        // Guarded on `deciding`: only the claim holder finalizes, so a decision
        // that arrived through another entrypoint is never clobbered.
        await this.db
          .update(agentApprovals)
          .set({
            status: 'approved',
            decidedAt: new Date(),
            decidedBy: userId,
          })
          .where(
            and(
              eq(agentApprovals.id, existingAgentApproval.id),
              eq(agentApprovals.siteId, this.siteId),
              eq(agentApprovals.status, 'deciding'),
            ),
          );
      }
      await this.runService.finishToolCall(toolCallId, {
        status: 'executed',
        output: result.data,
        approvalId: existingAgentApproval?.id ?? null,
        latencyMs: Date.now() - startedAt,
      });
      await this.runService.closeRun(run.runId, { approvedBy: userId, ...extractLLMMeta(result.data) });
      return {
        status: 'executed',
        data: result.data,
        runId: run.runId,
        toolCallId,
        agentApprovalId: existingAgentApproval?.id,
      };
    }

    // The skill failed: release the claim so the approval is pending again and
    // an operator can retry or reject it.
    if (existingAgentApproval) await this.releaseClaim(existingAgentApproval.id);
    await this.runService.finishToolCall(toolCallId, {
      status: 'failed',
      error: result.error,
      approvalId: existingAgentApproval?.id ?? null,
      latencyMs: Date.now() - startedAt,
    });
    await this.runService.failRun(run.runId, result.error);
    return { status: 'denied', message: result.error, runId: run.runId, toolCallId };
  }

  /**
   * Returns a claimed approval to `pending` so it stays retryable.
   *
   * Guarded on `deciding` so it can only ever undo THIS caller's claim: a
   * decision that landed through another entrypoint in the meantime is left
   * alone.
   */
  private async releaseClaim(agentApprovalId: string): Promise<void> {
    await this.db
      .update(agentApprovals)
      .set({ status: 'pending', decidedBy: null, decidedAt: null })
      .where(
        and(
          eq(agentApprovals.id, agentApprovalId),
          eq(agentApprovals.siteId, this.siteId),
          eq(agentApprovals.status, 'deciding'),
        ),
      );
  }

  /**
   * Rejects an approval record.
   * Updates the status to 'rejected' and records who rejected it and when.
   */
  async rejectApproval(
    approvalId: string,
    userId: string,
  ): Promise<boolean> {
    // A reject races the same decision boundary an approve does, so it has to
    // contend for the SAME row first (#453).
    //
    // Previously this took the legacy record first and only then tried
    // `agent_approvals` guarded on `pending`. Against a concurrent approve —
    // which has by then claimed that row as `deciding` — the second update
    // matched nothing and the two records were left disagreeing: legacy
    // `rejected`, agent `pending`. Real-PostgreSQL concurrency showed this;
    // the fake-DB suites did not.
    //
    // Claiming `agent_approvals` first makes the two decisions contend for one
    // row, so exactly one of them proceeds.
    if (this.agentHarnessEnabled) {
      const claimedForReject = await this.db
        .update(agentApprovals)
        .set({
          status: 'rejected',
          decidedAt: new Date(),
          decidedBy: userId,
        })
        .where(
          and(
            eq(agentApprovals.legacyApprovalId, approvalId),
            eq(agentApprovals.siteId, this.siteId),
            eq(agentApprovals.status, 'pending'),
          ),
        )
        .returning({ id: agentApprovals.id });

      // No linked agent approval at all is fine — a legacy-only record still
      // rejects below. A linked row that is no longer `pending` means another
      // decision owns it, so this reject loses and must not touch the legacy
      // record either.
      if (claimedForReject.length === 0) {
        const [linked] = await this.db
          .select({ id: agentApprovals.id })
          .from(agentApprovals)
          .where(
            and(
              eq(agentApprovals.legacyApprovalId, approvalId),
              eq(agentApprovals.siteId, this.siteId),
            ),
          )
          .limit(1);
        if (linked) return false;
      }
    }

    // Only a still-pending approval can be rejected; the status guard makes the
    // reject atomic w.r.t. a concurrent approve (CWE-362/367). Returns whether
    // this call actually performed the rejection.
    const rejected = await this.db
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
          eq(aiApprovals.status, 'pending'),
        ),
      )
      .returning({ id: aiApprovals.id });

    return rejected.length > 0;
  }
}
