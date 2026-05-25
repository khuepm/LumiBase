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
