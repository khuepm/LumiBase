/**
 * One-shot translation generator for a new locale (#714, epic #671 A06).
 *
 *   createLocaleJob     validate, scaffold the `locales` setting, queue a job
 *   runLocaleJobStep    claim a short lease → translate the next chunk → write
 *                       SUGGESTIONS (never content) → advance the cursor
 *   driveLocaleJob      steps until done or the time budget is spent
 *   runLocaleJobTick    cron: resume jobs whose lease expired
 *   decideSuggestion    human review: approve (writes through the reviewer's
 *                       ItemService → revision + audit) / reject
 *
 * HITL: machine output lives only in `translation_suggestions` until a person
 * approves it. Approval re-reads the item and refuses (`stale`) when the
 * source text changed or someone already wrote the target locale since the
 * suggestion was made, so a review can never overwrite newer human work.
 *
 * Source text is read on the system connection, site-scoped; suggestions are
 * served only on the control-plane route `/api/v1/locale-generation` (site
 * administrators). Every write to content runs under the reviewer's own
 * permissions.
 */

import {
  collections,
  fields,
  glossary,
  items,
  localeGenerationJobs,
  settings,
  translationMemory,
  translationSuggestions,
  translations,
  type Database,
} from '@lumibase/database';
import { TM_DEFAULT_THRESHOLD } from '@lumibase/contracts';
import { and, asc, count, eq, gt, inArray, isNull, lt, notInArray, or, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { TranslationMemoryService, type GlossaryHit, type MtProvider, type TmEntry } from './translation-memory';

export const TRANSLATABLE_INTERFACE = 'translatable-text';
export const UI_NAMESPACE = 'ui';
export const LOCALE_RE = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-(?:[A-Z]{2}|\d{3}))?$/;
export const LOCALE_JOB_TERMINAL = ['succeeded', 'failed', 'cancelled'] as const;
const ACTIVE = ['queued', 'running'];

export interface LocaleJobConfig {
  /** Items per chunk. */
  chunkSize: number;
  leaseMs: number;
  /** Most collections one job may cover. */
  maxCollections: number;
}

export const DEFAULT_LOCALE_JOB_CONFIG: LocaleJobConfig = { chunkSize: 50, leaseMs: 120_000, maxCollections: 50 };

export class LocaleGenerationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = 'LocaleGenerationError';
  }
}

type JobRow = typeof localeGenerationJobs.$inferSelect;
type SuggestionRow = typeof translationSuggestions.$inferSelect;

export interface LocaleJobCursor {
  phase: 'ui' | 'items' | 'done';
  collectionIndex: number;
  afterId: string | null;
}

export interface LocaleJobCounters {
  items: number;
  suggestions: number;
  fromTm: number;
  fromMt: number;
  skipped: number;
  failed: number;
}

const EMPTY_COUNTERS: LocaleJobCounters = { items: 0, suggestions: 0, fromTm: 0, fromMt: 0, skipped: 0, failed: 0 };

