/**
 * Audience rules and request context (#762): operators, all/any, priority,
 * consent gating of personal attributes (UTM, custom attributes), DNT/GPC,
 * and header parsing.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseAttrsHeader, parseConsentHeader, requestContext } from '../context';
import { audienceRulesSchema, evaluateRules, resolveAudience, rulesNeedConsent, type RequestContext } from '../rules';

const ctx = (over: Partial<RequestContext> = {}): RequestContext => ({
  country: 'VN',
  locale: 'vi',
  utm: { source: 'newsletter', campaign: 'tet-2027' },
  attrs: { tier: 'gold' },
  consent: { personalization: true, analytics: true },
  ...over,
});
const rules = (r: unknown) => audienceRulesSchema.parse(r);

describe('evaluateRules', () => {
  it('supports eq/neq/in/nin/exists/prefix, case-insensitively', () => {
    expect(evaluateRules(rules({ conditions: [{ attribute: 'country', op: 'eq', value: 'vn' }] }), ctx())).toBe(true);
    expect(evaluateRules(rules({ conditions: [{ attribute: 'country', op: 'neq', value: 'US' }] }), ctx())).toBe(true);
    expect(evaluateRules(rules({ conditions: [{ attribute: 'country', op: 'in', value: ['TH', 'VN'] }] }), ctx())).toBe(true);
    expect(evaluateRules(rules({ conditions: [{ attribute: 'country', op: 'nin', value: ['TH', 'VN'] }] }), ctx())).toBe(false);
    expect(evaluateRules(rules({ conditions: [{ attribute: 'utm.campaign', op: 'prefix', value: 'TET-' }] }), ctx())).toBe(true);
    expect(evaluateRules(rules({ conditions: [{ attribute: 'attr.tier', op: 'exists' }] }), ctx())).toBe(true);
    expect(evaluateRules(rules({ conditions: [{ attribute: 'attr.plan', op: 'exists' }] }), ctx())).toBe(false);
  });

  it('combines with all / any', () => {
    const both = [
      { attribute: 'country', op: 'eq', value: 'VN' },
      { attribute: 'locale', op: 'eq', value: 'en' },
    ];
    expect(evaluateRules(rules({ match: 'all', conditions: both }), ctx())).toBe(false);
    expect(evaluateRules(rules({ match: 'any', conditions: both }), ctx())).toBe(true);
  });

  it('never matches a personal attribute without consent — not even neq / nin', () => {
    const noConsent = ctx({ consent: { personalization: false, analytics: true } });
    for (const r of [
      { conditions: [{ attribute: 'attr.tier', op: 'eq', value: 'gold' }] },
      { conditions: [{ attribute: 'attr.tier', op: 'neq', value: 'silver' }] },
      { conditions: [{ attribute: 'utm.source', op: 'nin', value: ['ads'] }] },
    ]) {
      expect(evaluateRules(rules(r), noConsent)).toBe(false);
    }
    // Contextual attributes need no consent.
    expect(evaluateRules(rules({ conditions: [{ attribute: 'country', op: 'eq', value: 'VN' }] }), noConsent)).toBe(true);
    expect(rulesNeedConsent(rules({ conditions: [{ attribute: 'country', op: 'eq', value: 'VN' }] }))).toBe(false);
    expect(rulesNeedConsent(rules({ conditions: [{ attribute: 'attr.tier', op: 'exists' }] }))).toBe(true);
  });

  it('property: without personalisation consent, a rule made only of personal conditions never matches', () => {
    const attr = fc.constantFrom('utm.source', 'utm.medium', 'utm.campaign', 'attr.tier', 'attr.plan');
    const value = fc.string({ minLength: 1, maxLength: 8 });
    const condition = fc.oneof(
      fc.record({ attribute: attr, op: fc.constantFrom('eq', 'neq', 'prefix'), value }),
      fc.record({ attribute: attr, op: fc.constantFrom('in', 'nin'), value: fc.array(value, { minLength: 1, maxLength: 3 }) }),
      fc.record({ attribute: attr, op: fc.constant('exists') }),
    );
    fc.assert(
      fc.property(fc.constantFrom('all', 'any'), fc.array(condition, { minLength: 1, maxLength: 5 }), (match, conditions) => {
        const parsed = audienceRulesSchema.safeParse({ match, conditions });
        if (!parsed.success) return;
        expect(evaluateRules(parsed.data, ctx({ consent: { personalization: false, analytics: false } }))).toBe(false);
      }),
    );
  });

  it('rejects unknown attributes and operators', () => {
    expect(audienceRulesSchema.safeParse({ conditions: [{ attribute: 'ip', op: 'eq', value: '1.2.3.4' }] }).success).toBe(false);
    expect(audienceRulesSchema.safeParse({ conditions: [{ attribute: 'country', op: 'regex', value: '.*' }] }).success).toBe(false);
    expect(audienceRulesSchema.safeParse({ conditions: [] }).success).toBe(false);
  });
});

describe('resolveAudience', () => {
  const a = (key: string, priority: number, rule: unknown, enabled = true) => ({ id: `id_${key}`, key, priority, enabled, rules: rule });
  const vn = { conditions: [{ attribute: 'country', op: 'eq', value: 'VN' }] };
  const gold = { conditions: [{ attribute: 'attr.tier', op: 'eq', value: 'gold' }] };

  it('takes the first enabled match by priority, then key', () => {
    expect(resolveAudience([a('vn', 50, vn), a('gold', 10, gold)], ctx())!.key).toBe('gold');
    expect(resolveAudience([a('vn', 10, vn), a('gold', 10, gold)], ctx())!.key).toBe('gold');
    expect(resolveAudience([a('vn', 50, vn), a('gold', 10, gold, false)], ctx())!.key).toBe('vn');
  });

  it('falls through to a contextual audience without consent, then to the default', () => {
    const list = [a('gold', 10, gold), a('vn', 50, vn)];
    expect(resolveAudience(list, ctx({ consent: { personalization: false, analytics: false } }))!.key).toBe('vn');
    expect(resolveAudience(list, ctx({ country: 'US', consent: { personalization: false, analytics: false } }))).toBeNull();
  });

  it('skips an audience whose stored rules no longer parse', () => {
    expect(resolveAudience([a('broken', 1, { nope: true }), a('vn', 2, vn)], ctx())!.key).toBe('vn');
  });
});

describe('request context', () => {
  it('reads country from CDN headers, locale and UTM from the query, attributes and consent from headers', () => {
    const c = requestContext(
      new Headers({ 'CF-IPCountry': 'vn', 'X-Lumi-Attrs': 'tier=gold; Plan=pro%20plus; bad key=x', 'X-Lumi-Consent': 'analytics, personalization' }),
      new URL('https://cms/api/v1/deliver/page/s/home?locale=VI&utm_source=Newsletter&utm_campaign=tet'),
    );
    expect(c).toEqual({
      country: 'VN',
      locale: 'vi',
      utm: { source: 'Newsletter', campaign: 'tet' },
      attrs: { tier: 'gold', plan: 'pro plus' },
      consent: { personalization: true, analytics: true },
    });
  });

  it('ignores unknown countries and withdraws consent on DNT or GPC', () => {
    const url = new URL('https://cms/x');
    expect(requestContext(new Headers({ 'CF-IPCountry': 'XX' }), url).country).toBeNull();
    expect(requestContext(new Headers({ 'X-Vercel-IP-Country': 'de' }), url).country).toBe('DE');
    const gpc = requestContext(new Headers({ 'X-Lumi-Consent': 'personalization,analytics', 'Sec-GPC': '1' }), url);
    expect(gpc.consent).toEqual({ personalization: false, analytics: false });
    expect(requestContext(new Headers({ 'X-Lumi-Consent': 'analytics', DNT: '1' }), url).consent.analytics).toBe(false);
  });

  it('caps attributes and parses consent tokens loosely', () => {
    const many = Array.from({ length: 30 }, (_, i) => `a${i}=v`).join(';');
    expect(Object.keys(parseAttrsHeader(many))).toHaveLength(20);
    expect(parseAttrsHeader(`tier=${'x'.repeat(201)}`)).toEqual({});
    expect(parseConsentHeader('Personalisation')).toEqual({ personalization: true, analytics: false });
    expect(parseConsentHeader(undefined)).toEqual({ personalization: false, analytics: false });
  });
});
