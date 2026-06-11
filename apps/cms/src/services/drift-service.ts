import {
  collections,
  contentDrifts,
  contentIntents,
  glossary,
  items,
  type Database,
} from '@lumibase/database';
import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm';
import type { IntentRule } from './intent-service';

/**
 * DriftService — scans a collection against its intent's rules and records
 * violations as `content_drifts` rows (Content OS Module B).
 *
 * Rule evaluation is a pure function (`evaluateRules`) so pin semantics and
 * fingerprint behaviour are property-testable. Scans are time-boxed: when
 * the budget runs out mid-pass the cursor is persisted on the intent and the
 * next cycle resumes from it (Req 6.5).
 */

// ---------------------------------------------------------------------------
// Pure evaluation
// ---------------------------------------------------------------------------

export interface DriftViolation {
  ruleType: IntentRule['type'];
  /** Disambiguates violations within a rule type (field name, locale…). */
  ruleKey: string;
  /** Field the violation is scoped to, when field-scoped. */
  field?: string;
  detail: Record<string, unknown>;
}

export interface DriftItemView {
  id: string;
  data: Record<string, unknown>;
  updatedAt: Date;
  pinnedFields: string[];
}

export interface DriftEvaluationContext {
  now?: Date;
  /** Lower-cased forbidden glossary terms (rule='forbidden'). */
  forbiddenTerms?: string[];
}

export function driftFingerprint(
  intentId: string,
  itemId: string,
  ruleType: string,
  ruleKey: string,
): string {
  return `${intentId}:${itemId}:${ruleType}:${ruleKey}`;
}

const MS_PER_DAY = 86_400_000;

