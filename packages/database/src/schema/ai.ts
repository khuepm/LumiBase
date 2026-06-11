import { boolean, index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { sites, users } from './core';

/**
 * AI-First CMS Engine tables. Stores approval records for the
 * Human-in-the-Loop (HITL) system that gates dangerous AI actions.
 */

const id = () => text('id').$defaultFn(() => nanoid()).primaryKey();
const createdAt = () => timestamp('created_at').defaultNow().notNull();
const updatedAt = () => timestamp('updated_at').defaultNow().notNull();

export const aiApprovals = pgTable(
  'ai_approvals',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    agentName: text('agent_name').default('lumibase-copilot').notNull(),
    skillName: text('skill_name').notNull(),
    arguments: jsonb('arguments').default({}).notNull(),
    status: text('status').default('pending').notNull(),
    context: text('context'),
    createdAt: createdAt(),
    decidedAt: timestamp('decided_at'),
    decidedBy: text('decided_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => ({
    siteStatusIdx: index('ai_approvals_site_status_idx').on(t.siteId, t.status),
  }),
);

// ---------------------------------------------------------------------------
// POST-GA Task #2 — Context Memory (conversation history)
// ---------------------------------------------------------------------------

/**
 * AI conversations — groups messages into threads.
 */
export const aiConversations = pgTable(
  'ai_conversations',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    title: text('title').default('New conversation').notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    siteUserIdx: index('ai_conversations_site_user_idx').on(t.siteId, t.userId),
  }),
);

/**
 * AI messages — individual messages within a conversation.
 */
export const aiMessages = pgTable(
  'ai_messages',
  {
    id: id(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => aiConversations.id, { onDelete: 'cascade' }),
    /** `user` | `assistant` | `system` */
    role: text('role').notNull(),
    content: text('content').notNull(),
    /** Tool calls made in this message (assistant messages only). */
    toolCalls: jsonb('tool_calls').default([]).notNull(),
    /** Execution result metadata (status, approvalId). */
    metadata: jsonb('metadata').default({}).notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    conversationIdx: index('ai_messages_conversation_idx').on(t.conversationId, t.createdAt),
  }),
);

// ---------------------------------------------------------------------------
// POST-GA Task #3 — AI Embeddings for RAG
// ---------------------------------------------------------------------------

/**
 * Vector embeddings for items content — used by aiSuggestField and
 * aiContentAssist skills to find relevant context via similarity search.
 *
 * Note: When pgvector is available, consider migrating `embedding` from
 * JSONB to `vector(1536)` for efficient ANN search. For now, JSONB arrays
 * work with brute-force cosine similarity for moderate dataset sizes.
 */
export const aiEmbeddings = pgTable(
  'ai_embeddings',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** Source collection name. */
    collection: text('collection').notNull(),
    /** Source item id. */
    itemId: text('item_id'),
    /** Which field this chunk came from. */
    fieldName: text('field_name'),
    /** The text chunk that was embedded. */
    chunkText: text('chunk_text').notNull(),
    /** Embedding vector stored as JSON array of numbers. */
    embedding: jsonb('embedding').notNull(),
    /** Embedding model used (e.g. 'text-embedding-3-small'). */
    model: text('model').default('text-embedding-3-small').notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    siteCollectionIdx: index('ai_embeddings_site_collection_idx').on(t.siteId, t.collection),
    itemIdx: index('ai_embeddings_item_idx').on(t.itemId),
  }),
);

// ---------------------------------------------------------------------------
// Agent Harness Layer
// ---------------------------------------------------------------------------

