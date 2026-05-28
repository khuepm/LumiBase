import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { sites, users } from './core';

/**
 * AI-First CMS Engine tables. Stores approval records for the
 * Human-in-the-Loop (HITL) system that gates dangerous AI actions.
 */

const id = () => text('id').$defaultFn(() => nanoid()).primaryKey();
const createdAt = () => timestamp('created_at').defaultNow().notNull();

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
