#!/usr/bin/env tsx
/**
 * Content OS demo seed (content-os-ui task 10; Req 9.1-9.3).
 *
 * A clean instance shows "Inbox zero" on every Mission Control screen —
 * this seed dresses `site_demo` so the v2 UI is visible end to end:
 *
 *   - demo collection `cos_demo_articles` + fields + 3 items
 *   - 2 content intents: one active with open+resolved drifts, one errored
 *   - 1 staged revision inside its veto window + `kind='veto'` approval
 *   - 1 ordinary pending approval, 2 open incidents
 *   - 3 autonomy grants across levels, 1 constitution (active when the
 *     site has none yet)
 *   - agent-authored revisions with provenance on a demo item
 *   - contentOs feature flags (inserted only when absent)
 *
 * Every row uses a stable id with the `cosdemo_` prefix and upserts, so the
 * script is safe to re-run (re-running refreshes the veto deadline so the
 * staged change is always inside its window). Nothing outside these ids is
 * touched. Run `pnpm db:seed-dev` first for the base site + access rows.
 *
 * Usage:
 *   DATABASE_URL=postgres://... pnpm --filter @lumibase/database seed:content-os-demo
 */
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import {
  agentApprovals,
  agentAutonomyGrants,
  agentGoals,
  agentIncidents,
  agentRuns,
  collections,
  constitutions,
  contentDrifts,
  contentIntents,
  fields,
  items,
  revisions,
  settings,
} from '../src/schema';

const SITE = 'site_demo';
const ID = {
  collection: 'cosdemo_coll_articles',
  fieldTitle: 'cosdemo_field_title',
  fieldBody: 'cosdemo_field_body',
  fieldMeta: 'cosdemo_field_meta',
  itemFresh: 'cosdemo_item_fresh',
  itemStale: 'cosdemo_item_stale',
  itemStaged: 'cosdemo_item_staged',
  intentFresh: 'cosdemo_intent_fresh',
  intentError: 'cosdemo_intent_error',
  driftMeta: 'cosdemo_drift_meta',
  driftFresh: 'cosdemo_drift_fresh',
  driftResolved: 'cosdemo_drift_resolved',
  goal: 'cosdemo_goal_rewrite',
  run: 'cosdemo_run_writer',
  revStaged: 'cosdemo_rev_staged',
  revAgent: 'cosdemo_rev_agent',
  revHuman: 'cosdemo_rev_human',
  aprVeto: 'cosdemo_apr_veto',
  aprSchema: 'cosdemo_apr_schema',
  incVeto: 'cosdemo_inc_veto',
  incLoad: 'cosdemo_inc_load',
  grantWriter: 'cosdemo_grant_writer',
  grantTranslator: 'cosdemo_grant_translator',
  grantSeo: 'cosdemo_grant_seo',
  constitution: 'cosdemo_constitution_v1',
} as const;