export const agentGoals = pgTable(
  'agent_goals',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    source: text('source').default('user').notNull(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    assigneeAgent: text('assignee_agent').default('lumibase-copilot').notNull(),
    priority: text('priority').default('normal').notNull(),
    deadline: timestamp('deadline'),
    status: text('status').default('open').notNull(),
    successCriteria: jsonb('success_criteria').default({}).notNull(),
    metadata: jsonb('metadata').default({}).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    siteStatusIdx: index('agent_goals_site_status_idx').on(t.siteId, t.status),
    siteCreatedIdx: index('agent_goals_site_created_idx').on(t.siteId, t.createdAt),
  }),
);

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: id(),
    goalId: text('goal_id')
      .notNull()
      .references(() => agentGoals.id, { onDelete: 'cascade' }),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    agentName: text('agent_name').default('lumibase-copilot').notNull(),
    provider: text('provider').default('local').notNull(),
    model: text('model').default('tool-registry').notNull(),
    status: text('status').default('running').notNull(),
    budget: jsonb('budget').default({}).notNull(),
    policySnapshotHash: text('policy_snapshot_hash'),
    risk: text('risk').default('safe').notNull(),
    metrics: jsonb('metrics').default({}).notNull(),
    error: text('error'),
    retryOfRunId: text('retry_of_run_id'),
    startedAt: timestamp('started_at').defaultNow().notNull(),
    finishedAt: timestamp('finished_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    siteStatusIdx: index('agent_runs_site_status_idx').on(t.siteId, t.status),
    goalCreatedIdx: index('agent_runs_goal_created_idx').on(t.goalId, t.createdAt),
  }),
);