function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** Extracts http(s)-looking tokens from a string value. */
function extractUrlTokens(value: string): string[] {
  return value.match(/https?:\/\/[^\s"'<>)\]]+/gi) ?? [];
}

function stringFields(data: Record<string, unknown>): string[] {
  return Object.keys(data).filter((key) => typeof data[key] === 'string');
}

/**
 * Evaluates intent rules against one item. Pinned fields never produce
 * field-scoped violations — a human pin removes the field from the
 * reconciler's jurisdiction entirely (Property 5 / Req 6.4).
 */
export function evaluateRules(
  rules: IntentRule[],
  item: DriftItemView,
  context: DriftEvaluationContext = {},
): DriftViolation[] {
  const now = context.now ?? new Date();
  const pinned = new Set(item.pinnedFields);
  const violations: DriftViolation[] = [];

  for (const rule of rules) {
    switch (rule.type) {
      case 'required_fields': {
        for (const field of rule.fields) {
          if (pinned.has(field)) continue;
          if (isEmptyValue(item.data[field])) {
            violations.push({
              ruleType: rule.type,
              ruleKey: field,
              field,
              detail: { reason: 'missing_or_empty' },
            });
          }
        }
        break;
      }
      case 'freshness': {
        const ageDays = (now.getTime() - item.updatedAt.getTime()) / MS_PER_DAY;
        if (ageDays > rule.maxAgeDays) {
          violations.push({
            ruleType: rule.type,
            ruleKey: 'age',
            detail: { ageDays: Math.floor(ageDays), maxAgeDays: rule.maxAgeDays },
          });
        }
        break;
      }
      case 'translations': {
        // Convention: a translatable field stores an object keyed by locale
        // ({ vi: '…', en: '…' }). Without explicit fields the rule checks
        // the item-level `translations` object.
        const fields = rule.fields ?? ['translations'];
        for (const field of fields) {
          if (pinned.has(field)) continue;
          const value = item.data[field];
          const record =
            value && typeof value === 'object' && !Array.isArray(value)
              ? (value as Record<string, unknown>)
              : {};
          for (const locale of rule.locales) {
            if (isEmptyValue(record[locale])) {
              violations.push({
                ruleType: rule.type,
                ruleKey: `${field}:${locale}`,
                field,
                detail: { locale, reason: 'missing_translation' },
              });
            }
          }
        }
        break;
      }
      case 'link_health': {
        // v1 checks URL well-formedness only — cheap and deterministic.
        // Fetch-based liveness belongs in a queue-backed checker later.
        const fields = rule.fields ?? stringFields(item.data);
        for (const field of fields) {
          if (pinned.has(field)) continue;
          const value = item.data[field];
          if (typeof value !== 'string') continue;
          const broken = extractUrlTokens(value).filter((token) => {
            try {
              new URL(token);
              return false;
            } catch {
              return true;
            }
          });
          if (broken.length > 0) {
            violations.push({
              ruleType: rule.type,
              ruleKey: field,
              field,
              detail: { brokenUrls: broken.slice(0, 10) },
            });
          }
        }
        break;
      }
      case 'field_constraint': {
        const field = rule.field;
        if (pinned.has(field)) break;
        const value = item.data[field];
        if (typeof value !== 'string') break;
        const reasons: string[] = [];
        if (rule.minLength !== undefined && value.length < rule.minLength) {
          reasons.push(`shorter than ${rule.minLength}`);
        }
        if (rule.maxLength !== undefined && value.length > rule.maxLength) {
          reasons.push(`longer than ${rule.maxLength}`);
        }
        if (rule.pattern !== undefined) {
          try {
            if (!new RegExp(rule.pattern).test(value)) {
              reasons.push('pattern mismatch');
            }
          } catch {
            // Invalid pattern in the rule — never turn a bad rule into drift.
          }
        }
        if (reasons.length > 0) {
          violations.push({
            ruleType: rule.type,
            ruleKey: field,
            field,
            detail: { reasons, length: value.length },
          });
        }
        break;
      }
      case 'glossary_compliance': {
        const terms = context.forbiddenTerms ?? [];
        if (terms.length === 0) break;
        const fields = rule.fields ?? stringFields(item.data);
        for (const field of fields) {
          if (pinned.has(field)) continue;
          const value = item.data[field];
          if (typeof value !== 'string') continue;
          const lower = value.toLowerCase();
          const found = terms.filter((term) => lower.includes(term));
          if (found.length > 0) {
            violations.push({
              ruleType: rule.type,
              ruleKey: field,
              field,
              detail: { forbiddenTerms: found.slice(0, 10) },
            });
          }
        }
        break;
      }
    }
  }
  return violations;
}

/**
 * Diffs detected fingerprints against existing drift rows for the scanned
 * items. Open/assigned drifts are never duplicated (Property 4); violations
 * that disappeared are resolved; previously resolved ones reopen.
 */
export function diffDrifts(
  existing: ReadonlyMap<string, { status: string }>,
  detected: ReadonlySet<string>,
): { toOpen: string[]; toReopen: string[]; toResolve: string[] } {
  const toOpen: string[] = [];
  const toReopen: string[] = [];
  const toResolve: string[] = [];

  for (const fingerprint of detected) {
    const row = existing.get(fingerprint);
    if (!row) {
      toOpen.push(fingerprint);
    } else if (row.status === 'resolved' || row.status === 'stale') {
      toReopen.push(fingerprint);
    }
    // open/assigned: already tracked — never duplicated.
  }
  for (const [fingerprint, row] of existing) {
    if (!detected.has(fingerprint) && (row.status === 'open' || row.status === 'assigned')) {
      toResolve.push(fingerprint);
    }
  }
  return { toOpen, toReopen, toResolve };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface DriftScanOptions {
  /** Wall-clock budget for one scan invocation (Req 6.5). */
  timeBudgetMs?: number;
  batchSize?: number;
}

export interface DriftScanResult {
  scanned: number;
  opened: number;
  reopened: number;
  resolved: number;
  /** False when the time budget expired mid-pass; cursor persisted. */
  completed: boolean;
  cursor: string | null;
}

export class DriftServiceError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
    this.name = 'DriftServiceError';
  }
}

export interface DriftServiceDeps {
  db: Database;
  siteId: string;
}

export class DriftService {
  constructor(private readonly deps: DriftServiceDeps) {}

  async scanIntent(intentId: string, options: DriftScanOptions = {}): Promise<DriftScanResult> {
    const timeBudgetMs = options.timeBudgetMs ?? 10_000;
    const batchSize = Math.min(Math.max(options.batchSize ?? 100, 1), 500);
    const startedAt = Date.now();

    const [intent] = await this.deps.db
      .select()
      .from(contentIntents)
      .where(and(eq(contentIntents.siteId, this.deps.siteId), eq(contentIntents.id, intentId)))
      .limit(1);
    if (!intent) {
      throw new DriftServiceError('NOT_FOUND', 'Intent not found.', 404);
    }
    if (intent.status !== 'active') {
      return { scanned: 0, opened: 0, reopened: 0, resolved: 0, completed: true, cursor: null };
    }

    const [collection] = await this.deps.db
      .select({ id: collections.id })
      .from(collections)
      .where(and(eq(collections.siteId, this.deps.siteId), eq(collections.name, intent.collection)))
      .limit(1);
    if (!collection) {
      throw new DriftServiceError('COLLECTION_NOT_FOUND', `Collection "${intent.collection}" not found.`, 404);
    }

    const rules = (intent.rules ?? []) as IntentRule[];
    const context: DriftEvaluationContext = { now: new Date() };
    if (rules.some((rule) => rule.type === 'glossary_compliance')) {
      context.forbiddenTerms = await this.loadForbiddenTerms();
    }

    const result: DriftScanResult = {
      scanned: 0,
      opened: 0,
      reopened: 0,
      resolved: 0,
      completed: false,
      cursor: intent.scanCursor ?? null,
    };

    let cursor = intent.scanCursor ?? '';
    for (;;) {
      const batch = await this.deps.db
        .select({
          id: items.id,
          data: items.data,
          updatedAt: items.updatedAt,
          pinnedFields: items.pinnedFields,
        })
        .from(items)
        .where(
          and(
            eq(items.siteId, this.deps.siteId),
            eq(items.collectionId, collection.id),
            isNull(items.deletedAt),
            cursor ? gt(items.id, cursor) : undefined,
          ),
        )
        .orderBy(asc(items.id))
        .limit(batchSize);

      if (batch.length === 0) {
        result.completed = true;
        result.cursor = null;
        break;
      }

      await this.applyBatch(intent.id, batch as Array<Record<string, unknown>>, rules, context, result);
      result.scanned += batch.length;
      cursor = batch[batch.length - 1]!.id;
      result.cursor = cursor;

      if (batch.length < batchSize) {
        result.completed = true;
        result.cursor = null;
        break;
      }
      // Time-boxed: persist the cursor and continue next cycle (Req 6.5).
      if (Date.now() - startedAt >= timeBudgetMs) {
        break;
      }
    }

    await this.deps.db
      .update(contentIntents)
      .set({ scanCursor: result.cursor, updatedAt: new Date() })
      .where(and(eq(contentIntents.siteId, this.deps.siteId), eq(contentIntents.id, intentId)));

    return result;
  }

  async listDrifts(filter: { intentId?: string; status?: string } = {}) {
    return this.deps.db
      .select()
      .from(contentDrifts)
      .where(
        and(
          eq(contentDrifts.siteId, this.deps.siteId),
          filter.intentId ? eq(contentDrifts.intentId, filter.intentId) : undefined,
          filter.status ? eq(contentDrifts.status, filter.status) : undefined,
        ),
      )
      .orderBy(asc(contentDrifts.createdAt))
      .limit(500);
  }

  private async loadForbiddenTerms(): Promise<string[]> {
    const rows = await this.deps.db
      .select({ term: glossary.term })
      .from(glossary)
      .where(and(eq(glossary.siteId, this.deps.siteId), eq(glossary.rule, 'forbidden')))
      .limit(1_000);
    return rows.map((row) => row.term.toLowerCase());
  }

  private async applyBatch(
    intentId: string,
    batch: Array<Record<string, unknown>>,
    rules: IntentRule[],
    context: DriftEvaluationContext,
    result: DriftScanResult,
  ): Promise<void> {
    const itemIds = batch.map((row) => row['id'] as string);

    const existingRows = await this.deps.db
      .select({
        fingerprint: contentDrifts.fingerprint,
        status: contentDrifts.status,
      })
      .from(contentDrifts)
      .where(
        and(
          eq(contentDrifts.siteId, this.deps.siteId),
          eq(contentDrifts.intentId, intentId),
          inArray(contentDrifts.itemId, itemIds),
        ),
      );
    const existing = new Map(existingRows.map((row) => [row.fingerprint, { status: row.status }]));

    const detected = new Set<string>();
    const detectedDetail = new Map<string, { itemId: string; violation: DriftViolation }>();
    for (const row of batch) {
      const item: DriftItemView = {
        id: row['id'] as string,
        data: (row['data'] ?? {}) as Record<string, unknown>,
        updatedAt: row['updatedAt'] as Date,
        pinnedFields: Array.isArray(row['pinnedFields']) ? (row['pinnedFields'] as string[]) : [],
      };
      for (const violation of evaluateRules(rules, item, context)) {
        const fingerprint = driftFingerprint(intentId, item.id, violation.ruleType, violation.ruleKey);
        detected.add(fingerprint);
        detectedDetail.set(fingerprint, { itemId: item.id, violation });
      }
    }

    const { toOpen, toReopen, toResolve } = diffDrifts(existing, detected);

    for (const fingerprint of toOpen) {
      const entry = detectedDetail.get(fingerprint)!;
      await this.deps.db.insert(contentDrifts).values({
        siteId: this.deps.siteId,
        intentId,
        itemId: entry.itemId,
        ruleType: entry.violation.ruleType,
        ruleKey: entry.violation.ruleKey,
        fingerprint,
        status: 'open',
        detail: entry.violation.detail,
      });
    }
    if (toReopen.length > 0) {
      await this.deps.db
        .update(contentDrifts)
        .set({ status: 'open', goalId: null, resolvedAt: null, updatedAt: new Date() })
        .where(
          and(
            eq(contentDrifts.siteId, this.deps.siteId),
            inArray(contentDrifts.fingerprint, toReopen),
          ),
        );
    }
    if (toResolve.length > 0) {
      await this.deps.db
        .update(contentDrifts)
        .set({ status: 'resolved', resolvedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(contentDrifts.siteId, this.deps.siteId),
            inArray(contentDrifts.fingerprint, toResolve),
          ),
        );
    }

    result.opened += toOpen.length;
    result.reopened += toReopen.length;
    result.resolved += toResolve.length;
  }
}