const COLLECTION_NAME = 'cos_demo_articles';
const MODEL = 'demo-writer-llm';
const CONSTITUTION_HASH = 'sha256:cosdemo0000000000000000000000000000000000000000000000000000demo';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('Error: DATABASE_URL is required.');
    process.exit(1);
  }

  console.log('[seed-content-os-demo] Connecting to:', url.replace(/:([^:@]+)@/, ':***@'));
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);
  const log = (msg: string) => console.log(`[seed-content-os-demo] ✓ ${msg}`);

  // Base rows the demo depends on (same upserts as seed-dev — harmless re-run).
  await db.execute(
    sql`INSERT INTO lumibase_sites (id, name, domain) VALUES (${SITE}, 'Demo Site', 'localhost')
        ON CONFLICT (id) DO NOTHING`,
  );
  await db.execute(
    sql`INSERT INTO lumibase_system_state (id, state) VALUES ('singleton', 'initialized')
        ON CONFLICT (id) DO NOTHING`,
  );

  // ── Demo collection + fields + items ────────────────────────────────────
  await db
    .insert(collections)
    .values({
      id: ID.collection,
      siteId: SITE,
      name: COLLECTION_NAME,
      label: 'Demo Articles (Content OS)',
      displayTemplate: '{{title}}',
    })
    .onConflictDoNothing({ target: collections.id });
  log(`collection ${COLLECTION_NAME}`);

  const fieldRows = [
    { id: ID.fieldTitle, name: 'title', type: 'string', interface: 'input', label: 'Title' },
    { id: ID.fieldBody, name: 'body', type: 'text', interface: 'textarea', label: 'Body' },
    {
      id: ID.fieldMeta,
      name: 'meta_description',
      type: 'string',
      interface: 'input',
      label: 'Meta description',
    },
  ];
  for (const field of fieldRows) {
    await db
      .insert(fields)
      .values({ ...field, siteId: SITE, collectionId: ID.collection })
      .onConflictDoNothing({ target: fields.id });
  }
  log('fields title/body/meta_description');

  const staleDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
  const itemRows = [
    {
      id: ID.itemFresh,
      status: 'published',
      data: {
        title: 'Edge caching explained',
        body: 'A healthy article that meets every rule of the intent.',
        meta_description: 'How LumiBase caches content at the edge.',
      },
    },
    {
      id: ID.itemStale,
      status: 'published',
      data: {
        title: 'Legacy launch notes',
        body: 'Stale content: old and missing its meta description.',
      },
      createdAt: staleDate,
      updatedAt: staleDate,
    },
    {
      id: ID.itemStaged,
      status: 'published',
      data: {
        title: 'Quarterly product update',
        body: 'The human-written body an agent wants to rewrite.',
        meta_description: 'Product update for the quarter.',
      },
    },
  ];
  for (const item of itemRows) {
    await db
      .insert(items)
      .values({ ...item, siteId: SITE, collectionId: ID.collection })
      .onConflictDoNothing({ target: items.id });
  }
  log('3 demo items (fresh / stale / staged target)');

  // ── Intents: one healthy-ish, one tripped circuit breaker ───────────────
  await db
    .insert(contentIntents)
    .values([
      {
        id: ID.intentFresh,
        siteId: SITE,
        name: 'cosdemo: articles complete & fresh',
        collection: COLLECTION_NAME,
        rules: [
          { type: 'required_fields', fields: ['meta_description'] },
          { type: 'freshness', maxAgeDays: 90 },
        ],
        schedule: '0 * * * *',
        budget: { maxGoalsPerCycle: 5, maxWritesPerMinute: 30, maxCostUsd: 1 },
        autonomyCap: 3,
        status: 'active',
      },
      {
        id: ID.intentError,
        siteId: SITE,
        name: 'cosdemo: broken links sweep',
        collection: COLLECTION_NAME,
        rules: [{ type: 'link_health' }],
        schedule: '0 3 * * *',
        budget: { maxGoalsPerCycle: 3 },
        autonomyCap: 2,
        status: 'error',
        statusReason: 'Circuit breaker: 3 consecutive goal failures (demo).',
      },
    ])
    .onConflictDoUpdate({
      target: contentIntents.id,
      set: { status: sql`excluded.status`, statusReason: sql`excluded.status_reason` },
    });
  log('2 intents (active + error)');

  // ── Goal + run: lineage for the staged change and agent revisions ───────
  await db
    .insert(agentGoals)
    .values({
      id: ID.goal,
      siteId: SITE,
      title: 'cosdemo: rewrite stale product update',
      assigneeAgent: 'writer',
      status: 'in_progress',
    })
    .onConflictDoNothing({ target: agentGoals.id });
  await db
    .insert(agentRuns)
    .values({
      id: ID.run,
      siteId: SITE,
      goalId: ID.goal,
      agentName: 'writer',
      model: MODEL,
      status: 'awaiting_approval',
    })
    .onConflictDoNothing({ target: agentRuns.id });
  log('goal + run (writer)');

  // ── Drifts against the active intent ─────────────────────────────────────
  const drift = (id: string, itemId: string, ruleType: string, ruleKey: string, status: string) => ({
    id,
    siteId: SITE,
    intentId: ID.intentFresh,
    itemId,
    ruleType,
    ruleKey,
    fingerprint: `${ID.intentFresh}:${itemId}:${ruleType}:${ruleKey}`,
    status,
    detail: { demo: true },
    resolvedAt: status === 'resolved' ? new Date() : null,
  });
  await db
    .insert(contentDrifts)
    .values([
      drift(ID.driftMeta, ID.itemStale, 'required_fields', 'meta_description', 'open'),
      drift(ID.driftFresh, ID.itemStale, 'freshness', 'freshness', 'open'),
      drift(ID.driftResolved, ID.itemFresh, 'required_fields', 'meta_description', 'resolved'),
    ])
    .onConflictDoNothing({ target: contentDrifts.id });
  log('3 drifts (2 open, 1 resolved)');

  // ── Staged change inside its veto window ─────────────────────────────────
  // Re-running refreshes the deadline so the demo never shows an expired window.
  const autoCommitAt = new Date(Date.now() + 4 * 60 * 60 * 1000);
  const stagedBefore = itemRows[2]!.data as Record<string, unknown>;
  const stagedPatch = {
    title: 'Quarterly product update — refreshed by Writer',
    body: 'Rewritten body: sharper summary of the quarter, new feature highlights and a clear call to action.',
  };
  await db
    .insert(revisions)
    .values({
      id: ID.revStaged,
      siteId: SITE,
      itemId: ID.itemStaged,
      collectionId: ID.collection,
      delta: { before: stagedBefore, after: { ...stagedBefore, ...stagedPatch }, patch: stagedPatch },
      authorType: 'agent',
      createdByRunId: ID.run,
      model: MODEL,
      constitutionHash: CONSTITUTION_HASH,
      confidence: 0.91,
      staged: true,
      autoCommitAt,
    })
    .onConflictDoUpdate({ target: revisions.id, set: { autoCommitAt } });
  await db
    .insert(agentApprovals)
    .values({
      id: ID.aprVeto,
      siteId: SITE,
      runId: ID.run,
      subjectType: 'staged_revision',
      subjectId: ID.revStaged,
      status: 'pending',
      approvalPolicy: 'veto_window',
      kind: 'veto',
      autoCommitAt,
      requestedByAgent: 'writer',
    })
    .onConflictDoUpdate({
      target: agentApprovals.id,
      set: { status: 'pending', autoCommitAt, decidedBy: null, decidedAt: null, decisionReason: null },
    });
  log('staged revision + veto approval (window: 4h from now)');

  // ── An ordinary pending approval for the inbox ───────────────────────────
  await db
    .insert(agentApprovals)
    .values({
      id: ID.aprSchema,
      siteId: SITE,
      runId: ID.run,
      subjectType: 'tool_call',
      subjectId: 'cosdemo_toolcall_schema',
      status: 'pending',
      kind: 'approval',
      requestedByAgent: 'planner',
    })
    .onConflictDoUpdate({
      target: agentApprovals.id,
      set: { status: 'pending', decidedBy: null, decidedAt: null, decisionReason: null },
    });
  log('pending approval (planner → tool_call)');

  // ── Open incidents ───────────────────────────────────────────────────────
  await db
    .insert(agentIncidents)
    .values([
      {
        id: ID.incVeto,
        siteId: SITE,
        agentRole: 'writer',
        capability: 'items:update',
        source: 'veto',
        severity: 'medium',
        runId: ID.run,
        detail: { demo: true, reason: 'Editor vetoed a tone-deaf rewrite.' },
      },
      {
        id: ID.incLoad,
        siteId: SITE,
        agentRole: 'translator',
        capability: 'items:write',
        source: 'load_guard',
        severity: 'high',
        detail: { demo: true, signal: 'db_latency', thresholdMs: 250 },
      },
    ])
    .onConflictDoNothing({ target: agentIncidents.id });
  log('2 open incidents (veto, load_guard)');

  // ── Autonomy grants across the ladder ────────────────────────────────────
  await db
    .insert(agentAutonomyGrants)
    .values([
      {
        id: ID.grantWriter,
        siteId: SITE,
        agentRole: 'writer',
        capability: 'items:update',
        level: 3,
        evidence: { demo: true, evalStreak: 24, approveRate: 0.97 },
      },
      {
        id: ID.grantTranslator,
        siteId: SITE,
        agentRole: 'translator',
        capability: 'items:write',
        level: 4,
        evidence: { demo: true, evalStreak: 51, approveRate: 0.99 },
      },
      {
        id: ID.grantSeo,
        siteId: SITE,
        agentRole: 'seo',
        capability: 'items:update',
        level: 1,
        evidence: { demo: true, note: 'demoted after incident' },
      },
    ])
    .onConflictDoNothing({ target: agentAutonomyGrants.id });
  log('3 autonomy grants (L1/L3/L4)');

  // ── Constitution: activate only when the site has no active version ──────
  const [activeConstitution] = await db
    .select({ id: constitutions.id })
    .from(constitutions)
    .where(and(eq(constitutions.siteId, SITE), eq(constitutions.status, 'active')))
    .limit(1);
  await db
    .insert(constitutions)
    .values({
      id: ID.constitution,
      siteId: SITE,
      version: 1,
      evaluators: [
        {
          id: 'tone-of-voice',
          type: 'llm_judge',
          scope: { collection: COLLECTION_NAME },
          prompt: 'Confident, concrete, no hype adjectives. Score 0-1.',
          threshold: 0.7,
          severity: 'blocking',
        },
        {
          id: 'meta-length',
          type: 'rule',
          scope: { collection: COLLECTION_NAME },
          rule: { field: 'meta_description', maxLength: 160 },
          severity: 'warning',
        },
      ],
      hash: CONSTITUTION_HASH,
      status: activeConstitution ? 'draft' : 'active',
      activatedAt: activeConstitution ? null : new Date(),
    })
    .onConflictDoNothing({ target: constitutions.id });
  log(`constitution v1 (${activeConstitution ? 'draft — site already has an active one' : 'active'})`);

  // ── Provenance trail on the fresh item ───────────────────────────────────
  await db
    .insert(revisions)
    .values([
      {
        id: ID.revHuman,
        siteId: SITE,
        itemId: ID.itemFresh,
        collectionId: ID.collection,
        delta: { before: null, after: { title: 'Edge caching explained', body: 'First human draft.' } },
        authorType: 'human',
      },
      {
        id: ID.revAgent,
        siteId: SITE,
        itemId: ID.itemFresh,
        collectionId: ID.collection,
        delta: {
          before: { title: 'Edge caching explained', body: 'First human draft.' },
          after: itemRows[0]!.data,
        },
        authorType: 'agent',
        createdByRunId: ID.run,
        model: MODEL,
        constitutionHash: CONSTITUTION_HASH,
        confidence: 0.94,
      },
    ])
    .onConflictDoNothing({ target: revisions.id });
  log('human + agent revisions with provenance');

  // ── Feature flags: only insert when the site has none ────────────────────
  await db
    .insert(settings)
    .values({
      siteId: SITE,
      key: 'contentOs',
      value: { reconciler: true, vetoWindow: true, agentReview: false, mcp: false },
      scope: 'site',
    })
    .onConflictDoNothing({ target: [settings.siteId, settings.key] });
  log('contentOs feature flags (kept as-is when already configured)');

  await client.end();
  console.log('[seed-content-os-demo] Done — open Studio → Mission Control.');
}

main().catch((err) => {
  console.error('[seed-content-os-demo] Failed:', err);
  process.exit(1);
});
