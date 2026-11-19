import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import {
  chatEvents,
  chatIntegrations,
  chatUserLinks,
  userSites,
  type Database,
} from '@lumibase/database';
import { CryptoService } from '../../services/crypto-service';
import { generateSigningSecret } from './signatures';

/**
 * Chat integrations of one site (#711): install, secrets, user links and the
 * inbound-event ledger. Every query is filtered by `siteId`.
 *
 * Secrets are encrypted with the site-bound CryptoService (AAD
 * `{ siteId, collection: 'chat_integrations', field, recordId }`), so a
 * ciphertext copied to another site or another row does not decrypt. They are
 * never returned by a read; the generated webhook secret is returned once, in
 * the create response.
 */

export const CHAT_PROVIDERS = ['slack', 'webhook'] as const;
export type ChatProvider = (typeof CHAT_PROVIDERS)[number];

export type ChatIntegrationRow = typeof chatIntegrations.$inferSelect;

/** What a read returns: no ciphertext, only whether each secret is set. */
export interface ChatIntegrationView {
  id: string;
  provider: ChatProvider;
  name: string;
  externalId: string | null;
  enabled: boolean;
  hasBotToken: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export class ChatAgentError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'VALIDATION' | 'CONFLICT' | 'ENCRYPTION_NOT_CONFIGURED',
    message: string,
    readonly status: 400 | 404 | 409 | 500,
  ) {
    super(message);
    this.name = 'ChatAgentError';
  }
}

const COLLECTION = 'chat_integrations';
type SecretField = 'signing_secret' | 'bot_token';

