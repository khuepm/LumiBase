/**
 * external-issuer-service.ts — admin CRUD for trusted external JWT issuers
 * (spec: .kiro/specs/external-jwt-auth §5). All operations are site-scoped.
 */

import { and, asc, eq } from 'drizzle-orm';
import { authExternalIssuers, scopeSite, type Database } from '@lumibase/database';
import { makeExternalIssuerConfigSchema, makeExternalIssuerUpdateSchema } from '@lumibase/shared/schemas';
import { AuditLogger } from '../modules/audit/logger';

export class ExternalIssuerError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
    this.name = 'ExternalIssuerError';
  }
}

/** Request actor context for audit enrichment (all optional). */
export interface ExternalIssuerActor {
  email?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

export interface ExternalIssuerServiceDeps {
  db: Database;
  siteId: string;
  /** Relax https requirement for localhost (development only). */
  allowLocalHttp?: boolean;
  /** Actor context for `external_issuer_*` audit rows (never logs config secrets). */
  actor?: ExternalIssuerActor;
}

export class ExternalIssuerService {
  constructor(private readonly deps: ExternalIssuerServiceDeps) {}

  /**
   * Record an issuer lifecycle change. Metadata is deliberately limited to the
   * issuer URL + id — never the JWKS/discovery config or any claim/role mapping
   * (best-effort; the AuditLogger never throws).
   */
  private async audit(event: string, issuer: string, id: string): Promise<void> {
    await new AuditLogger({ db: this.deps.db, siteId: this.deps.siteId }).write({
      event,
      actorEmail: this.deps.actor?.email ?? null,
      ip: this.deps.actor?.ip ?? null,
      userAgent: this.deps.actor?.userAgent ?? null,
      requestId: this.deps.actor?.requestId ?? null,
      metadata: { issuer, issuerId: id },
    });
  }

  async list() {
    return this.deps.db
      .select()
      .from(authExternalIssuers)
      .where(scopeSite(authExternalIssuers.siteId, this.deps.siteId))
      .orderBy(asc(authExternalIssuers.issuer));
  }

  async get(id: string) {
    const [row] = await this.deps.db
      .select()
      .from(authExternalIssuers)
      .where(and(scopeSite(authExternalIssuers.siteId, this.deps.siteId), eq(authExternalIssuers.id, id)))
      .limit(1);
    if (!row) throw new ExternalIssuerError('NOT_FOUND', `Issuer "${id}" not found.`, 404);
    return row;
  }

  async create(input: unknown) {
    const parsed = makeExternalIssuerConfigSchema(this.deps.allowLocalHttp ?? false).safeParse(input);
    if (!parsed.success) {
      throw new ExternalIssuerError('VALIDATION_FAILED', parsed.error.issues[0]?.message ?? 'Invalid issuer config.', 422);
    }
    const cfg = parsed.data;
    // Enforce (site, issuer) uniqueness with a friendly error.
    const [dupe] = await this.deps.db
      .select({ id: authExternalIssuers.id })
      .from(authExternalIssuers)
      .where(and(scopeSite(authExternalIssuers.siteId, this.deps.siteId), eq(authExternalIssuers.issuer, cfg.issuer)))
      .limit(1);
    if (dupe) throw new ExternalIssuerError('ISSUER_ALREADY_EXISTS', `Issuer "${cfg.issuer}" is already configured.`, 409);

    const [row] = await this.deps.db
      .insert(authExternalIssuers)
      .values({
        siteId: this.deps.siteId,
        issuer: cfg.issuer,
        jwksUri: cfg.jwksUri ?? null,
        discoveryUrl: cfg.discoveryUrl ?? null,
        audience: cfg.audience,
        algorithms: cfg.algorithms,
        claimMapping: cfg.claimMapping,
        roleMapping: cfg.roleMapping,
        defaultRoleId: cfg.defaultRoleId ?? null,
        jitProvisioning: cfg.jitProvisioning,
        clockSkewSeconds: cfg.clockSkewSeconds,
        enabled: cfg.enabled,
      })
      .returning();
    if (row) await this.audit('external_issuer_created', row.issuer, row.id);
    return row;
  }

  async update(id: string, patch: unknown) {
    await this.get(id); // 404 if missing
    const parsed = makeExternalIssuerUpdateSchema(this.deps.allowLocalHttp ?? false).safeParse(patch);
    if (!parsed.success) {
      throw new ExternalIssuerError('VALIDATION_FAILED', parsed.error.issues[0]?.message ?? 'Invalid issuer patch.', 422);
    }
    const p = parsed.data as Record<string, unknown>;
    const set: Record<string, unknown> = { updatedAt: new Date() };
    for (const key of [
      'issuer',
      'jwksUri',
      'discoveryUrl',
      'audience',
      'algorithms',
      'claimMapping',
      'roleMapping',
      'defaultRoleId',
      'jitProvisioning',
      'clockSkewSeconds',
      'enabled',
    ]) {
      if (key in p) set[key] = p[key];
    }
    const [row] = await this.deps.db
      .update(authExternalIssuers)
      .set(set)
      .where(and(scopeSite(authExternalIssuers.siteId, this.deps.siteId), eq(authExternalIssuers.id, id)))
      .returning();
    if (row) await this.audit('external_issuer_updated', row.issuer, row.id);
    return row;
  }

  async delete(id: string): Promise<void> {
    const existing = await this.get(id);
    await this.deps.db
      .delete(authExternalIssuers)
      .where(and(scopeSite(authExternalIssuers.siteId, this.deps.siteId), eq(authExternalIssuers.id, id)));
    await this.audit('external_issuer_deleted', existing.issuer, existing.id);
  }
}
