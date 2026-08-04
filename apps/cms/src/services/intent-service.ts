import { contentIntents, type Database } from '@lumibase/database';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { ConfiguredLLM } from './llm-provider';

/**
 * IntentService — CRUD and natural-language compilation for content intents
 * (declared desired state / SLO). Every query is scoped by siteId.
 *
 * Intents are consumed by drift detectors (scan collections against rules)
 * and the reconciler (turn drift into agent goals bounded by autonomyCap
 * and budget).
 */

// ---------------------------------------------------------------------------
// intent-rule.v1 — declarative rule schema
// ---------------------------------------------------------------------------

const ruleSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('required_fields'),
    fields: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    type: z.literal('freshness'),
    maxAgeDays: z.number().int().min(1).max(3650),
  }),
  z.object({
    type: z.literal('translations'),
    locales: z.array(z.string().min(2).max(10)).min(1),
    fields: z.array(z.string().min(1)).optional(),
  }),
  z.object({
    type: z.literal('link_health'),
    fields: z.array(z.string().min(1)).optional(),
  }),
  z.object({
    type: z.literal('field_constraint'),
    field: z.string().min(1),
    minLength: z.number().int().min(0).optional(),
    maxLength: z.number().int().min(1).optional(),
    pattern: z.string().max(500).optional(),
  }),
  z.object({
    type: z.literal('glossary_compliance'),
    glossary: z.string().min(1).optional(),
    fields: z.array(z.string().min(1)).optional(),
  }),
]);

export type IntentRule = z.infer<typeof ruleSchema>;

const budgetSchema = z.object({
  maxGoalsPerCycle: z.number().int().min(1).max(100).default(10),
  maxWritesPerMinute: z.number().int().min(1).max(10_000).default(60),
  maxCostUsd: z.number().min(0).max(1_000).default(1),
});

const maintenanceWindowSchema = z.object({
  tz: z.string().min(1).max(64),
  windows: z
    .array(
      z.object({
        /** 0 (Sunday) – 6 (Saturday). */
        dow: z.number().int().min(0).max(6),
        start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      }),
    )
    .min(1),
});

/** Standard 5-field cron expression (minute hour dom month dow). */
const CRON_PATTERN = /^(\S+\s+){4}\S+$/;

export const intentInputSchema = z.object({
  name: z.string().min(1).max(120),
  collection: z.string().min(1).max(120),
  rules: z.array(ruleSchema).min(1).max(50),
  schedule: z.string().regex(CRON_PATTERN, 'schedule must be a 5-field cron expression'),
  budget: budgetSchema.prefault({}),
  autonomyCap: z.number().int().min(0).max(4).default(2),
  maintenanceWindow: maintenanceWindowSchema.nullish(),
});

export type IntentInput = z.infer<typeof intentInputSchema>;

export class IntentServiceError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
    this.name = 'IntentServiceError';
  }
}

export interface IntentServiceDeps {
  db: Database;
  siteId: string;
  userId?: string | null;
  /** Configured LLM for natural-language rule compilation (optional). */
  llm?: ConfiguredLLM | null;
}

export class IntentService {
  constructor(private readonly deps: IntentServiceDeps) {}

  async list() {
    return this.deps.db
      .select()
      .from(contentIntents)
      .where(eq(contentIntents.siteId, this.deps.siteId))
      .orderBy(desc(contentIntents.createdAt))
      .limit(200);
  }

  async get(id: string) {
    const [intent] = await this.deps.db
      .select()
      .from(contentIntents)
      .where(and(eq(contentIntents.siteId, this.deps.siteId), eq(contentIntents.id, id)))
      .limit(1);
    if (!intent) {
      throw new IntentServiceError('NOT_FOUND', 'Intent not found.', 404);
    }
    return intent;
  }

  async create(input: IntentInput) {
    const parsed = intentInputSchema.parse(input);
    const [intent] = await this.deps.db
      .insert(contentIntents)
      .values({
        siteId: this.deps.siteId,
        name: parsed.name,
        collection: parsed.collection,
        rules: parsed.rules,
        schedule: parsed.schedule,
        budget: parsed.budget,
        autonomyCap: parsed.autonomyCap,
        maintenanceWindow: parsed.maintenanceWindow ?? null,
        createdBy: this.deps.userId ?? null,
      })
      .returning();
    return intent!;
  }