export const agentPlans = pgTable(
  'agent_plans',
  {
    id: id(),
    runId: text('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    steps: jsonb('steps').default([]).notNull(),
    status: text('status').default('draft').notNull(),
    risk: text('risk').default('safe').notNull(),
    approvalPolicy: text('approval_policy').default('none').notNull(),
    approvedAt: timestamp('approved_at'),
    approvedBy: text('approved_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    runCreatedIdx: index('agent_plans_run_created_idx').on(t.runId, t.createdAt),
    siteStatusIdx: index('agent_plans_site_status_idx').on(t.siteId, t.status),
  }),
);

export const agentTools = pgTable(
  'agent_tools',
  {
    id: id(),
    siteId: text('site_id').references(() => sites.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').default('').notNull(),
    inputSchema: jsonb('input_schema').default({}).notNull(),
    outputSchema: jsonb('output_schema').default({}).notNull(),
    requiredCapabilities: jsonb('required_capabilities').default([]).notNull(),
    riskPolicy: jsonb('risk_policy').default({ level: 'safe' }).notNull(),
    rateLimit: jsonb('rate_limit').default({}).notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    owner: text('owner').default('core').notNull(),
    extensionId: text('extension_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    siteNameIdx: index('agent_tools_site_name_idx').on(t.siteId, t.name),
    siteEnabledIdx: index('agent_tools_site_enabled_idx').on(t.siteId, t.enabled),
  }),
);

export const agentPermissions = pgTable(
  'agent_permissions',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    agentName: text('agent_name').notNull(),
    principalType: text('principal_type').default('agent').notNull(),
    principalId: text('principal_id'),
    policyId: text('policy_id'),
    capabilities: jsonb('capabilities').default([]).notNull(),
    environment: text('environment').default('all').notNull(),
    validFrom: timestamp('valid_from').defaultNow().notNull(),
    validUntil: timestamp('valid_until'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    siteAgentIdx: index('agent_permissions_site_agent_idx').on(t.siteId, t.agentName),
    sitePrincipalIdx: index('agent_permissions_site_principal_idx').on(t.siteId, t.principalType, t.principalId),
  }),
);

export const agentToolCalls = pgTable(
  'agent_tool_calls',
  {
    id: id(),
    runId: text('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    toolName: text('tool_name').notNull(),
    input: jsonb('input').default({}).notNull(),
    output: jsonb('output').default({}).notNull(),
    error: text('error'),
    status: text('status').default('pending').notNull(),
    risk: text('risk').default('safe').notNull(),
    approvalId: text('approval_id'),
    latencyMs: integer('latency_ms'),
    cost: jsonb('cost').default({}).notNull(),
    createdAt: createdAt(),
    finishedAt: timestamp('finished_at'),
  },
  (t) => ({
    runCreatedIdx: index('agent_tool_calls_run_created_idx').on(t.runId, t.createdAt),
    siteStatusIdx: index('agent_tool_calls_site_status_idx').on(t.siteId, t.status),
    siteToolIdx: index('agent_tool_calls_site_tool_idx').on(t.siteId, t.toolName),
  }),
);

export const agentApprovals = pgTable(
  'agent_approvals',
  {
    id: id(),
    runId: text('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    legacyApprovalId: text('legacy_approval_id').references(() => aiApprovals.id, { onDelete: 'set null' }),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    status: text('status').default('pending').notNull(),
    approvalPolicy: text('approval_policy').default('before_execute').notNull(),
    /** `approval` (pre-execute HITL) | `veto` (L3 post-veto window). */
    kind: text('kind').default('approval').notNull(),
    /** Veto window deadline: staged work auto-commits here unless vetoed. */
    autoCommitAt: timestamp('auto_commit_at'),
    requestedByAgent: text('requested_by_agent').default('lumibase-copilot').notNull(),
    decidedBy: text('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decisionReason: text('decision_reason'),
    expiresAt: timestamp('expires_at'),
    createdAt: createdAt(),
    decidedAt: timestamp('decided_at'),
  },
  (t) => ({
    siteStatusIdx: index('agent_approvals_site_status_idx').on(t.siteId, t.status),
    runCreatedIdx: index('agent_approvals_run_created_idx').on(t.runId, t.createdAt),
    subjectIdx: index('agent_approvals_subject_idx').on(t.subjectType, t.subjectId),
  }),
);

export const agentArtifacts = pgTable(
  'agent_artifacts',
  {
    id: id(),
    runId: text('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    target: text('target'),
    title: text('title').notNull(),
    contentRef: text('content_ref'),
    content: jsonb('content').default({}).notNull(),
    hash: text('hash').notNull(),
    version: integer('version').default(1).notNull(),
    status: text('status').default('draft').notNull(),
    metadata: jsonb('metadata').default({}).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    siteStatusIdx: index('agent_artifacts_site_status_idx').on(t.siteId, t.status),
    runCreatedIdx: index('agent_artifacts_run_created_idx').on(t.runId, t.createdAt),
    hashIdx: index('agent_artifacts_hash_idx').on(t.hash),
  }),
);

export const agentEvaluations = pgTable(
  'agent_evaluations',
  {
    id: id(),
    runId: text('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    artifactId: text('artifact_id').references(() => agentArtifacts.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    status: text('status').notNull(),
    score: integer('score'),
    summary: text('summary').notNull(),
    details: jsonb('details').default({}).notNull(),
    artifactHash: text('artifact_hash'),
    createdAt: createdAt(),
  },
  (t) => ({
    siteStatusIdx: index('agent_evaluations_site_status_idx').on(t.siteId, t.status),
    artifactIdx: index('agent_evaluations_artifact_idx').on(t.artifactId, t.createdAt),
    runCreatedIdx: index('agent_evaluations_run_created_idx').on(t.runId, t.createdAt),
  }),
);

export const agentMemory = pgTable(
  'agent_memory',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    scopeId: text('scope_id'),
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id'),
    content: text('content').notNull(),
    embedding: jsonb('embedding'),
    confidence: integer('confidence').default(100).notNull(),
    metadata: jsonb('metadata').default({}).notNull(),
    expiresAt: timestamp('expires_at'),
    createdAt: createdAt(),
  },
  (t) => ({
    siteScopeIdx: index('agent_memory_site_scope_idx').on(t.siteId, t.scope, t.scopeId),
    siteSourceIdx: index('agent_memory_site_source_idx').on(t.siteId, t.sourceType, t.sourceId),
  }),
);