export function toView(row: ChatIntegrationRow): ChatIntegrationView {
  return {
    id: row.id,
    provider: row.provider as ChatProvider,
    name: row.name,
    externalId: row.externalId,
    enabled: row.enabled,
    hasBotToken: Boolean(row.botTokenEnc),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface CreateIntegrationInput {
  provider: ChatProvider;
  name: string;
  /** Slack workspace id (`T…`); required for Slack. */
  externalId?: string;
  /** Slack: the app's signing secret. Webhook: omit — one is generated. */
  signingSecret?: string;
  /** Slack bot token used to reply. */
  botToken?: string;
}

export interface UpdateIntegrationInput {
  name?: string;
  enabled?: boolean;
  externalId?: string;
  signingSecret?: string;
  /** `null` removes the bot token. */
  botToken?: string | null;
}

export class ChatIntegrationService {
  constructor(
    private readonly deps: { db: Database; siteId: string; encryptionKey: string | undefined; userId?: string | null },
  ) {}

  private crypto(): CryptoService {
    if (!this.deps.encryptionKey) {
      throw new ChatAgentError('ENCRYPTION_NOT_CONFIGURED', 'ENCRYPTION_KEY must be set to use chat integrations.', 500);
    }
    return CryptoService.fromKey(this.deps.encryptionKey);
  }

  private encrypt(value: string, recordId: string, field: SecretField): Promise<string> {
    return this.crypto().encrypt(value, { siteId: this.deps.siteId, collection: COLLECTION, field, recordId });
  }

  async decryptSecret(row: ChatIntegrationRow, field: SecretField): Promise<string | null> {
    const ciphertext = field === 'signing_secret' ? row.signingSecretEnc : row.botTokenEnc;
    if (!ciphertext) return null;
    const value = await this.crypto().decrypt(ciphertext, {
      siteId: this.deps.siteId,
      collection: COLLECTION,
      field,
      recordId: row.id,
    });
    return typeof value === 'string' ? value : null;
  }

  async list(): Promise<ChatIntegrationView[]> {
    const rows = await this.deps.db
      .select()
      .from(chatIntegrations)
      .where(eq(chatIntegrations.siteId, this.deps.siteId))
      .orderBy(desc(chatIntegrations.createdAt));
    return rows.map(toView);
  }

  async getRow(id: string): Promise<ChatIntegrationRow | null> {
    const [row] = await this.deps.db
      .select()
      .from(chatIntegrations)
      .where(and(eq(chatIntegrations.siteId, this.deps.siteId), eq(chatIntegrations.id, id)))
      .limit(1);
    return row ?? null;
  }

  async mustGet(id: string): Promise<ChatIntegrationRow> {
    const row = await this.getRow(id);
    if (!row) throw new ChatAgentError('NOT_FOUND', 'Chat integration not found.', 404);
    return row;
  }

  /** @returns the integration and, for a webhook, the generated secret (shown once). */
  async create(input: CreateIntegrationInput): Promise<{ integration: ChatIntegrationView; signingSecret?: string }> {
    if (input.provider === 'slack' && (!input.externalId || !input.signingSecret)) {
      throw new ChatAgentError('VALIDATION', 'A Slack integration needs externalId (the workspace team id) and signingSecret.', 400);
    }
    if (input.provider === 'webhook' && (input.signingSecret || input.botToken)) {
      throw new ChatAgentError('VALIDATION', 'A webhook integration generates its own secret and has no bot token.', 400);
    }
    this.crypto(); // fail before writing anything when ENCRYPTION_KEY is missing
    const id = nanoid();
    const generated = input.provider === 'webhook' ? generateSigningSecret() : undefined;
    const secret = input.signingSecret ?? generated!;
    const [row] = await this.deps.db
      .insert(chatIntegrations)
      .values({
        id,
        siteId: this.deps.siteId,
        provider: input.provider,
        name: input.name,
        externalId: input.provider === 'slack' ? input.externalId! : null,
        signingSecretEnc: await this.encrypt(secret, id, 'signing_secret'),
        botTokenEnc: input.botToken ? await this.encrypt(input.botToken, id, 'bot_token') : null,
        createdBy: this.deps.userId ?? null,
      })
      .returning();
    return { integration: toView(row!), ...(generated ? { signingSecret: generated } : {}) };
  }

  async update(id: string, input: UpdateIntegrationInput): Promise<ChatIntegrationView> {
    const row = await this.mustGet(id);
    if (row.provider === 'webhook' && (input.botToken || input.externalId)) {
      throw new ChatAgentError('VALIDATION', 'A webhook integration has no bot token or workspace id.', 400);
    }
    const patch: Partial<typeof chatIntegrations.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) patch.name = input.name;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (input.externalId !== undefined) patch.externalId = input.externalId;
    if (input.signingSecret !== undefined) patch.signingSecretEnc = await this.encrypt(input.signingSecret, id, 'signing_secret');
    if (input.botToken !== undefined) patch.botTokenEnc = input.botToken === null ? null : await this.encrypt(input.botToken, id, 'bot_token');
    const [updated] = await this.deps.db
      .update(chatIntegrations)
      .set(patch)
      .where(and(eq(chatIntegrations.siteId, this.deps.siteId), eq(chatIntegrations.id, id)))
      .returning();
    return toView(updated!);
  }

  /** Generates a new webhook secret; the old one stops verifying at once. */
  async rotateWebhookSecret(id: string): Promise<string> {
    const row = await this.mustGet(id);
    if (row.provider !== 'webhook') {
      throw new ChatAgentError('VALIDATION', 'Only a webhook integration rotates its own secret; for Slack, set signingSecret.', 400);
    }
    const secret = generateSigningSecret();
    await this.deps.db
      .update(chatIntegrations)
      .set({ signingSecretEnc: await this.encrypt(secret, id, 'signing_secret'), updatedAt: new Date() })
      .where(and(eq(chatIntegrations.siteId, this.deps.siteId), eq(chatIntegrations.id, id)));
    return secret;
  }

  async remove(id: string): Promise<void> {
    await this.mustGet(id);
    await this.deps.db
      .delete(chatIntegrations)
      .where(and(eq(chatIntegrations.siteId, this.deps.siteId), eq(chatIntegrations.id, id)));
  }

  // ── User links ──────────────────────────────────────────────────────────

  async listLinks(integrationId: string) {
    await this.mustGet(integrationId);
    return this.deps.db
      .select({ externalUserId: chatUserLinks.externalUserId, userId: chatUserLinks.userId, createdAt: chatUserLinks.createdAt })
      .from(chatUserLinks)
      .where(and(eq(chatUserLinks.siteId, this.deps.siteId), eq(chatUserLinks.integrationId, integrationId)))
      .orderBy(chatUserLinks.externalUserId);
  }

  /** Links (or re-links) a chat user to a member of this site. */
  async link(integrationId: string, externalUserId: string, userId: string): Promise<void> {
    await this.mustGet(integrationId);
    const [member] = await this.deps.db
      .select({ userId: userSites.userId })
      .from(userSites)
      .where(and(eq(userSites.siteId, this.deps.siteId), eq(userSites.userId, userId)))
      .limit(1);
    if (!member) throw new ChatAgentError('VALIDATION', 'userId is not a member of this site.', 400);
    await this.deps.db
      .insert(chatUserLinks)
      .values({ siteId: this.deps.siteId, integrationId, externalUserId, userId, createdBy: this.deps.userId ?? null })
      .onConflictDoUpdate({
        target: [chatUserLinks.integrationId, chatUserLinks.externalUserId],
        set: { userId, createdBy: this.deps.userId ?? null, createdAt: new Date() },
      });
  }

  async unlink(integrationId: string, externalUserId: string): Promise<boolean> {
    await this.mustGet(integrationId);
    const removed = await this.deps.db
      .delete(chatUserLinks)
      .where(
        and(
          eq(chatUserLinks.siteId, this.deps.siteId),
          eq(chatUserLinks.integrationId, integrationId),
          eq(chatUserLinks.externalUserId, externalUserId),
        ),
      )
      .returning({ id: chatUserLinks.id });
    return removed.length > 0;
  }

  /**
   * The LumiBase user a chat user acts as, or null. The link only counts while
   * that user is still a member of the site: removing someone from the site
   * cuts their chat access too.
   */
  async resolveLink(integrationId: string, externalUserId: string): Promise<string | null> {
    const [row] = await this.deps.db
      .select({ userId: chatUserLinks.userId })
      .from(chatUserLinks)
      .innerJoin(userSites, and(eq(userSites.userId, chatUserLinks.userId), eq(userSites.siteId, chatUserLinks.siteId)))
      .where(
        and(
          eq(chatUserLinks.siteId, this.deps.siteId),
          eq(chatUserLinks.integrationId, integrationId),
          eq(chatUserLinks.externalUserId, externalUserId),
        ),
      )
      .limit(1);
    return row?.userId ?? null;
  }

  // ── Event ledger ────────────────────────────────────────────────────────

  /** Records a delivery. `null` = already seen (a provider retry): do nothing. */
  async recordEvent(input: {
    integrationId: string;
    eventKey: string;
    threadKey?: string | null;
    externalUserId?: string | null;
  }): Promise<string | null> {
    const inserted = await this.deps.db
      .insert(chatEvents)
      .values({
        siteId: this.deps.siteId,
        integrationId: input.integrationId,
        eventKey: input.eventKey,
        threadKey: input.threadKey ?? null,
        externalUserId: input.externalUserId ?? null,
      })
      .onConflictDoNothing({ target: [chatEvents.integrationId, chatEvents.eventKey] })
      .returning({ id: chatEvents.id });
    return inserted[0]?.id ?? null;
  }

  async finishEvent(eventId: string, status: 'done' | 'failed' | 'unlinked', conversationId?: string | null): Promise<void> {
    await this.deps.db
      .update(chatEvents)
      .set({ status, ...(conversationId ? { conversationId } : {}) })
      .where(and(eq(chatEvents.siteId, this.deps.siteId), eq(chatEvents.id, eventId)));
  }

  /** The Copilot conversation this chat user already has in this thread. */
  async threadConversation(integrationId: string, threadKey: string, externalUserId: string): Promise<string | null> {
    const [row] = await this.deps.db
      .select({ conversationId: chatEvents.conversationId })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.siteId, this.deps.siteId),
          eq(chatEvents.integrationId, integrationId),
          eq(chatEvents.threadKey, threadKey),
          eq(chatEvents.externalUserId, externalUserId),
          isNotNull(chatEvents.conversationId),
        ),
      )
      .orderBy(desc(chatEvents.createdAt))
      .limit(1);
    return row?.conversationId ?? null;
  }
}