export interface LocaleJobView {
  id: string;
  locale: string;
  sourceLocale: string;
  collections: string[];
  includeUi: boolean;
  provider: string | null;
  status: string;
  cursor: LocaleJobCursor;
  counters: LocaleJobCounters;
  /** Suggestions of this job by review state. */
  review?: Record<string, number>;
  message: string | null;
  createdBy: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export function toLocaleJobView(row: JobRow, review?: Record<string, number>): LocaleJobView {
  return {
    id: row.id,
    locale: row.locale,
    sourceLocale: row.sourceLocale,
    collections: Array.isArray(row.collections) ? (row.collections as string[]) : [],
    includeUi: row.includeUi,
    provider: row.provider,
    status: row.status,
    cursor: readCursor(row),
    counters: readCounters(row),
    ...(review ? { review } : {}),
    message: row.message,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

function readCursor(row: Pick<JobRow, 'cursor' | 'includeUi'>): LocaleJobCursor {
  const raw = (row.cursor ?? {}) as Partial<LocaleJobCursor>;
  return {
    phase: raw.phase ?? (row.includeUi ? 'ui' : 'items'),
    collectionIndex: typeof raw.collectionIndex === 'number' ? raw.collectionIndex : 0,
    afterId: typeof raw.afterId === 'string' ? raw.afterId : null,
  };
}

function readCounters(row: Pick<JobRow, 'counters'>): LocaleJobCounters {
  const raw = (row.counters ?? {}) as Partial<LocaleJobCounters>;
  return { ...EMPTY_COUNTERS, ...Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === 'number')) };
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const hasText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

export function itemTargetKey(collection: string, itemId: string, field: string): string {
  return `item:${collection}:${itemId}:${field}`;
}
export function uiTargetKey(namespace: string, key: string): string {
  return `ui:${namespace}:${key}`;
}

// ── Locale setting ──────────────────────────────────────────────────────────

/** Adds `locale` to `settings.locales.supported` (idempotent). */
export async function scaffoldLocaleSetting(db: Database, siteId: string, locale: string): Promise<string[]> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(and(eq(settings.siteId, siteId), eq(settings.key, 'locales')))
    .limit(1);
  const value = isPlainObject(row?.value) ? (row!.value as Record<string, unknown>) : {};
  const current = Array.isArray(value['supported'])
    ? (value['supported'] as unknown[]).filter((l): l is string => typeof l === 'string')
    : ['en', 'vi'];
  if (current.includes(locale)) return current;
  const supported = [...current, locale];
  const next = { ...value, supported };
  await db
    .insert(settings)
    .values({ siteId, key: 'locales', value: next, scope: 'site' })
    .onConflictDoUpdate({ target: [settings.siteId, settings.key], set: { value: next, updatedAt: new Date() } });
  return supported;
}

// ── Create ──────────────────────────────────────────────────────────────────

export interface CreateLocaleJobInput {
  locale: string;
  sourceLocale: string;
  collections: string[];
  includeUi: boolean;
  provider?: string | null;
}

export async function createLocaleJob(
  db: Database,
  siteId: string,
  input: CreateLocaleJobInput,
  createdBy: string | null,
  config: LocaleJobConfig = DEFAULT_LOCALE_JOB_CONFIG,
): Promise<JobRow> {
  if (!LOCALE_RE.test(input.locale) || !LOCALE_RE.test(input.sourceLocale)) {
    throw new LocaleGenerationError('VALIDATION', 'locale and sourceLocale must look like "ja" or "pt-BR".');
  }
  if (input.locale === input.sourceLocale) {
    throw new LocaleGenerationError('VALIDATION', 'locale must differ from sourceLocale.');
  }
  const wanted = [...new Set(input.collections)];
  if (wanted.length === 0 && !input.includeUi) {
    throw new LocaleGenerationError('VALIDATION', 'Choose at least one collection or include UI strings.');
  }
  if (wanted.length > config.maxCollections) {
    throw new LocaleGenerationError('VALIDATION', `At most ${config.maxCollections} collections per job.`);
  }
  if (wanted.length > 0) {
    const translatable = await translatableFieldsByCollection(db, siteId, wanted);
    const missing = wanted.filter((name) => !translatable.has(name));
    if (missing.length > 0) {
      throw new LocaleGenerationError(
        'NO_TRANSLATABLE_FIELDS',
        `Not a collection with translatable-text fields: ${missing.join(', ')}`,
      );
    }
  }
  const [active] = await db
    .select({ id: localeGenerationJobs.id })
    .from(localeGenerationJobs)
    .where(
      and(
        eq(localeGenerationJobs.siteId, siteId),
        eq(localeGenerationJobs.locale, input.locale),
        inArray(localeGenerationJobs.status, ACTIVE),
      ),
    )
    .limit(1);
  if (active) {
    throw new LocaleGenerationError('JOB_ACTIVE', `A generation job for "${input.locale}" is already running (${active.id}).`, 409);
  }

  await scaffoldLocaleSetting(db, siteId, input.locale);
  const [row] = await db
    .insert(localeGenerationJobs)
    .values({
      siteId,
      locale: input.locale,
      sourceLocale: input.sourceLocale,
      collections: wanted,
      includeUi: input.includeUi,
      provider: input.provider ?? null,
      cursor: { phase: input.includeUi ? 'ui' : 'items', collectionIndex: 0, afterId: null } satisfies LocaleJobCursor,
      counters: EMPTY_COUNTERS,
      createdBy,
    })
    .returning();
  return row!;
}

/** collection name → { id, translatable field names } for the names given. */
async function translatableFieldsByCollection(
  db: Database,
  siteId: string,
  names: string[],
): Promise<Map<string, { id: string; fields: string[] }>> {
  if (names.length === 0) return new Map();
  const rows = await db
    .select({ collectionId: collections.id, collection: collections.name, field: fields.name })
    .from(fields)
    .innerJoin(collections, eq(fields.collectionId, collections.id))
    .where(
      and(
        eq(collections.siteId, siteId),
        eq(fields.siteId, siteId),
        inArray(collections.name, names),
        eq(fields.interface, TRANSLATABLE_INTERFACE),
      ),
    );
  const out = new Map<string, { id: string; fields: string[] }>();
  for (const row of rows) {
    const entry = out.get(row.collection) ?? { id: row.collectionId, fields: [] };
    entry.fields.push(row.field);
    out.set(row.collection, entry);
  }
  return out;
}

// ── Process ────────────────────────────────────────────────────────────────

export interface LocaleJobDeps {
  db: Database;
  providers: Map<string, MtProvider>;
  defaultProvider: string;
  config?: LocaleJobConfig;
}

export type LocaleStepOutcome = 'progressed' | 'done' | 'busy';

async function loadPairMemory(db: Database, siteId: string, from: string, to: string) {
  const [tmRows, glossaryRows] = await Promise.all([
    db
      .select()
      .from(translationMemory)
      .where(and(eq(translationMemory.siteId, siteId), eq(translationMemory.sourceLang, from), eq(translationMemory.targetLang, to))),
    db
      .select()
      .from(glossary)
      .where(and(eq(glossary.siteId, siteId), eq(glossary.sourceLang, from), eq(glossary.targetLang, to))),
  ]);
  const tm: TmEntry[] = tmRows.map((r) => ({ id: r.id, sourceText: r.sourceText, targetText: r.targetText, quality: r.quality, context: r.context }));
  const glossaryHits: GlossaryHit[] = glossaryRows.map((g) => ({
    term: g.term,
    translation: g.translation,
    rule: g.rule as GlossaryHit['rule'],
  }));
  return { tm, glossary: glossaryHits };
}

async function finish(db: Database, job: JobRow, owner: string, status: 'succeeded' | 'failed' | 'cancelled', message: string | null, counters: LocaleJobCounters, cursor: LocaleJobCursor) {
  const now = new Date();
  await db
    .update(localeGenerationJobs)
    .set({ status, message, counters, cursor, finishedAt: now, updatedAt: now, leaseOwner: null, leaseUntil: null })
    .where(and(eq(localeGenerationJobs.id, job.id), eq(localeGenerationJobs.leaseOwner, owner)));
}

/**
 * One chunk. `busy` when another worker holds a live lease, `done` when the
 * job is (now) terminal, `progressed` otherwise.
 */
export async function runLocaleJobStep(deps: LocaleJobDeps, jobId: string): Promise<LocaleStepOutcome> {
  const { db } = deps;
  const config = deps.config ?? DEFAULT_LOCALE_JOB_CONFIG;
  const owner = nanoid();
  const now = new Date();
  const [job] = await db
    .update(localeGenerationJobs)
    .set({
      leaseOwner: owner,
      leaseUntil: new Date(now.getTime() + config.leaseMs),
      status: 'running',
      startedAt: sql`coalesce(${localeGenerationJobs.startedAt}, now())`,
      updatedAt: now,
    })
    .where(
      and(
        eq(localeGenerationJobs.id, jobId),
        inArray(localeGenerationJobs.status, ACTIVE),
        or(isNull(localeGenerationJobs.leaseUntil), lt(localeGenerationJobs.leaseUntil, now)),
      ),
    )
    .returning();
  if (!job) {
    const [row] = await db.select({ status: localeGenerationJobs.status }).from(localeGenerationJobs).where(eq(localeGenerationJobs.id, jobId)).limit(1);
    return !row || (LOCALE_JOB_TERMINAL as readonly string[]).includes(row.status) ? 'done' : 'busy';
  }

  const cursor = readCursor(job);
  const counters = readCounters(job);
  if (job.cancelRequestedAt) {
    await finish(db, job, owner, 'cancelled', 'Cancelled by request.', counters, cursor);
    return 'done';
  }

  const providerName = job.provider ?? deps.defaultProvider;
  if (!deps.providers.has(providerName)) {
    await finish(db, job, owner, 'failed', `MT provider not available: ${providerName}`, counters, cursor);
    return 'done';
  }
  const translator = new TranslationMemoryService(deps.providers, { defaultProvider: providerName, tmThreshold: TM_DEFAULT_THRESHOLD });
  const memory = await loadPairMemory(db, job.siteId, job.sourceLocale, job.locale);
  let lastError: string | null = null;

  const suggest = async (base: Omit<typeof translationSuggestions.$inferInsert, 'suggestedText' | 'origin' | 'provider' | 'tmScore' | 'siteId' | 'jobId' | 'locale' | 'sourceLocale'>) => {
    try {
      const result = await translator.translate({
        text: base.sourceText,
        from: job.sourceLocale,
        to: job.locale,
        tm: memory.tm,
        glossary: memory.glossary,
        provider: providerName,
      });
      const inserted = await db
        .insert(translationSuggestions)
        .values({
          ...base,
          siteId: job.siteId,
          jobId: job.id,
          locale: job.locale,
          sourceLocale: job.sourceLocale,
          suggestedText: result.text,
          origin: result.source,
          provider: result.source === 'mt' ? (result.provider ?? providerName) : null,
          tmScore: result.tmScore ?? null,
        })
        .onConflictDoNothing()
        .returning({ id: translationSuggestions.id });
      if (inserted.length === 0) {
        counters.skipped += 1;
        return;
      }
      counters.suggestions += 1;
      if (result.source === 'tm') counters.fromTm += 1;
      else counters.fromMt += 1;
    } catch (err) {
      counters.failed += 1;
      lastError = err instanceof Error ? err.message : String(err);
    }
  };

  try {
    if (cursor.phase === 'ui') {
      const sources = await db
        .select()
        .from(translations)
        .where(
          and(
            eq(translations.siteId, job.siteId),
            eq(translations.namespace, UI_NAMESPACE),
            eq(translations.language, job.sourceLocale),
            cursor.afterId ? gt(translations.id, cursor.afterId) : undefined,
          ),
        )
        .orderBy(asc(translations.id))
        .limit(config.chunkSize);
      if (sources.length === 0) {
        Object.assign(cursor, { phase: 'items', collectionIndex: 0, afterId: null });
      } else {
        const existing = new Set(
          (
            await db
              .select({ key: translations.key })
              .from(translations)
              .where(
                and(
                  eq(translations.siteId, job.siteId),
                  eq(translations.namespace, UI_NAMESPACE),
                  eq(translations.language, job.locale),
                  inArray(translations.key, sources.map((s) => s.key)),
                ),
              )
          ).map((r) => r.key),
        );
        for (const source of sources) {
          if (existing.has(source.key) || !hasText(source.value)) {
            counters.skipped += 1;
            continue;
          }
          await suggest({
            kind: 'ui',
            targetKey: uiTargetKey(UI_NAMESPACE, source.key),
            uiNamespace: UI_NAMESPACE,
            uiKey: source.key,
            sourceText: source.value,
          });
        }
        cursor.afterId = sources[sources.length - 1]!.id;
      }
    } else if (cursor.phase === 'items') {
      const names = Array.isArray(job.collections) ? (job.collections as string[]) : [];
      const name = names[cursor.collectionIndex];
      if (name === undefined) {
        cursor.phase = 'done';
      } else {
        const meta = (await translatableFieldsByCollection(db, job.siteId, [name])).get(name);
        const rows = meta
          ? await db
              .select({ id: items.id, data: items.data })
              .from(items)
              .where(
                and(
                  eq(items.siteId, job.siteId),
                  eq(items.collectionId, meta.id),
                  sql`${items.deletedAt} is null`,
                  cursor.afterId ? gt(items.id, cursor.afterId) : undefined,
                ),
              )
              .orderBy(asc(items.id))
              .limit(config.chunkSize)
          : [];
        if (rows.length === 0) {
          Object.assign(cursor, { collectionIndex: cursor.collectionIndex + 1, afterId: null });
        } else {
          for (const row of rows) {
            counters.items += 1;
            const data = isPlainObject(row.data) ? row.data : {};
            for (const field of meta!.fields) {
              const map = data[field];
              if (!isPlainObject(map) || !hasText(map[job.sourceLocale]) || hasText(map[job.locale])) {
                counters.skipped += 1;
                continue;
              }
              await suggest({
                kind: 'item',
                targetKey: itemTargetKey(name, row.id, field),
                collection: name,
                itemId: row.id,
                field,
                sourceText: map[job.sourceLocale] as string,
              });
            }
          }
          cursor.afterId = rows[rows.length - 1]!.id;
        }
      }
    }
  } catch (err) {
    await finish(db, job, owner, 'failed', err instanceof Error ? err.message : String(err), counters, cursor);
    return 'done';
  }

  if (cursor.phase === 'done') {
    const message =
      counters.failed > 0 ? `${counters.failed} value(s) could not be translated; last error: ${lastError ?? job.message ?? 'unknown'}` : null;
    await finish(db, job, owner, 'succeeded', message, counters, cursor);
    return 'done';
  }
  // Release the lease with the new cursor, only while we still own it.
  await db
    .update(localeGenerationJobs)
    .set({ cursor, counters, leaseOwner: null, leaseUntil: null, updatedAt: new Date(), ...(lastError ? { message: lastError } : {}) })
    .where(and(eq(localeGenerationJobs.id, job.id), eq(localeGenerationJobs.leaseOwner, owner)));
  return 'progressed';
}

export async function driveLocaleJob(deps: LocaleJobDeps, jobId: string, budgetMs: number): Promise<LocaleStepOutcome> {
  const deadline = Date.now() + budgetMs;
  let outcome: LocaleStepOutcome = 'progressed';
  while (Date.now() < deadline) {
    outcome = await runLocaleJobStep(deps, jobId);
    if (outcome !== 'progressed') break;
  }
  return outcome;
}

/** Cron entry: resume unfinished jobs with a free lease, oldest first, across sites. */
export async function runLocaleJobTick(
  deps: LocaleJobDeps,
  options: { budgetMs: number },
): Promise<{ resumed: number }> {
  const deadline = Date.now() + options.budgetMs;
  const now = new Date();
  const due = await deps.db
    .select({ id: localeGenerationJobs.id })
    .from(localeGenerationJobs)
    .where(
      and(
        inArray(localeGenerationJobs.status, ACTIVE),
        or(isNull(localeGenerationJobs.leaseUntil), lt(localeGenerationJobs.leaseUntil, now)),
      ),
    )
    .orderBy(asc(localeGenerationJobs.createdAt))
    .limit(20);
  let resumed = 0;
  for (const job of due) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    await driveLocaleJob(deps, job.id, left);
    resumed += 1;
  }
  return { resumed };
}