  async update(id: string, input: Partial<IntentInput>) {
    await this.get(id);
    const parsed = intentInputSchema.partial().parse(input);
    const [intent] = await this.deps.db
      .update(contentIntents)
      .set({
        ...(parsed.name !== undefined ? { name: parsed.name } : {}),
        ...(parsed.collection !== undefined ? { collection: parsed.collection } : {}),
        ...(parsed.rules !== undefined ? { rules: parsed.rules } : {}),
        ...(parsed.schedule !== undefined ? { schedule: parsed.schedule } : {}),
        ...(parsed.budget !== undefined ? { budget: parsed.budget } : {}),
        ...(parsed.autonomyCap !== undefined ? { autonomyCap: parsed.autonomyCap } : {}),
        ...(parsed.maintenanceWindow !== undefined
          ? { maintenanceWindow: parsed.maintenanceWindow ?? null }
          : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(contentIntents.siteId, this.deps.siteId), eq(contentIntents.id, id)))
      .returning();
    return intent!;
  }

  async remove(id: string) {
    await this.get(id);
    await this.deps.db
      .delete(contentIntents)
      .where(and(eq(contentIntents.siteId, this.deps.siteId), eq(contentIntents.id, id)));
    return { ok: true } as const;
  }

  /** Paused intents stop generating goals; running goals finish naturally. */
  async pause(id: string) {
    return this.setStatus(id, 'paused', null);
  }

  async resume(id: string) {
    return this.setStatus(id, 'active', null);
  }

  /** Circuit breaker target — called by the reconciler on repeated failure. */
  async markError(id: string, reason: string) {
    return this.setStatus(id, 'error', reason);
  }

  private async setStatus(id: string, status: 'active' | 'paused' | 'error', reason: string | null) {
    await this.get(id);
    const [intent] = await this.deps.db
      .update(contentIntents)
      .set({ status, statusReason: reason, updatedAt: new Date() })
      .where(and(eq(contentIntents.siteId, this.deps.siteId), eq(contentIntents.id, id)))
      .returning();
    return intent!;
  }

  /**
   * Compiles a natural-language description into intent-rule.v1 rules.
   * Returns the compiled draft for the user to confirm — never persists or
   * activates anything itself (Req 5.3).
   */
  async compile(description: string, collection: string): Promise<{
    rules: IntentRule[];
    schedule: string;
    warnings: string[];
  }> {
    if (!this.deps.llm) {
      throw new IntentServiceError(
        'LLM_NOT_CONFIGURED',
        'Natural-language intent compilation requires a configured LLM provider.',
        503,
      );
    }

    let content: string | null;
    try {
      const response = await this.deps.llm.provider.chat([
        {
          role: 'system',
          content:
            'You compile content quality requirements into machine rules. Reply with ONLY JSON: ' +
            '{"rules": [...], "schedule": "cron"}. Allowed rule shapes: ' +
            '{"type":"required_fields","fields":[string]} | ' +
            '{"type":"freshness","maxAgeDays":number} | ' +
            '{"type":"translations","locales":[string],"fields":[string]?} | ' +
            '{"type":"link_health","fields":[string]?} | ' +
            '{"type":"field_constraint","field":string,"minLength":number?,"maxLength":number?,"pattern":string?} | ' +
            '{"type":"glossary_compliance","glossary":string?,"fields":[string]?}. ' +
            'schedule is a 5-field cron; default "0 6 * * *" when the user does not specify timing.',
        },
        { role: 'user', content: `Collection: ${collection}\nRequirement: ${description}` },
      ]);
      content = response.content;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new IntentServiceError('LLM_PROVIDER_ERROR', message, 502);
    }
    if (!content) {
      throw new IntentServiceError('LLM_EMPTY_RESPONSE', 'Model returned no content.', 502);
    }

    let raw: unknown;
    try {
      const trimmed = content.replace(/```(?:json)?/g, '').trim();
      const start = trimmed.indexOf('{');
      const end = trimmed.lastIndexOf('}');
      raw = JSON.parse(start !== -1 && end > start ? trimmed.slice(start, end + 1) : trimmed);
    } catch {
      throw new IntentServiceError('LLM_INVALID_JSON', 'Model response was not valid JSON.', 502);
    }

    const candidate = raw as { rules?: unknown[]; schedule?: unknown };
    const warnings: string[] = [];
    const rules: IntentRule[] = [];
    for (const entry of Array.isArray(candidate.rules) ? candidate.rules : []) {
      const result = ruleSchema.safeParse(entry);
      if (result.success) {
        rules.push(result.data);
      } else {
        warnings.push(`Dropped invalid rule: ${JSON.stringify(entry).slice(0, 200)}`);
      }
    }
    if (rules.length === 0) {
      throw new IntentServiceError('COMPILE_EMPTY', 'No valid rules could be compiled from the description.', 422);
    }

    const schedule =
      typeof candidate.schedule === 'string' && CRON_PATTERN.test(candidate.schedule)
        ? candidate.schedule
        : '0 6 * * *';
    if (schedule !== candidate.schedule) {
      warnings.push('Schedule missing or invalid; defaulted to "0 6 * * *".');
    }

    return { rules, schedule, warnings };
  }
}
