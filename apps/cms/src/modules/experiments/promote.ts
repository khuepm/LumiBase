/**
 * Promoting an experiment's winner (#763). Only ever reached through an
 * approved `promoteExperimentWinner` (HITL): the skill is `dangerous`, so the
 * harness parks it in `ai_approvals` and runs this after a human approves.
 *
 * - A challenger arm's overrides become the published content: a page's
 *   `title` / `layoutConfig` through PageService, an item's fields through the
 *   ItemService (so validation, revisions and RBAC apply as for any edit).
 * - `control` changes no content.
 * Either way the experiment ends as `completed` with its winner recorded, and
 * delivery stops splitting traffic.
 */
import { and, eq } from 'drizzle-orm';
import { collections, items, type Database } from '@lumibase/database';
import type { CacheProvider, EdgeCacheProvider } from '@lumibase/runtime';
import { invalidateDeliverTag } from '../../services/content-invalidation';
import { PageService, type PatchPageInput } from '../../services/page-service';
import type { ItemService } from '../../services/item-service';
import { runningCacheKey } from './delivery';
import { ExperimentRepository, type ExperimentRecord } from './repo';
import { CONTROL_ARM } from './stats';

export class ExperimentError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 404 | 409 | 422 = 400,
  ) {
    super(message);
    this.name = 'ExperimentError';
  }
}

export interface ExperimentDeps {
  db: Database;
  siteId: string;
  cache?: CacheProvider;
  edgeCache?: EdgeCacheProvider | null;
}

/** Drop the cached running list and every delivered copy of the site. */
export async function invalidateExperiments(deps: ExperimentDeps): Promise<void> {
  if (!deps.cache) return;
  await deps.cache.delete(runningCacheKey(deps.siteId)).catch(() => undefined);
  await invalidateDeliverTag(deps.cache, deps.siteId, deps.edgeCache).catch(() => undefined);
}

export async function promoteWinner(
  deps: ExperimentDeps & { itemService?: ItemService },
  input: { experimentId: string; arm: string },
): Promise<{ experiment: ExperimentRecord; arm: string; contentChanged: boolean }> {
  const repo = new ExperimentRepository(deps.db, deps.siteId);
  const experiment = await repo.get(input.experimentId);
  if (!experiment) throw new ExperimentError('NOT_FOUND', 'Experiment not found.', 404);
  if (experiment.status !== 'running' && experiment.status !== 'stopped') {
    throw new ExperimentError('INVALID_STATE', `A ${experiment.status} experiment cannot be promoted.`, 409);
  }
  const arm = experiment.arms.find((a) => a.key === input.arm);
  if (!arm) throw new ExperimentError('ARM_NOT_FOUND', `Experiment has no arm "${input.arm}".`, 404);

  let contentChanged = false;
  if (arm.key !== CONTROL_ARM) {
    const o = (arm.overrides ?? {}) as Record<string, unknown>;
    if (experiment.subjectType === 'page') {
      const patch: PatchPageInput = {};
      if (typeof o.title === 'string' && o.title.trim()) patch.title = o.title;
      if (o.layoutConfig && typeof o.layoutConfig === 'object') patch.layoutConfig = o.layoutConfig as Record<string, unknown>;
      if (Object.keys(patch).length > 0) {
        await new PageService({ db: deps.db, siteId: deps.siteId, cache: deps.cache }).patch(experiment.subjectId, patch);
        contentChanged = true;
      }
    } else {
      if (!deps.itemService) throw new Error('ITEM_SERVICE_NOT_CONFIGURED: promoting an item experiment needs the item service');
      const [row] = await deps.db
        .select({ collection: collections.name })
        .from(items)
        .innerJoin(collections, eq(collections.id, items.collectionId))
        .where(and(eq(items.siteId, deps.siteId), eq(items.id, experiment.subjectId)))
        .limit(1);
      if (!row) throw new ExperimentError('SUBJECT_NOT_FOUND', 'The experiment item no longer exists.', 404);
      if (Object.keys(o).length > 0) {
        await deps.itemService.patch(row.collection, experiment.subjectId, { data: o });
        contentChanged = true;
      }
    }
  }

  const updated = await repo.update(experiment.id, {
    status: 'completed',
    winnerArm: arm.key,
    endedAt: experiment.endedAt ?? new Date(),
  });
  await invalidateExperiments(deps);
  return { experiment: updated!, arm: arm.key, contentChanged };
}
