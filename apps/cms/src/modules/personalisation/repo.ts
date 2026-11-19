/**
 * Site-scoped persistence for personalisation (#762). Every query carries
 * `site_id`; the route and delivery code only use this port.
 */
import { and, asc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { audiences, contentVariants, variantExposures, type Database } from '@lumibase/database';

export type AudienceRecord = typeof audiences.$inferSelect;
export type VariantRecord = typeof contentVariants.$inferSelect;
export type SubjectType = 'page' | 'item';

export type AudienceInput = Pick<AudienceRecord, 'key' | 'name' | 'rules'> &
  Partial<Pick<AudienceRecord, 'description' | 'priority' | 'enabled'>>;
export type AudiencePatch = Partial<Pick<AudienceRecord, 'key' | 'name' | 'description' | 'rules' | 'priority' | 'enabled'>>;
export type VariantInput = Pick<VariantRecord, 'subjectType' | 'subjectId' | 'audienceId' | 'overrides'> &
  Partial<Pick<VariantRecord, 'status' | 'createdBy'>>;
export type VariantPatch = Partial<Pick<VariantRecord, 'overrides' | 'status'>>;

export interface ExposureRow {
  day: string;
  subjectType: string;
  subjectId: string;
  audienceKey: string;
  count: number;
}

/** Postgres unique violation, through the driver's or drizzle's error shape. */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
}

export class PersonalisationRepository {
  constructor(
    private readonly db: Database,
    readonly siteId: string,
  ) {}

  // --- audiences -----------------------------------------------------------

  listAudiences(): Promise<AudienceRecord[]> {
    return this.db
      .select()
      .from(audiences)
      .where(eq(audiences.siteId, this.siteId))
      .orderBy(asc(audiences.priority), asc(audiences.key));
  }

  async getAudience(id: string): Promise<AudienceRecord | null> {
    const [row] = await this.db
      .select()
      .from(audiences)
      .where(and(eq(audiences.siteId, this.siteId), eq(audiences.id, id)))
      .limit(1);
    return row ?? null;
  }

  async createAudience(input: AudienceInput): Promise<AudienceRecord> {
    const [row] = await this.db.insert(audiences).values({ ...input, siteId: this.siteId }).returning();
    return row!;
  }

  async updateAudience(id: string, patch: AudiencePatch): Promise<AudienceRecord | null> {
    const [row] = await this.db
      .update(audiences)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(audiences.siteId, this.siteId), eq(audiences.id, id)))
      .returning();
    return row ?? null;
  }

  async deleteAudience(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(audiences)
      .where(and(eq(audiences.siteId, this.siteId), eq(audiences.id, id)))
      .returning({ id: audiences.id });
    return rows.length > 0;
  }

  // --- variants ------------------------------------------------------------

  listVariants(filter: { subjectType?: SubjectType; subjectId?: string; audienceId?: string } = {}): Promise<VariantRecord[]> {
    const conds: SQL[] = [eq(contentVariants.siteId, this.siteId)];
    if (filter.subjectType) conds.push(eq(contentVariants.subjectType, filter.subjectType));
    if (filter.subjectId) conds.push(eq(contentVariants.subjectId, filter.subjectId));
    if (filter.audienceId) conds.push(eq(contentVariants.audienceId, filter.audienceId));
    return this.db
      .select()
      .from(contentVariants)
      .where(and(...conds))
      .orderBy(asc(contentVariants.subjectType), asc(contentVariants.subjectId), asc(contentVariants.createdAt));
  }

  async getVariant(id: string): Promise<VariantRecord | null> {
    const [row] = await this.db
      .select()
      .from(contentVariants)
      .where(and(eq(contentVariants.siteId, this.siteId), eq(contentVariants.id, id)))
      .limit(1);
    return row ?? null;
  }

  async createVariant(input: VariantInput): Promise<VariantRecord> {
    const [row] = await this.db.insert(contentVariants).values({ ...input, siteId: this.siteId }).returning();
    return row!;
  }

  async updateVariant(id: string, patch: VariantPatch): Promise<VariantRecord | null> {
    const [row] = await this.db
      .update(contentVariants)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(contentVariants.siteId, this.siteId), eq(contentVariants.id, id)))
      .returning();
    return row ?? null;
  }

  async deleteVariant(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(contentVariants)
      .where(and(eq(contentVariants.siteId, this.siteId), eq(contentVariants.id, id)))
      .returning({ id: contentVariants.id });
    return rows.length > 0;
  }

  /** Published variants of these subjects for one audience (delivery path). */
  publishedVariants(subjectType: SubjectType, subjectIds: string[], audienceId: string): Promise<VariantRecord[]> {
    if (subjectIds.length === 0) return Promise.resolve([]);
    return this.db
      .select()
      .from(contentVariants)
      .where(
        and(
          eq(contentVariants.siteId, this.siteId),
          eq(contentVariants.subjectType, subjectType),
          inArray(contentVariants.subjectId, subjectIds),
          eq(contentVariants.audienceId, audienceId),
          eq(contentVariants.status, 'published'),
        ),
      );
  }

  /** Last change to any variant of the site (feeds the delivery ETag). */
  async variantsFingerprint(): Promise<string> {
    const [row] = await this.db
      .select({ at: sql<string | null>`max(${contentVariants.updatedAt})`, n: sql<number>`count(*)::int` })
      .from(contentVariants)
      .where(eq(contentVariants.siteId, this.siteId));
    return `${row?.at ?? '-'}:${row?.n ?? 0}`;
  }

  // --- exposures -----------------------------------------------------------

  async recordExposure(day: string, subjectType: SubjectType, subjectId: string, audienceKey: string, by = 1): Promise<void> {
    await this.db
      .insert(variantExposures)
      .values({ siteId: this.siteId, day, subjectType, subjectId, audienceKey, count: by })
      .onConflictDoUpdate({
        target: [variantExposures.siteId, variantExposures.day, variantExposures.subjectType, variantExposures.subjectId, variantExposures.audienceKey],
        set: { count: sql`${variantExposures.count} + ${by}`, updatedAt: new Date() },
      });
  }

  async exposures(filter: { from: string; to: string; subjectType?: SubjectType; subjectId?: string }): Promise<ExposureRow[]> {
    const conds: SQL[] = [eq(variantExposures.siteId, this.siteId), gte(variantExposures.day, filter.from), lte(variantExposures.day, filter.to)];
    if (filter.subjectType) conds.push(eq(variantExposures.subjectType, filter.subjectType));
    if (filter.subjectId) conds.push(eq(variantExposures.subjectId, filter.subjectId));
    const rows = await this.db
      .select({
        day: variantExposures.day,
        subjectType: variantExposures.subjectType,
        subjectId: variantExposures.subjectId,
        audienceKey: variantExposures.audienceKey,
        count: variantExposures.count,
      })
      .from(variantExposures)
      .where(and(...conds))
      .orderBy(asc(variantExposures.day), asc(variantExposures.subjectId), asc(variantExposures.audienceKey));
    return rows.map((r) => ({ ...r, day: String(r.day), count: Number(r.count) }));
  }
}
