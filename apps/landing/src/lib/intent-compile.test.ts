import { describe, expect, it } from 'vitest';
import {
  CHARS_PER_WORD,
  DEFAULT_SCHEDULE,
  PRESET_COLLECTIONS,
  RUN_BEATS,
  collectionFromText,
  compileIntent,
  describeRun,
  evaluateIntent,
  formatIntentPayload,
  presetFor,
  sampleFor,
  type IntentRule,
} from './intent-compile';

describe('compileIntent', () => {
  it('compiles the products preset sentence into the preset rules', () => {
    // The preset rules are hand-written (the fallback must not recurse), so
    // this is the assertion that keeps them honest: the label the visitor
    // reads has to be a sentence the matcher actually understands.
    for (const collection of PRESET_COLLECTIONS) {
      const preset = presetFor(collection);
      const compiled = compileIntent(preset.sentence, collection);
      expect(compiled.rules, `preset drift for ${collection}`).toEqual(preset.rules);
    }
  });

  it('maps "≥1 image" to required_fields and vi+en to translations', () => {
    const { rules } = compileIntent('Every product: ≥1 image · vi+en', 'products');
    expect(rules).toContainEqual({ type: 'required_fields', fields: ['image'] });
    expect(rules).toContainEqual({ type: 'translations', locales: ['vi', 'en'] });
  });

  it('warns when a word range is compiled into a character constraint', () => {
    const { rules, warnings } = compileIntent('description 50–200 words', 'products');
    expect(rules).toContainEqual({
      type: 'field_constraint',
      field: 'description',
      minLength: 50 * CHARS_PER_WORD,
      maxLength: 200 * CHARS_PER_WORD,
    });
    // field_constraint measures value.length in drift-service, so claiming
    // words without saying so would misrepresent the shipped rule.
    expect(warnings.join(' ')).toMatch(/characters, not words/);
    expect(warnings.join(' ')).toContain('300–1200 chars');
  });

  it('converts 24h to one day without a warning, since nothing is lost', () => {
    const { rules, warnings } = compileIntent('price updated within 24h', 'products');
    expect(rules).toContainEqual({ type: 'freshness', maxAgeDays: 1 });
    expect(warnings.join(' ')).not.toMatch(/day-granular/);
  });

  it('warns when a sub-day window is floored, because freshness is day-granular', () => {
    const { rules, warnings } = compileIntent('price updated within 6h', 'products');
    expect(rules).toContainEqual({ type: 'freshness', maxAgeDays: 1 });
    expect(warnings.join(' ')).toMatch(/day-granular/);
  });

  it('routes an SEO character ceiling to seo_title, a plain one to title', () => {
    expect(compileIntent('SEO title ≤ 60 chars', 'articles').rules).toContainEqual({
      type: 'field_constraint',
      field: 'seo_title',
      maxLength: 60,
    });
    expect(compileIntent('title at most 80 characters', 'articles').rules).toContainEqual({
      type: 'field_constraint',
      field: 'title',
      maxLength: 80,
    });
  });

  it('does not read locale codes out of ordinary words', () => {
    // "trend" contains "en", "video" contains "de" — token-wise, neither is a
    // locale, and a matcher that thought otherwise would emit a bogus rule.
    const { rules } = compileIntent('trend videos need a thumbnail', 'articles');
    expect(rules.some((r) => r.type === 'translations')).toBe(false);
  });

  it('reads a schedule when stated and otherwise defaults like the service', () => {
    expect(compileIntent('no dead links, hourly', 'docs').schedule).toBe('0 * * * *');
    expect(compileIntent('no dead links', 'docs').schedule).toBe(DEFAULT_SCHEDULE);
  });

  it('falls back to the preset instead of emitting a ruleless intent', () => {
    // The service rejects a ruleless intent with COMPILE_EMPTY; the card has
    // to degrade to something truthful rather than render an empty payload.
    const { rules, warnings } = compileIntent('asdfgh', 'docs');
    expect(rules).toEqual(presetFor('docs').rules);
    expect(warnings.join(' ')).toMatch(/Nothing in that sentence matched/);
    expect(rules.length).toBeGreaterThan(0);
  });

  it('never emits the same rule twice for a repeated phrase', () => {
    const { rules } = compileIntent('image, image, one more image', 'products');
    expect(rules.filter((r) => r.type === 'required_fields')).toHaveLength(1);
  });

  it('merges required fields instead of dropping the second match', () => {
    // Regression: keying dedupe on rule type alone meant "≥1 image · alt text"
    // compiled to an image rule with no mention of alt text — the payload
    // quietly contradicted the sentence that produced it.
    const { rules } = compileIntent('Every product: ≥1 image · alt text', 'products');
    expect(rules.filter((r) => r.type === 'required_fields')).toHaveLength(1);
    expect(rules).toContainEqual({
      type: 'required_fields',
      fields: ['image', 'image_alt'],
    });
  });

  it('keeps constraints on different fields side by side', () => {
    const { rules } = compileIntent('50–200 words and SEO title ≤ 60 chars', 'articles');
    expect(rules.filter((r) => r.type === 'field_constraint')).toHaveLength(2);
  });
});