// ── Job management ──────────────────────────────────────────────────────────

export async function listLocaleJobs(db: Database, siteId: string): Promise<LocaleJobView[]> {
  const rows = await db
    .select()
    .from(localeGenerationJobs)
    .where(eq(localeGenerationJobs.siteId, siteId))
    .orderBy(sql`${localeGenerationJobs.createdAt} desc`)
    .limit(50);
  return rows.map((row) => toLocaleJobView(row));
}

export async function getLocaleJob(db: Database, siteId: string, id: string): Promise<LocaleJobView> {
  const [row] = await db
    .select()
    .from(localeGenerationJobs)
    .where(and(eq(localeGenerationJobs.siteId, siteId), eq(localeGenerationJobs.id, id)))
    .limit(1);
  if (!row) throw new LocaleGenerationError('NOT_FOUND', 'Generation job not found.', 404);
  const review = await db
    .select({ status: translationSuggestions.status, n: count() })
    .from(translationSuggestions)
    .where(and(eq(translationSuggestions.siteId, siteId), eq(translationSuggestions.jobId, id)))
    .groupBy(translationSuggestions.status);
  return toLocaleJobView(row, Object.fromEntries(review.map((r) => [r.status, Number(r.n)])));
}

export async function cancelLocaleJob(db: Database, siteId: string, id: string): Promise<LocaleJobView> {
  const [row] = await db
    .update(localeGenerationJobs)
    .set({ cancelRequestedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(localeGenerationJobs.siteId, siteId), eq(localeGenerationJobs.id, id), inArray(localeGenerationJobs.status, ACTIVE)))
    .returning();
  if (!row) {
    await getLocaleJob(db, siteId, id); // 404 when missing
    throw new LocaleGenerationError('NOT_ACTIVE', 'Only a queued or running job can be cancelled.', 409);
  }
  return toLocaleJobView(row);
}

