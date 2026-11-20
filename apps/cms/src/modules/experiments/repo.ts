/**
 * Site-scoped persistence for A/B experiments (#763). Every query carries
 * `site_id`; routes, delivery and the agent skills only use this port.
 */
import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { experimentArms, experimentParticipants, experiments, pages, type Database } from '@lumibase/database';
import type { ArmCounts } from './stats';

export type ExperimentRecord = typeof experiments.$inferSelect;
export type ArmRecord = typeof experimentArms.$inferSelect;
export type SubjectType = 'page' | 'item';
export type ExperimentStatus = 'draft' | 'running' | 'stopped' | 'completed';
export type EventKind = 'exposure' | 'conversion';

export type ExperimentInput = Pick<ExperimentRecord, 'key' | 'name' | 'subjectType' | 'subjectId' | 'goal'> &
  Partial<Pick<ExperimentRecord, 'hypothesis' | 'minSampleSize' | 'createdBy'>>;
export type ExperimentPatch = Partial<
  Pick<ExperimentRecord, 'name' | 'hypothesis' | 'goal' | 'minSampleSize' | 'status' | 'startedAt' | 'endedAt' | 'winnerArm'>
>;
export type ArmInput = Pick<ArmRecord, 'key' | 'weight' | 'overrides'> & Partial<Pick<ArmRecord, 'name'>>;

export interface ExperimentWithArms extends ExperimentRecord {
  arms: ArmRecord[];
}

/** What delivery needs about a running experiment (cached per site). */
export interface RunningExperiment {
  id: string;
  key: string;
  subjectType: SubjectType;
  subjectId: string;
  /** Page slug for page experiments (resolved when the list is loaded). */
  pageSlug: string | null;
  arms: Array<{ key: string; weight: number; overrides: unknown }>;
}

export interface DailyEventRow {
  day: string;
  armKey: string;
  kind: EventKind;
  count: number;
}

export class ExperimentRepository {
  constructor(
    private readonly db: Database,
    readonly siteId: string,
  ) {}

  list(filter: { status?: ExperimentStatus } = {}): Promise<ExperimentRecord[]> {
    const conds: SQL[] = [eq(experiments.siteId, this.siteId)];
    if (filter.status) conds.push(eq(experiments.status, filter.status));
    return this.db.select().from(experiments).where(and(...conds)).orderBy(asc(experiments.createdAt));
  }

  async get(id: string): Promise<ExperimentWithArms | null> {
    const [row] = await this.db
      .select()
      .from(experiments)
      .where(and(eq(experiments.siteId, this.siteId), eq(experiments.id, id)))
      .limit(1);
    if (!row) return null;
    return { ...row, arms: await this.arms(row.id) };
  }

  arms(experimentId: string): Promise<ArmRecord[]> {
    return this.db
      .select()
      .from(experimentArms)
      .where(and(eq(experimentArms.siteId, this.siteId), eq(experimentArms.experimentId, experimentId)))
      .orderBy(asc(experimentArms.key));
  }

