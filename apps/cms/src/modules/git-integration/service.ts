/**
 * GitIntegrationService — CRUD + credential lifecycle for per-site Git
 * connections. Every method is scoped to a single `siteId` (CLAUDE.md rule #2);
 * tokens and webhook secrets are encrypted before they touch the DB and never
 * returned to callers. See `.kiro/specs/git-integration/design.md` §6.
 */
import type { Database } from '@lumibase/database';
import { gitIntegrations } from '@lumibase/database';
import type {
  GitIntegrationCreateInput,
  GitIntegrationResource,
  GitIntegrationUpdateInput,
} from '@lumibase/contracts/schemas';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import {
  encryptSecretValue,
  generateWebhookSecret,
} from './crypto';

export class GitIntegrationConflictError extends Error {
  readonly code = 'CONFLICT';
  constructor() {
    super('An integration for this repository already exists.');
    this.name = 'GitIntegrationConflictError';
  }
}

type GitIntegrationRow = typeof gitIntegrations.$inferSelect;

export interface GitIntegrationServiceDeps {
  db: Database;
  siteId: string;
  encryptionKey: string;
  /** Public origin used to build the operator-facing webhook URL. */
  publicBaseUrl: string;
}

export class GitIntegrationService {
  constructor(private readonly deps: GitIntegrationServiceDeps) {}

  private webhookUrl(row: GitIntegrationRow): string {
    const base = this.deps.publicBaseUrl.replace(/\/+$/, '');
    // siteId + integrationId are embedded so the public (un-tenanted) webhook
    // receiver can scope its lookup; the per-integration secret signature is
    // the actual authenticity gate.
    return `${base}/api/v1/integrations/git/webhook/${row.provider}/${row.siteId}/${row.id}`;
  }

  toResource(row: GitIntegrationRow): GitIntegrationResource {
    return {
      id: row.id,
      provider: row.provider as GitIntegrationResource['provider'],
      repoFullName: row.repoFullName,
      displayName: row.displayName,
      authMethod: row.authMethod as GitIntegrationResource['authMethod'],
      status: row.status as GitIntegrationResource['status'],
      statusReason: row.statusReason,
      scopes: (row.scopes as string[]) ?? [],
      hasToken: Boolean(row.encryptedToken) || Boolean(row.installationId),
      webhookUrl: this.webhookUrl(row),
      lastSyncAt: row.lastSyncAt ? row.lastSyncAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async list(): Promise<GitIntegrationResource[]> {
    const rows = await this.deps.db
      .select()
      .from(gitIntegrations)
      .where(eq(gitIntegrations.siteId, this.deps.siteId));
    return rows.map((r) => this.toResource(r));
  }

  /** Fetch the public resource by id (scoped to site). */
  async get(id: string): Promise<GitIntegrationResource | null> {
    const row = await this.getRow(id);
    return row ? this.toResource(row) : null;
  }

  /** Internal: the raw row (incl. encrypted fields) for provider resolution. */
  async getRow(id: string): Promise<GitIntegrationRow | null> {
    const [row] = await this.deps.db
      .select()
      .from(gitIntegrations)
      .where(
        and(
          eq(gitIntegrations.siteId, this.deps.siteId),
          eq(gitIntegrations.id, id),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async create(
    input: GitIntegrationCreateInput,
  ): Promise<GitIntegrationResource> {
    const existing = await this.deps.db
      .select({ id: gitIntegrations.id })
      .from(gitIntegrations)
      .where(
        and(
          eq(gitIntegrations.siteId, this.deps.siteId),
          eq(gitIntegrations.provider, input.provider),
          eq(gitIntegrations.repoFullName, input.repoFullName),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      throw new GitIntegrationConflictError();
    }

    const id = nanoid();
    const ctx = { siteId: this.deps.siteId, integrationId: id };

    const webhookSecretEnc = await encryptSecretValue(
      this.deps.encryptionKey,
      generateWebhookSecret(),
      ctx,
      'webhook_secret',
    );
    const encryptedToken = input.token
      ? await encryptSecretValue(this.deps.encryptionKey, input.token, ctx, 'token')
      : null;

    const connected = Boolean(input.token) || Boolean(input.installationId);

    const [row] = await this.deps.db
      .insert(gitIntegrations)
      .values({
        id,
        siteId: this.deps.siteId,
        provider: input.provider,
        repoFullName: input.repoFullName,
        displayName: input.displayName,
        authMethod: input.authMethod,
        installationId: input.installationId ?? null,
        encryptedToken,
        webhookSecretEnc,
        status: connected ? 'connected' : 'disconnected',
        scopes: input.scopes ?? [],
        syncConfig: input.syncConfig ?? {},
      })
      .returning();
    return this.toResource(row!);
  }

  async update(
    id: string,
    input: GitIntegrationUpdateInput,
  ): Promise<GitIntegrationResource | null> {
    const row = await this.getRow(id);
    if (!row) return null;

    const patch: Partial<GitIntegrationRow> = { updatedAt: new Date() };
    if (input.displayName !== undefined) patch.displayName = input.displayName;
    if (input.installationId !== undefined)
      patch.installationId = input.installationId;
    if (input.status !== undefined) patch.status = input.status;
    if (input.scopes !== undefined) patch.scopes = input.scopes;
    if (input.syncConfig !== undefined) patch.syncConfig = input.syncConfig;
    if (input.token !== undefined) {
      patch.encryptedToken = await encryptSecretValue(
        this.deps.encryptionKey,
        input.token,
        { siteId: this.deps.siteId, integrationId: id },
        'token',
      );
      patch.status = 'connected';
      patch.statusReason = null;
    }

    const [updated] = await this.deps.db
      .update(gitIntegrations)
      .set(patch)
      .where(
        and(
          eq(gitIntegrations.siteId, this.deps.siteId),
          eq(gitIntegrations.id, id),
        ),
      )
      .returning();
    return updated ? this.toResource(updated) : null;
  }

  /** Rotate the webhook secret; returns the resource or null when not found. */
  async rotateSecret(id: string): Promise<GitIntegrationResource | null> {
    const row = await this.getRow(id);
    if (!row) return null;
    const webhookSecretEnc = await encryptSecretValue(
      this.deps.encryptionKey,
      generateWebhookSecret(),
      { siteId: this.deps.siteId, integrationId: id },
      'webhook_secret',
    );
    const [updated] = await this.deps.db
      .update(gitIntegrations)
      .set({ webhookSecretEnc, updatedAt: new Date() })
      .where(
        and(
          eq(gitIntegrations.siteId, this.deps.siteId),
          eq(gitIntegrations.id, id),
        ),
      )
      .returning();
    return updated ? this.toResource(updated) : null;
  }

  async delete(id: string): Promise<boolean> {
    const deleted = await this.deps.db
      .delete(gitIntegrations)
      .where(
        and(
          eq(gitIntegrations.siteId, this.deps.siteId),
          eq(gitIntegrations.id, id),
        ),
      )
      .returning({ id: gitIntegrations.id });
    return deleted.length > 0;
  }
}