/** Puts a failed or cancelled job back in the queue at its cursor. */
export async function resumeLocaleJob(db: Database, siteId: string, id: string): Promise<LocaleJobView> {
  const [row] = await db
    .update(localeGenerationJobs)
    .set({ status: 'queued', cancelRequestedAt: null, finishedAt: null, message: null, leaseOwner: null, leaseUntil: null, updatedAt: new Date() })
    .where(
      and(
        eq(localeGenerationJobs.siteId, siteId),
        eq(localeGenerationJobs.id, id),
        inArray(localeGenerationJobs.status, ['failed', 'cancelled']),
      ),
    )
    .returning();
  if (!row) {
    await getLocaleJob(db, siteId, id);
    throw new LocaleGenerationError('NOT_RESUMABLE', 'Only a failed or cancelled job can be resumed.', 409);
  }
  return toLocaleJobView(row);
}

// ── Review ──────────────────────────────────────────────────────────────────

export interface SuggestionFilter {
  locale?: string;
  status?: string;
  jobId?: string;
  collection?: string;
  limit: number;
  offset: number;
}

export async function listSuggestions(db: Database, siteId: string, filter: SuggestionFilter) {
  const where = and(
    eq(translationSuggestions.siteId, siteId),
    filter.locale ? eq(translationSuggestions.locale, filter.locale) : undefined,
    filter.status ? eq(translationSuggestions.status, filter.status) : undefined,
    filter.jobId ? eq(translationSuggestions.jobId, filter.jobId) : undefined,
    filter.collection ? eq(translationSuggestions.collection, filter.collection) : undefined,
  );
  const [rows, total] = await Promise.all([
    db
      .select()
      .from(translationSuggestions)
      .where(where)
      .orderBy(asc(translationSuggestions.createdAt), asc(translationSuggestions.id))
      .limit(filter.limit)
      .offset(filter.offset),
    db.select({ n: count() }).from(translationSuggestions).where(where),
  ]);
  return { rows, total: Number(total[0]?.n ?? 0) };
}

