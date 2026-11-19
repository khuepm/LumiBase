/**
 * Site-scoped persistence for A/B experiments (#763). Every query carries
 * `site_id`; routes, delivery and the agent skills only use this port.
 */
import { and, asc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { experimentArms, experimentEvents, experiments, pages, type Database } from '@lumibase/database';
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

  /** Running experiment by key with its arm keys (event beacon). */
  async runningByKey(key: string): Promise<{ id: string; arms: string[]; goal: string } | null> {
    const [row] = await this.db
      .select({ id: experiments.id, goal: experiments.goal })
      .from(experiments)
      .where(and(eq(experiments.siteId, this.siteId), eq(experiments.key, key), eq(experiments.status, 'running')))
      .limit(1);
    if (!row) return null;
    return { id: row.id, goal: row.goal, arms: (await this.arms(row.id)).map((a) => a.key) };
  }

  async recordEvent(experimentId: string, armKey: string, kind: EventKind, day: string, by = 1): Promise<void> {
    await this.db
      .insert(experimentEvents)
      .values({ siteId: this.siteId, experimentId, armKey, kind, day, count: by })
      .onConflictDoUpdate({
        target: [experimentEvents.siteId, experimentEvents.experimentId, experimentEvents.armKey, experimentEvents.day, experimentEvents.kind],
        set: { count: sql`${experimentEvents.count} + ${by}`, updatedAt: new Date() },
      });
  }

  /** Exposure / conversion totals per arm (every arm listed, zero when silent). */
  async totals(experimentId: string, armKeys: string[]): Promise<ArmCounts[]> {
    const rows = await this.db
      .select({ armKey: experimentEvents.armKey, kind: experimentEvents.kind, n: sql<string>`sum(${experimentEvents.count})` })
      .from(experimentEvents)
      .where(and(eq(experimentEvents.siteId, this.siteId), eq(experimentEvents.experimentId, experimentId)))
      .groupBy(experimentEvents.armKey, experimentEvents.kind);
    return armKeys.map((key) => ({
      key,
      exposures: Number(rows.find((r) => r.armKey === key && r.kind === 'exposure')?.n ?? 0),
      conversions: Number(rows.find((r) => r.armKey === key && r.kind === 'conversion')?.n ?? 0),
    }));
  }

  async daily(experimentId: string, range: { from?: string; to?: string } = {}): Promise<DailyEventRow[]> {
    const conds: SQL[] = [eq(experimentEvents.siteId, this.siteId), eq(experimentEvents.experimentId, experimentId)];
    if (range.from) conds.push(gte(experimentEvents.day, range.from));
    if (range.to) conds.push(lte(experimentEvents.day, range.to));
    const rows = await this.db
      .select({ day: experimentEvents.day, armKey: experimentEvents.armKey, kind: experimentEvents.kind, count: experimentEvents.count })
      .from(experimentEvents)
      .where(and(...conds))
      .orderBy(asc(experimentEvents.day), asc(experimentEvents.armKey), asc(experimentEvents.kind));
    return rows.map((r) => ({ day: String(r.day), armKey: r.armKey, kind: r.kind as EventKind, count: Number(r.count) }));
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