describe('collectionFromText', () => {
  it('prefers the collection the sentence names over the active chip', () => {
    expect(collectionFromText('articles need alt text', 'products')).toBe('articles');
    expect(collectionFromText('every doc has en/vi parity', 'products')).toBe('docs');
  });

  it('matches the singular the presets are written in', () => {
    expect(collectionFromText('Every product: ≥1 image', 'docs')).toBe('products');
    expect(collectionFromText('Every article: hero image', 'docs')).toBe('articles');
  });

  it('falls back to the active chip when no collection is named', () => {
    expect(collectionFromText('needs a hero image', 'docs')).toBe('docs');
  });

  it('agrees with every preset sentence', () => {
    for (const collection of PRESET_COLLECTIONS) {
      expect(collectionFromText(presetFor(collection).sentence, 'products')).toBe(collection);
    }
  });
});

describe('evaluateIntent', () => {
  it('finds drift in every sampled collection under its own preset', () => {
    for (const collection of PRESET_COLLECTIONS) {
      const preset = presetFor(collection);
      const violations = evaluateIntent(preset.rules, sampleFor(collection));
      // A sample where nothing fails would make the loop look like theatre;
      // one where everything fails reads as a broken product.
      expect(violations.length, collection).toBeGreaterThan(0);
      expect(violations.length, collection).toBeLessThan(sampleFor(collection).length);
    }
  });

  it('reports at most one violation per item', () => {
    const rules = presetFor('products').rules;
    const violations = evaluateIntent(rules, sampleFor('products'));
    const slugs = violations.map((v) => v.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('measures field_constraint in characters, as drift-service does', () => {
    const rules: IntentRule[] = [
      { type: 'field_constraint', field: 'description', minLength: 300 },
    ];
    const violations = evaluateIntent(rules, sampleFor('products'));
    expect(violations).toHaveLength(1);
    expect(violations[0]!.slug).toBe('products/ban-phim-co-k3');
    expect(violations[0]!.reason).toMatch(/190 chars, floor is 300/);
  });

  it('flags a missing locale rather than a missing translations object', () => {
    const rules: IntentRule[] = [{ type: 'translations', locales: ['vi', 'en'] }];
    const violations = evaluateIntent(rules, sampleFor('products'));
    expect(violations.map((v) => v.slug)).toEqual(['products/chuot-khong-day-m1']);
    expect(violations[0]!.reason).toBe('en translation missing');
    expect(violations[0]!.fix).toMatch(/^translator/);
  });

  it('treats an empty string as a missing required field', () => {
    const rules: IntentRule[] = [{ type: 'required_fields', fields: ['image'] }];
    const violations = evaluateIntent(rules, sampleFor('products'));
    expect(violations.map((v) => v.slug)).toEqual(['products/tai-nghe-air-2']);
  });

  it('flags a hostless URL but leaves well-formed and non-http schemes alone', () => {
    const rules: IntentRule[] = [{ type: 'link_health' }];
    const violations = evaluateIntent(rules, sampleFor('products'));
    // Only the truncated "https://" trips it. r2:// asset paths must not.
    expect(violations.map((v) => v.slug)).toEqual(['products/sac-nhanh-65w']);
  });

  it('adding a rule can only widen the drift set for a fixed sample', () => {
    const base: IntentRule[] = [{ type: 'required_fields', fields: ['image'] }];
    const more: IntentRule[] = [...base, { type: 'freshness', maxAgeDays: 30 }];
    const items = sampleFor('products');
    // The count is what the visitor sees move when they add a constraint, so
    // monotonicity is the property that makes the demo trustworthy.
    expect(evaluateIntent(more, items).length).toBeGreaterThanOrEqual(
      evaluateIntent(base, items).length,
    );
  });

  it('attributes each fix to the role reconciler-service routes the rule to', () => {
    const items = sampleFor('docs');
    const glossary = evaluateIntent([{ type: 'glossary_compliance' }], items);
    expect(glossary[0]!.fix).toMatch(/^taxonomist/);
    const links = evaluateIntent([{ type: 'link_health' }], items);
    expect(links[0]!.fix).toMatch(/^librarian/);
  });
});

describe('formatIntentPayload', () => {
  it('emits a payload that parses and carries the fields the API requires', () => {
    const compiled = compileIntent(presetFor('products').sentence, 'products');
    const payload = formatIntentPayload('products', compiled);
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      name: 'products slo',
      collection: 'products',
      schedule: DEFAULT_SCHEDULE,
      autonomyCap: 2,
    });
    expect(parsed.rules).toEqual(compiled.rules);
    // budget is intentionally absent — intentInputSchema prefaults it.
    expect(parsed).not.toHaveProperty('budget');
  });

  it('prints one rule per line so the card-sized block stays readable', () => {
    const compiled = compileIntent(presetFor('docs').sentence, 'docs');
    const lines = formatIntentPayload('docs', compiled).split('\n');
    const ruleLines = lines.filter((l) => l.includes('"type"'));
    expect(ruleLines).toHaveLength(compiled.rules.length);
  });
});

describe('describeRun', () => {
  const run = { total: 8, failing: 3 };

  it('says nothing has been declared before the first submit', () => {
    expect(describeRun('idle', null)).toEqual({
      status: 'awaiting intent',
      converged: 0,
      alarm: false,
      fixed: false,
    });
  });

  it('does not report drift before the evaluator has run', () => {
    // The compile beat knows the rules but not the collection's state, so the
    // bar has to stay full and drop on `evaluate`.
    expect(describeRun('compiling', run)).toMatchObject({
      status: 'compiling → intent-rule.v1',
      converged: 8,
      alarm: false,
    });
  });

  it('reports the pre-fix count while evaluating and during the incident', () => {
    expect(describeRun('evaluate', run)).toMatchObject({
      status: 'evaluating 8 sampled items',
      converged: 5,
      fixed: false,
    });
    expect(describeRun('incident', run)).toMatchObject({
      status: 'slo violated · 3 of 8',
      converged: 5,
      alarm: true,
    });
  });

  it('drops the alarm and shows fixes once the reconciler runs', () => {
    expect(describeRun('reconcile', run)).toMatchObject({
      status: 'reconciling · 3 goals',
      converged: 8,
      alarm: false,
      fixed: true,
    });
    expect(describeRun('converged', run)).toMatchObject({
      status: 'converged · 8 of 8',
      converged: 8,
      fixed: true,
    });
  });

  it('does not raise an alarm when the sample has no drift', () => {
    const clean = { total: 8, failing: 0 };
    expect(describeRun('incident', clean)).toMatchObject({ alarm: false, converged: 8 });
  });

  it('keeps the goal count grammatical', () => {
    expect(describeRun('reconcile', { total: 8, failing: 1 }).status).toBe(
      'reconciling · 1 goal',
    );
  });

  it('ends on the terminal beat so a user action does not loop forever', () => {
    // IntentStage cycles on its own; this card is driven, and re-breaking the
    // collection after the visitor fixed it would read as a bug.
    expect(RUN_BEATS[RUN_BEATS.length - 1]!.phase).toBe('converged');
    expect(RUN_BEATS[RUN_BEATS.length - 1]!.ms).toBe(0);
  });
});