  /** Creates the experiment and its arms in one transaction. */
  async create(input: ExperimentInput, arms: ArmInput[]): Promise<ExperimentWithArms> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(experiments).values({ ...input, siteId: this.siteId }).returning();
      const armRows = await tx
        .insert(experimentArms)
        .values(arms.map((a) => ({ ...a, siteId: this.siteId, experimentId: row!.id })))
        .returning();
      return { ...row!, arms: armRows.sort((x, y) => x.key.localeCompare(y.key)) };
    });
  }

  async update(id: string, patch: ExperimentPatch): Promise<ExperimentRecord | null> {
    const [row] = await this.db
      .update(experiments)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(experiments.siteId, this.siteId), eq(experiments.id, id)))
      .returning();
    return row ?? null;
  }

  /** Replaces every arm (draft experiments only; the route checks). */
  async replaceArms(experimentId: string, arms: ArmInput[]): Promise<ArmRecord[]> {
    return this.db.transaction(async (tx) => {
      await tx.delete(experimentArms).where(and(eq(experimentArms.siteId, this.siteId), eq(experimentArms.experimentId, experimentId)));
      const rows = await tx
        .insert(experimentArms)
        .values(arms.map((a) => ({ ...a, siteId: this.siteId, experimentId })))
        .returning();
      return rows.sort((x, y) => x.key.localeCompare(y.key));
    });
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(experiments)
      .where(and(eq(experiments.siteId, this.siteId), eq(experiments.id, id)))
      .returning({ id: experiments.id });
    return rows.length > 0;
  }

  /** A running experiment on this subject, if any (one at a time per subject). */
  async runningOn(subjectType: SubjectType, subjectId: string): Promise<ExperimentRecord | null> {
    const [row] = await this.db
      .select()
      .from(experiments)
      .where(
        and(
          eq(experiments.siteId, this.siteId),
          eq(experiments.subjectType, subjectType),
          eq(experiments.subjectId, subjectId),
          eq(experiments.status, 'running'),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** Running experiments with their arms and, for pages, the current slug (delivery path). */
  async running(): Promise<RunningExperiment[]> {
    const rows = await this.list({ status: 'running' });
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const armRows = await this.db
      .select()
      .from(experimentArms)
      .where(and(eq(experimentArms.siteId, this.siteId), inArray(experimentArms.experimentId, ids)))
      .orderBy(asc(experimentArms.key));
    const pageIds = rows.filter((r) => r.subjectType === 'page').map((r) => r.subjectId);
    const slugs = new Map<string, string>();
    if (pageIds.length > 0) {
      const pageRows = await this.db
        .select({ id: pages.id, slug: pages.slug })
        .from(pages)
        .where(and(eq(pages.siteId, this.siteId), inArray(pages.id, pageIds)));
      for (const p of pageRows) slugs.set(p.id, p.slug);
    }
    return rows.map((r) => ({
      id: r.id,
      key: r.key,
      subjectType: r.subjectType as SubjectType,
      subjectId: r.subjectId,
      pageSlug: r.subjectType === 'page' ? (slugs.get(r.subjectId) ?? null) : null,
      arms: armRows.filter((a) => a.experimentId === r.id).map((a) => ({ key: a.key, weight: a.weight, overrides: a.overrides })),
    }));
  }

  /** Running experiment by key, with its arms and weights (event beacon). */
  async runningByKey(key: string): Promise<{ id: string; key: string; goal: string; arms: Array<{ key: string; weight: number }> } | null> {
    const [row] = await this.db
      .select({ id: experiments.id, key: experiments.key, goal: experiments.goal })
      .from(experiments)
      .where(and(eq(experiments.siteId, this.siteId), eq(experiments.key, key), eq(experiments.status, 'running')))
      .limit(1);
    if (!row) return null;
    return { ...row, arms: (await this.arms(row.id)).map((a) => ({ key: a.key, weight: a.weight })) };
  }

  /**
   * Record that a visitor saw an arm. Once per visitor and experiment: a
   * replay, or a later exposure to another arm, changes nothing. Returns
   * whether a participant was added.
   */
  async recordExposure(experimentId: string, visitorHash: string, armKey: string): Promise<boolean> {
    const rows = await this.db
      .insert(experimentParticipants)
      .values({ siteId: this.siteId, experimentId, visitorHash, armKey })
      .onConflictDoNothing({ target: [experimentParticipants.siteId, experimentParticipants.experimentId, experimentParticipants.visitorHash] })
      .returning({ id: experimentParticipants.id });
    return rows.length > 0;
  }

  /**
   * Record a conversion: only for a visitor already exposed to this arm, and
   * only once. Returns whether it counted. This is what keeps conversions a
   * subset of exposures.
   */
  async recordConversion(experimentId: string, visitorHash: string, armKey: string): Promise<boolean> {
    const rows = await this.db
      .update(experimentParticipants)
      .set({ convertedAt: new Date() })
      .where(
        and(
          eq(experimentParticipants.siteId, this.siteId),
          eq(experimentParticipants.experimentId, experimentId),
          eq(experimentParticipants.visitorHash, visitorHash),
          eq(experimentParticipants.armKey, armKey),
          isNull(experimentParticipants.convertedAt),
        ),
      )
      .returning({ id: experimentParticipants.id });
    return rows.length > 0;
  }

  /** Visitors exposed and converted per arm (every arm listed, zero when silent). */
  async totals(experimentId: string, armKeys: string[]): Promise<ArmCounts[]> {
    const rows = await this.db
      .select({
        armKey: experimentParticipants.armKey,
        exposures: sql<string>`count(*)`,
        conversions: sql<string>`count(${experimentParticipants.convertedAt})`,
      })
      .from(experimentParticipants)
      .where(and(eq(experimentParticipants.siteId, this.siteId), eq(experimentParticipants.experimentId, experimentId)))
      .groupBy(experimentParticipants.armKey);
    return armKeys.map((key) => {
      const r = rows.find((x) => x.armKey === key);
      return { key, exposures: Number(r?.exposures ?? 0), conversions: Number(r?.conversions ?? 0) };
    });
  }

  /** New participants (exposures) and conversions per UTC day and arm. */
  async daily(experimentId: string): Promise<DailyEventRow[]> {
    const where = and(eq(experimentParticipants.siteId, this.siteId), eq(experimentParticipants.experimentId, experimentId));
    const exposed = await this.db
      .select({ day: sql<string>`to_char(${experimentParticipants.exposedAt}, 'YYYY-MM-DD')`, armKey: experimentParticipants.armKey, n: sql<string>`count(*)` })
      .from(experimentParticipants)
      .where(where)
      .groupBy(sql`1`, experimentParticipants.armKey);
    const converted = await this.db
      .select({ day: sql<string>`to_char(${experimentParticipants.convertedAt}, 'YYYY-MM-DD')`, armKey: experimentParticipants.armKey, n: sql<string>`count(*)` })
      .from(experimentParticipants)
      .where(and(where, sql`${experimentParticipants.convertedAt} is not null`))
      .groupBy(sql`1`, experimentParticipants.armKey);
    const rows: DailyEventRow[] = [
      ...exposed.map((r) => ({ day: r.day, armKey: r.armKey, kind: 'exposure' as const, count: Number(r.n) })),
      ...converted.map((r) => ({ day: r.day, armKey: r.armKey, kind: 'conversion' as const, count: Number(r.n) })),
    ];
    return rows.sort((a, b) => a.day.localeCompare(b.day) || a.armKey.localeCompare(b.armKey) || a.kind.localeCompare(b.kind));
  }

  /** Last change to any experiment or arm of the site (feeds the delivery ETag). */
  async fingerprint(): Promise<string> {
    const [e] = await this.db
      .select({ at: sql<string | null>`max(${experiments.updatedAt})`, n: sql<number>`count(*)::int` })
      .from(experiments)
      .where(eq(experiments.siteId, this.siteId));
    const [a] = await this.db
      .select({ at: sql<string | null>`max(${experimentArms.updatedAt})` })
      .from(experimentArms)
      .where(eq(experimentArms.siteId, this.siteId));
    return `${e?.at ?? '-'}:${e?.n ?? 0}:${a?.at ?? '-'}`;
  }
}
