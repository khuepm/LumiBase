/**
 * Studio home dashboard layouts (#691).
 *
 * A user's own layout wins; without one the site default applies; without
 * that, the client's built-in default. Every read and write is scoped by
 * `site_id` (and runs under the site RLS policy). Layouts are validated with
 * the shared `dashboardLayoutSchema` before they are stored.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { dashboardLayouts, scopeSite, type Database } from '@lumibase/database';
import {
  dashboardLayoutSchema,
  type DashboardLayout,
  type DashboardLayoutSource,
} from '@lumibase/contracts';

export class DashboardLayoutError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
    this.name = 'DashboardLayoutError';
  }
}

export interface EffectiveDashboardLayout {
  /** `null` = no stored layout; the client uses its built-in default. */
  layout: DashboardLayout | null;
  source: DashboardLayoutSource;
  updatedAt: Date | null;
}

export interface DashboardLayoutServiceDeps {
  db: Database;
  siteId: string;
}

export function parseDashboardLayout(input: unknown): DashboardLayout {
  const parsed = dashboardLayoutSchema.safeParse(input);
  if (!parsed.success) {
    throw new DashboardLayoutError(
      'VALIDATION',
      parsed.error.issues.map((i) => `${i.path.join('.') || 'layout'}: ${i.message}`).join('; '),
      400,
    );
  }
  return parsed.data;
}

export class DashboardLayoutService {
  constructor(private readonly deps: DashboardLayoutServiceDeps) {}

  private owner(userId: string | null) {
    return and(
      scopeSite(dashboardLayouts.siteId, this.deps.siteId),
      userId === null ? isNull(dashboardLayouts.userId) : eq(dashboardLayouts.userId, userId),
    );
  }

  private async read(userId: string | null) {
    const [row] = await this.deps.db.select().from(dashboardLayouts).where(this.owner(userId)).limit(1);
    if (!row) return null;
    // Stored rows were validated on write; re-check so a hand-edited row cannot break the Studio.
    const parsed = dashboardLayoutSchema.safeParse(row.layout);
    return parsed.success ? { layout: parsed.data, updatedAt: row.updatedAt } : null;
  }

  /** The layout a user sees: their own, else the site default, else none. */
  async effective(userId: string | null): Promise<EffectiveDashboardLayout> {
    if (userId) {
      const own = await this.read(userId);
      if (own) return { layout: own.layout, source: 'user', updatedAt: own.updatedAt };
    }
    const site = await this.read(null);
    if (site) return { layout: site.layout, source: 'site', updatedAt: site.updatedAt };
    return { layout: null, source: 'default', updatedAt: null };
  }

  async siteDefault(): Promise<EffectiveDashboardLayout> {
    const site = await this.read(null);
    return site
      ? { layout: site.layout, source: 'site', updatedAt: site.updatedAt }
      : { layout: null, source: 'default', updatedAt: null };
  }

  /** Store a layout for `userId` (or the site default when `null`). */
  async save(userId: string | null, input: unknown, actorId: string | null): Promise<DashboardLayout> {
    const layout = parseDashboardLayout(input);
    const now = new Date();
    const updated = await this.deps.db
      .update(dashboardLayouts)
      .set({ layout, updatedBy: actorId, updatedAt: now })
      .where(this.owner(userId))
      .returning({ id: dashboardLayouts.id });
    if (updated.length === 0) {
      await this.deps.db
        .insert(dashboardLayouts)
        .values({ siteId: this.deps.siteId, userId, layout, updatedBy: actorId, updatedAt: now })
        .onConflictDoNothing();
      // A concurrent first save may have won the insert; make ours the last write.
      await this.deps.db
        .update(dashboardLayouts)
        .set({ layout, updatedBy: actorId, updatedAt: now })
        .where(this.owner(userId));
    }
    return layout;
  }

  /** Remove a user's layout (or the site default when `null`). */
  async reset(userId: string | null): Promise<boolean> {
    const deleted = await this.deps.db
      .delete(dashboardLayouts)
      .where(this.owner(userId))
      .returning({ id: dashboardLayouts.id });
    return deleted.length > 0;
  }
}
