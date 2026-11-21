/**
 * Audience rules (#762). A rule is a list of conditions over the request
 * context, combined with `all` (AND) or `any` (OR). Evaluation is pure and
 * synchronous so the edge can run it on every request.
 *
 * Attributes come in two classes:
 * - contextual: `country`, `locale` — coarse, not tied to a person; usable
 *   without consent.
 * - personal: `utm.*` and `attr.*` (custom attributes such as a member
 *   tier) — only evaluated when the request carries personalisation consent.
 *   Without it a condition on them is false, so the visitor falls through to
 *   a contextual audience or the default content.
 */
import { z } from 'zod';

export const CONTEXTUAL_ATTRIBUTES = ['country', 'locale'] as const;
export const UTM_ATTRIBUTES = ['utm.source', 'utm.medium', 'utm.campaign', 'utm.term', 'utm.content'] as const;

/** `country` | `locale` | `utm.<field>` | `attr.<name>` */
const attributeSchema = z
  .string()
  .regex(/^(country|locale|utm\.(source|medium|campaign|term|content)|attr\.[a-z][a-z0-9_]{0,39})$/, {
    message: 'Attribute must be country, locale, utm.<source|medium|campaign|term|content> or attr.<name>.',
  });

const scalar = z.string().min(1).max(200);

export const conditionSchema = z.discriminatedUnion('op', [
  z.object({ attribute: attributeSchema, op: z.literal('eq'), value: scalar }).strict(),
  z.object({ attribute: attributeSchema, op: z.literal('neq'), value: scalar }).strict(),
  z.object({ attribute: attributeSchema, op: z.literal('in'), value: z.array(scalar).min(1).max(100) }).strict(),
  z.object({ attribute: attributeSchema, op: z.literal('nin'), value: z.array(scalar).min(1).max(100) }).strict(),
  z.object({ attribute: attributeSchema, op: z.literal('exists') }).strict(),
  z.object({ attribute: attributeSchema, op: z.literal('prefix'), value: scalar }).strict(),
]);

export const audienceRulesSchema = z
  .object({
    match: z.enum(['all', 'any']).default('all'),
    conditions: z.array(conditionSchema).min(1).max(20),
  })
  .strict();

export type AudienceCondition = z.infer<typeof conditionSchema>;
export type AudienceRules = z.infer<typeof audienceRulesSchema>;

export interface RequestContext {
  /** ISO 3166-1 alpha-2, upper case, or null when the edge did not say. */
  country: string | null;
  /** Requested content locale, lower case (`vi`, `pt-br`), or null. */
  locale: string | null;
  utm: Partial<Record<'source' | 'medium' | 'campaign' | 'term' | 'content', string>>;
  /** Custom attributes (`tier`, `plan`, …), lower-case keys. */
  attrs: Record<string, string>;
  consent: { personalization: boolean; analytics: boolean };
}

export function isPersonalAttribute(attribute: string): boolean {
  return attribute.startsWith('utm.') || attribute.startsWith('attr.');
}

/** True when any condition needs personalisation consent. */
export function rulesNeedConsent(rules: AudienceRules): boolean {
  return rules.conditions.some((c) => isPersonalAttribute(c.attribute));
}

function readAttribute(ctx: RequestContext, attribute: string): string | null {
  if (attribute === 'country') return ctx.country;
  if (attribute === 'locale') return ctx.locale;
  if (!ctx.consent.personalization) return null;
  if (attribute.startsWith('utm.')) return ctx.utm[attribute.slice(4) as keyof RequestContext['utm']] ?? null;
  if (attribute.startsWith('attr.')) return ctx.attrs[attribute.slice(5)] ?? null;
  return null;
}

const norm = (v: string) => v.trim().toLowerCase();

export function evaluateCondition(condition: AudienceCondition, ctx: RequestContext): boolean {
  const raw = readAttribute(ctx, condition.attribute);
  // A personal attribute without consent never matches — not even `neq`/`nin`,
  // which would otherwise match "everyone who did not consent".
  if (raw === null) return false;
  const v = norm(raw);
  switch (condition.op) {
    case 'exists':
      return v.length > 0;
    case 'eq':
      return v === norm(condition.value);
    case 'neq':
      return v !== norm(condition.value);
    case 'in':
      return condition.value.some((x) => norm(x) === v);
    case 'nin':
      return !condition.value.some((x) => norm(x) === v);
    case 'prefix':
      return v.startsWith(norm(condition.value));
  }
}

export function evaluateRules(rules: AudienceRules, ctx: RequestContext): boolean {
  return rules.match === 'any'
    ? rules.conditions.some((c) => evaluateCondition(c, ctx))
    : rules.conditions.every((c) => evaluateCondition(c, ctx));
}

export interface AudienceLike {
  id: string;
  key: string;
  priority: number;
  enabled: boolean;
  rules: unknown;
}

/** First enabled audience (by priority, then key) whose rules match; null = default content. */
export function resolveAudience<T extends AudienceLike>(audiences: readonly T[], ctx: RequestContext): T | null {
  const ordered = audiences.filter((a) => a.enabled).sort((a, b) => a.priority - b.priority || a.key.localeCompare(b.key));
  for (const audience of ordered) {
    const parsed = audienceRulesSchema.safeParse(audience.rules);
    if (parsed.success && evaluateRules(parsed.data, ctx)) return audience;
  }
  return null;
}