/** What review needs from the item service: the reviewer's own permissions. */
export interface ReviewItemAccess {
  detail(collection: string, id: string): Promise<unknown>;
  patch(collection: string, id: string, patch: { data: Record<string, unknown> }): Promise<unknown>;
}

export type SuggestionDecision =
  | { decision: 'approve'; text?: string }
  | { decision: 'reject' };

export interface DecisionResult {
  id: string;
  status: 'approved' | 'rejected' | 'stale';
  reason?: string;
}

function itemData(detail: unknown): Record<string, unknown> {
  if (!isPlainObject(detail)) return {};
  const inner = detail['data'];
  return isPlainObject(inner) ? inner : detail;
}

/**
 * Applies one human decision. The claim (`pending` → decided) is conditional,
 * so a double click or two reviewers race to one write.
 */
export async function decideSuggestion(
  db: Database,
  siteId: string,
  id: string,
  decision: SuggestionDecision,
  reviewer: { userId: string | null },
  itemAccess: ReviewItemAccess,
): Promise<DecisionResult> {
  const [row] = await db
    .select()
    .from(translationSuggestions)
    .where(and(eq(translationSuggestions.siteId, siteId), eq(translationSuggestions.id, id)))
    .limit(1);
  if (!row) throw new LocaleGenerationError('NOT_FOUND', 'Suggestion not found.', 404);
  if (row.status !== 'pending') {
    throw new LocaleGenerationError('ALREADY_DECIDED', `Suggestion is already ${row.status}.`, 409);
  }

  const settle = async (status: DecisionResult['status'], approvedText: string | null) => {
    const [claimed] = await db
      .update(translationSuggestions)
      .set({ status, approvedText, reviewedBy: reviewer.userId, reviewedAt: new Date() })
      .where(and(eq(translationSuggestions.siteId, siteId), eq(translationSuggestions.id, id), eq(translationSuggestions.status, 'pending')))
      .returning({ id: translationSuggestions.id });
    if (!claimed) throw new LocaleGenerationError('ALREADY_DECIDED', 'Suggestion was decided concurrently.', 409);
  };

  if (decision.decision === 'reject') {
    await settle('rejected', null);
    return { id, status: 'rejected' };
  }

  const text = decision.text?.trim() ? decision.text : row.suggestedText;
  if (row.kind === 'ui') {
    await settle('approved', text);
    await db
      .insert(translations)
      .values({ siteId, language: row.locale, namespace: row.uiNamespace ?? UI_NAMESPACE, key: row.uiKey!, value: text })
      .onConflictDoNothing();
    await learn(db, row, text, Boolean(decision.text?.trim()));
    return { id, status: 'approved' };
  }

  // Item: re-read under the reviewer's permissions, refuse stale work.
  const data = itemData(await itemAccess.detail(row.collection!, row.itemId!));
  const map = data[row.field!];
  if (!isPlainObject(map) || map[row.sourceLocale] !== row.sourceText) {
    await settle('stale', null);
    return { id, status: 'stale', reason: 'The source text changed since the suggestion was made.' };
  }
  if (hasText(map[row.locale])) {
    await settle('stale', null);
    return { id, status: 'stale', reason: `The ${row.locale} value was already written.` };
  }
  // Write first: a refused write (RBAC, validation, pinned field) leaves the
  // suggestion pending and surfaces the error to the reviewer.
  await itemAccess.patch(row.collection!, row.itemId!, { data: { [row.field!]: { ...map, [row.locale]: text } } });
  await settle('approved', text);
  await learn(db, row, text, Boolean(decision.text?.trim()));
  return { id, status: 'approved' };
}

