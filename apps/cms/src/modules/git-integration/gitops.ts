/**
 * GitOps reconcile — treats the connected repo as the source of truth for
 * declarative content intents. Reads `lumibase/intents.json` (an array of
 * intent definitions), upserts them via IntentService, then runs a drift scan +
 * reconcile so out-of-policy items become agent goals. Provenance is recorded
 * per synced intent.
 *
 * Scope note: this syncs INTENTS only. Schema (collections/fields) apply from
 * Git must flow through the HITL-gated SchemaService/harness and is deferred to
 * a follow-up — see `.kiro/specs/git-integration/tasks.md` task 13.
 */
import type { Database } from '@lumibase/database';
import { contentIntents } from '@lumibase/database';
import { and, eq } from 'drizzle-orm';
import {
  intentInputSchema,
  IntentService,
} from '../../services/intent-service';
import { DriftService } from '../../services/drift-service';
import { ReconcilerService } from '../../services/reconciler-service';
import { GITOPS_INTENTS_PATH } from './constants';
import { recordProvenance } from './provenance';
import type { GitProvider, RepoRef } from './providers/types';

export { GITOPS_INTENTS_PATH };

export interface GitOpsDeps {
  db: Database;
  siteId: string;
  integrationId: string;
  userId?: string | null;
}

export interface GitOpsSyncResult {
  found: boolean;
  applied: { name: string; action: 'created' | 'updated' }[];
  errors: string[];
  goalsCreated: number;
}

export interface ParsedIntentConfig {
  intents: import('../../services/intent-service').IntentInput[];
  errors: string[];
}

/**
 * Parse + validate the raw `intents.json` body into typed intent inputs (pure;
 * no DB). Invalid entries are collected into `errors` instead of throwing.
 */
export function parseIntentConfig(raw: string): ParsedIntentConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { intents: [], errors: [`${GITOPS_INTENTS_PATH} is not valid JSON.`] };
  }
  const configs = Array.isArray(parsed) ? parsed : [parsed];
  const intents: import('../../services/intent-service').IntentInput[] = [];
  const errors: string[] = [];
  configs.forEach((cfg, i) => {
    const res = intentInputSchema.safeParse(cfg);
    if (res.success) intents.push(res.data);
    else
      errors.push(
        `intent[${i}]: ${res.error.issues.map((x) => x.message).join('; ')}`,
      );
  });
  return { intents, errors };
}

/**
 * Read + apply the repo's intent config. `ref` (branch/sha) is optional;
 * defaults to the repo's default branch.
 */
export async function syncFromRepo(
  provider: GitProvider,
  repo: RepoRef,
  deps: GitOpsDeps,
  ref?: string,
): Promise<GitOpsSyncResult> {
  const result: GitOpsSyncResult = {
    found: false,
    applied: [],
    errors: [],
    goalsCreated: 0,
  };

  const raw = await provider.getFileContents(repo, GITOPS_INTENTS_PATH, ref);
  if (!raw) return result;
  result.found = true;

  const { intents, errors } = parseIntentConfig(raw);
  result.errors.push(...errors);

  const intentService = new IntentService({
    db: deps.db,
    siteId: deps.siteId,
    userId: deps.userId ?? null,
  });
  const driftService = new DriftService({ db: deps.db, siteId: deps.siteId });
  const reconciler = new ReconcilerService({
    db: deps.db,
    siteId: deps.siteId,
  });

  for (const input of intents) {
    // Upsert by (siteId, name).
    const [existing] = await deps.db
      .select({ id: contentIntents.id })
      .from(contentIntents)
      .where(
        and(
          eq(contentIntents.siteId, deps.siteId),
          eq(contentIntents.name, input.name),
        ),
      )
      .limit(1);

    let intentId: string;
    try {
      if (existing) {
        const updated = await intentService.update(existing.id, input);
        intentId = updated.id;
        result.applied.push({ name: input.name, action: 'updated' });
      } else {
        const created = await intentService.create(input);
        intentId = created.id;
        result.applied.push({ name: input.name, action: 'created' });
      }
    } catch (e) {
      result.errors.push(`intent[${input.name}]: ${(e as Error).message}`);
      continue;
    }

    // Detect drift + create corrective goals (best-effort per intent).
    try {
      await driftService.scanIntent(intentId);
      const reconciled = await reconciler.reconcileIntent(intentId);
      result.goalsCreated += reconciled.goalsCreated ?? 0;
    } catch {
      // scan/reconcile may be gated by feature flags or maintenance window
    }

    await recordProvenance(deps.db, {
      siteId: deps.siteId,
      integrationId: deps.integrationId,
      commitSha: ref ?? 'HEAD',
      changeType: 'intent',
    });
  }

  return result;
}
