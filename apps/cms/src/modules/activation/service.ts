/**
 * Activation milestones — per-site, in-product.
 *
 * Answers "how far has this site got?" for the site's own admins:
 *
 *   site_created → item_published → delivery_request → agent_run
 *
 * Where each timestamp comes from:
 *
 *   • `site_created`     `lumibase_sites.created_at`                      (derived, exact)
 *   • `item_published`   earliest `updated_at` among the site's published,
 *                        non-deleted `lumibase_items` at the moment the
 *                        milestone is first derived                      (derived, upper bound)
 *   • `agent_run`        earliest `lumibase_agent_runs.started_at`        (derived, exact)
 *   • `delivery_request` first successful content read by a client, recorded
 *                        by `withDeliveryMilestone`                      (event)
 *
 * A milestone is persisted the first time it is observed and never changes
 * afterwards: deleting the item or run that marked it does not un-reach it.
 * `item_published` has no dedicated column to read, so its timestamp is the
 * best one available when it is first derived — later edits to that item can
 * only make it later, never earlier, and once stored it is frozen.
 *
 * Nothing here leaves the install. The opt-in telemetry emitter
 * (`./telemetry.ts`) is a separate reader with its own switch.
 */

import { activationMilestones, agentRuns, items, sites } from '@lumibase/database';
import type { Database } from '@lumibase/database';
import {
  ACTIVATION_MILESTONES,
  type ActivationFunnel,
  type ActivationMilestone,
  type ActivationMilestoneState,
  type ActivationSource,
} from '@lumibase/contracts';
import { and, eq, isNull, min } from 'drizzle-orm';

export interface ActivationServiceDeps {
  db: Database;
  siteId: string;
}

interface StoredMilestone {
  reachedAt: Date;
  source: ActivationSource;
}

function isMilestone(value: string): value is ActivationMilestone {
  return (ACTIVATION_MILESTONES as readonly string[]).includes(value);
}

export class ActivationService {
  private readonly db: Database;
  private readonly siteId: string;

  constructor(deps: ActivationServiceDeps) {
    this.db = deps.db;
    this.siteId = deps.siteId;
  }

  /**
   * The site's funnel. Milestones not stored yet are derived from the source
   * tables and persisted, so the second read is a single indexed lookup.
   */
  async getFunnel(): Promise<ActivationFunnel> {
    let stored = await this.readStored();

    const missing = ACTIVATION_MILESTONES.filter((m) => !stored.has(m) && m !== 'delivery_request');
    if (missing.length > 0) {
      const derived = await this.derive(missing);
      if (derived.length > 0) {
        await this.db
          .insert(activationMilestones)
          .values(derived.map((d) => ({ siteId: this.siteId, milestone: d.key, reachedAt: d.reachedAt, source: 'derived' })))
          .onConflictDoNothing({ target: [activationMilestones.siteId, activationMilestones.milestone] });
        // Re-read: a concurrent writer may have won the insert, and the stored
        // row is the one every later read returns.
        stored = await this.readStored();
      }
    }

    const createdAt = stored.get('site_created')?.reachedAt ?? null;
    const milestones: ActivationMilestoneState[] = ACTIVATION_MILESTONES.map((key) => {
      const row = stored.get(key);
      if (!row) return { key, reachedAt: null, source: null, secondsSinceSiteCreated: null };
      return {
        key,
        reachedAt: row.reachedAt.toISOString(),
        source: row.source,
        secondsSinceSiteCreated: createdAt
          ? Math.max(0, Math.floor((row.reachedAt.getTime() - createdAt.getTime()) / 1000))
          : null,
      };
    });

    return {
      siteId: this.siteId,
      milestones,
      reached: milestones.filter((m) => m.reachedAt !== null).length,
      total: ACTIVATION_MILESTONES.length,
    };
  }

  /**
   * Record a milestone at the moment it happens. Idempotent: the first write
   * wins and later calls are no-ops. Returns nothing on purpose — callers on a
   * read path must not branch on it.
   */
  async record(milestone: ActivationMilestone, at: Date = new Date()): Promise<void> {
    await this.db
      .insert(activationMilestones)
      .values({ siteId: this.siteId, milestone, reachedAt: at, source: 'event' })
      .onConflictDoNothing({ target: [activationMilestones.siteId, activationMilestones.milestone] });
  }

  private async readStored(): Promise<Map<ActivationMilestone, StoredMilestone>> {
    const rows = await this.db
      .select({
        milestone: activationMilestones.milestone,
        reachedAt: activationMilestones.reachedAt,
        source: activationMilestones.source,
      })
      .from(activationMilestones)
      .where(eq(activationMilestones.siteId, this.siteId));
    const out = new Map<ActivationMilestone, StoredMilestone>();
    for (const row of rows) {
      if (!isMilestone(row.milestone)) continue;
      out.set(row.milestone, {
        reachedAt: row.reachedAt,
        source: row.source === 'event' ? 'event' : 'derived',
      });
    }
    return out;
  }

  private async derive(
    wanted: readonly ActivationMilestone[],
  ): Promise<Array<{ key: ActivationMilestone; reachedAt: Date }>> {
    const out: Array<{ key: ActivationMilestone; reachedAt: Date }> = [];

    if (wanted.includes('site_created')) {
      const [row] = await this.db
        .select({ at: sites.createdAt })
        .from(sites)
        .where(eq(sites.id, this.siteId))
        .limit(1);
      if (row?.at) out.push({ key: 'site_created', reachedAt: row.at });
    }

    if (wanted.includes('item_published')) {
      const [row] = await this.db
        .select({ at: min(items.updatedAt) })
        .from(items)
        .where(and(eq(items.siteId, this.siteId), eq(items.status, 'published'), isNull(items.deletedAt)));
      if (row?.at) out.push({ key: 'item_published', reachedAt: row.at });
    }

    if (wanted.includes('agent_run')) {
      const [row] = await this.db
        .select({ at: min(agentRuns.startedAt) })
        .from(agentRuns)
        .where(eq(agentRuns.siteId, this.siteId));
      if (row?.at) out.push({ key: 'agent_run', reachedAt: row.at });
    }

    return out;
  }
}