/** A reviewed translation is worth remembering: it feeds the next TM lookup. */
async function learn(db: Database, row: SuggestionRow, text: string, edited: boolean): Promise<void> {
  if (row.origin === 'tm' && !edited) return; // already in memory
  await db.insert(translationMemory).values({
    siteId: row.siteId,
    sourceLang: row.sourceLocale,
    targetLang: row.locale,
    sourceText: row.sourceText,
    targetText: text,
    context: row.kind === 'item' ? `${row.collection}.${row.field}` : `${row.uiNamespace}.${row.uiKey}`,
    quality: edited ? 100 : 90,
    source: edited ? 'human' : 'mt',
    provider: row.provider,
  });
}

/** Ids of pending suggestions matching a filter (bulk review). */
export async function pendingSuggestionIds(
  db: Database,
  siteId: string,
  filter: { locale: string; jobId?: string; collection?: string; excludeIds?: string[] },
  limit: number,
): Promise<string[]> {
  const rows = await db
    .select({ id: translationSuggestions.id })
    .from(translationSuggestions)
    .where(
      and(
        eq(translationSuggestions.siteId, siteId),
        eq(translationSuggestions.locale, filter.locale),
        eq(translationSuggestions.status, 'pending'),
        filter.jobId ? eq(translationSuggestions.jobId, filter.jobId) : undefined,
        filter.collection ? eq(translationSuggestions.collection, filter.collection) : undefined,
        filter.excludeIds?.length ? notInArray(translationSuggestions.id, filter.excludeIds) : undefined,
      ),
    )
    .orderBy(asc(translationSuggestions.createdAt), asc(translationSuggestions.id))
    .limit(limit);
  return rows.map((r) => r.id);
}
