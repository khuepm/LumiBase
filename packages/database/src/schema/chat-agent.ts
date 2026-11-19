import { boolean, index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { sites, users } from './core';

/**
 * Chat agent (#711): the Content Agent reached from a chat tool.
 *
 * A site installs a chat integration — Slack, or a generic signed webhook that
 * a Teams / Discord / custom bot can call — and links chat users to LumiBase
 * users. A message from a linked chat user runs one governed Copilot turn AS
 * that user (their capabilities, their approvals); nothing a chat message does
 * can exceed what the linked user could do in Studio. Approvals are answered
 * from the chat by a linked user who may decide them.
 *
 * Conventions: nanoid ids, `site_id` on every table, secrets encrypted with
 * the site-bound CryptoService (AAD `{ siteId, collection, field, recordId }`),
 * never stored or returned in plaintext after creation.
 */

const id = () => text('id').$defaultFn(() => nanoid()).primaryKey();
const createdAt = () => timestamp('created_at').defaultNow().notNull();
const updatedAt = () => timestamp('updated_at').defaultNow().notNull();

/** One installed chat integration of a site. */
export const chatIntegrations = pgTable(
  'lumibase_chat_integrations',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** `slack` | `webhook`. */
    provider: text('provider').notNull(),
    name: text('name').notNull(),
    /**
     * Slack: the workspace (`team_id`) the app is installed in; an event from
     * any other workspace is refused. Webhook: null.
     */
    externalId: text('external_id'),
    /** Encrypted request-signing secret (Slack signing secret / webhook HMAC key). */
    signingSecretEnc: text('signing_secret_enc').notNull(),
    /** Encrypted Slack bot token (`xoxb-…`) used to post replies. Null for webhooks. */
    botTokenEnc: text('bot_token_enc'),
    enabled: boolean('enabled').default(true).notNull(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    siteIdx: index('chat_integrations_site_idx').on(t.siteId, t.provider),
  }),
);

/** A chat user linked to a LumiBase user of the same site. */
export const chatUserLinks = pgTable(
  'lumibase_chat_user_links',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    integrationId: text('integration_id')
      .notNull()
      .references(() => chatIntegrations.id, { onDelete: 'cascade' }),
    /** Slack user id (`U…`) or the webhook caller's user id. */
    externalUserId: text('external_user_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => ({
    externalUnique: uniqueIndex('chat_user_links_external_unique').on(t.integrationId, t.externalUserId),
    siteUserIdx: index('chat_user_links_site_user_idx').on(t.siteId, t.userId),
  }),
);

/**
 * Inbound chat events, kept for idempotency (Slack retries a delivery it did
 * not see acknowledged in 3 s) and to map a chat thread to its Copilot
 * conversation. One row per delivered event; a duplicate `event_key` is a
 * retry and does nothing.
 */
export const chatEvents = pgTable(
  'lumibase_chat_events',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    integrationId: text('integration_id')
      .notNull()
      .references(() => chatIntegrations.id, { onDelete: 'cascade' }),
    /** Provider event id (Slack `event_id`, `trigger_id`; webhook `X-Lumibase-Delivery`). */
    eventKey: text('event_key').notNull(),
    /** Chat thread the event belongs to (`<channel>:<thread_ts>` for Slack). */
    threadKey: text('thread_key'),
    externalUserId: text('external_user_id'),
    /** Copilot conversation the turn ran in (`lumibase_ai_conversations.id`). */
    conversationId: text('conversation_id'),
    /** `received` | `done` | `failed` | `unlinked`. */
    status: text('status').default('received').notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    eventUnique: uniqueIndex('chat_events_event_unique').on(t.integrationId, t.eventKey),
    threadIdx: index('chat_events_thread_idx').on(t.integrationId, t.threadKey, t.externalUserId),
  }),
);
