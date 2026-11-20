import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { MemoryCacheProvider } from '@lumibase/runtime';
import { BUCKETS, assignArm, bucketFor, buildReport, normalCdf, twoProportionZ } from '../stats';
import {
  applyItemExperiments,
  applyPageExperiment,
  experimentsHeaderValue,
  resolveDeliveryExperiments,
  runningCacheKey,
} from '../delivery';
import type { ExperimentRepository, RunningExperiment } from '../repo';

const ARMS = [
  { key: 'b', weight: 50 },
  { key: 'control', weight: 50 },
];

describe('assignment', () => {
  it('is deterministic per visitor and experiment, and salted by the experiment key', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9_-]{8,40}$/), (visitor) => {
        expect(assignArm('hero', visitor, ARMS)).toBe(assignArm('hero', visitor, ARMS));
        const b = bucketFor('hero', visitor);
        expect(b).toBeGreaterThanOrEqual(0);
        expect(b).toBeLessThan(BUCKETS);
      }),
    );
    const visitors = Array.from({ length: 200 }, (_, i) => `visitor-${i}`);
    const a = visitors.map((v) => assignArm('hero', v, ARMS));
    const b = visitors.map((v) => assignArm('pricing', v, ARMS));
    expect(a).not.toEqual(b);
  });

  it('splits traffic by weight and never sends traffic to a zero-weight arm', () => {
    const visitors = Array.from({ length: 20_000 }, (_, i) => `v${i}-${(i * 7919) % 104729}`);
    const share = (arms: typeof ARMS, key: string) => visitors.filter((v) => assignArm('split', v, arms) === key).length / visitors.length;
    expect(share(ARMS, 'b')).toBeGreaterThan(0.47);
    expect(share(ARMS, 'b')).toBeLessThan(0.53);
    const skewed = [
      { key: 'b', weight: 10 },
      { key: 'control', weight: 90 },
    ];
    expect(share(skewed, 'b')).toBeGreaterThan(0.08);
    expect(share(skewed, 'b')).toBeLessThan(0.12);
    expect(share([{ key: 'b', weight: 0 }, { key: 'control', weight: 1 }], 'b')).toBe(0);
    expect(assignArm('x', 'visitor-1', [{ key: 'control', weight: 0 }])).toBeNull();
  });
});

describe('statistics', () => {
  it('approximates the normal CDF', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 4);
    expect(normalCdf(-1.959964)).toBeCloseTo(0.025, 4);
  });

  it('runs a two-proportion z-test', () => {
    const t = twoProportionZ({ key: 'control', exposures: 1000, conversions: 100 }, { key: 'b', exposures: 1000, conversions: 140 });
    expect(t!.z).toBeCloseTo(2.75, 1);
    expect(t!.pValue).toBeLessThan(0.01);
    expect(twoProportionZ({ key: 'control', exposures: 0, conversions: 0 }, { key: 'b', exposures: 10, conversions: 1 })).toBeNull();
    expect(twoProportionZ({ key: 'control', exposures: 10, conversions: 0 }, { key: 'b', exposures: 10, conversions: 0 })).toBeNull();
  });

  it('recommends nothing before the sample size, a significant winner after, and control when every challenger loses', () => {
    const early = buildReport(
      [
        { key: 'control', exposures: 50, conversions: 5 },
        { key: 'b', exposures: 50, conversions: 20 },
      ],
      { minSampleSize: 100 },
    );
    expect(early.sampleReached).toBe(false);
    expect(early.recommendation).toBeNull();

    const win = buildReport(
      [
        { key: 'control', exposures: 1000, conversions: 100 },
        { key: 'b', exposures: 1000, conversions: 140 },
      ],
      { minSampleSize: 100 },
    );
    expect(win.recommendation?.arm).toBe('b');
    expect(win.arms.find((a) => a.key === 'b')).toMatchObject({ rate: 0.14, uplift: 0.4, significant: true });
    expect(win.totals).toEqual({ exposures: 2000, conversions: 240 });

    const flat = buildReport(
      [
        { key: 'control', exposures: 1000, conversions: 100 },
        { key: 'b', exposures: 1000, conversions: 104 },
      ],
      { minSampleSize: 100 },
    );
    expect(flat.recommendation).toBeNull();

    const lose = buildReport(
      [
        { key: 'control', exposures: 1000, conversions: 140 },
        { key: 'b', exposures: 1000, conversions: 90 },
      ],
      { minSampleSize: 100 },
    );
    expect(lose.recommendation?.arm).toBe('control');
  });

  it('corrects alpha for several challengers', () => {
    // p≈0.03 for "b": significant alone, not with three challengers (alpha 0.0167).
    const counts = (extra: number) => [
      { key: 'control', exposures: 2000, conversions: 200 },
      { key: 'b', exposures: 2000, conversions: 245 },
      ...Array.from({ length: extra }, (_, i) => ({ key: `c${i}`, exposures: 2000, conversions: 200 })),
    ];
    expect(buildReport(counts(0), { minSampleSize: 100 }).recommendation?.arm).toBe('b');
    expect(buildReport(counts(2), { minSampleSize: 100 }).recommendation).toBeNull();
  });
});

describe('delivery resolution', () => {
  const running: RunningExperiment[] = [
    { id: 'e1', key: 'hero', subjectType: 'page', subjectId: 'page_home', pageSlug: 'home', arms: [{ key: 'b', weight: 100, overrides: { title: 'Home B' } }, { key: 'control', weight: 0, overrides: {} }] },
    { id: 'e2', key: 'cta', subjectType: 'item', subjectId: 'item_1', pageSlug: null, arms: [{ key: 'b', weight: 100, overrides: { label: 'Try it' } }, { key: 'control', weight: 0, overrides: {} }] },
    { id: 'e3', key: 'other', subjectType: 'page', subjectId: 'page_about', pageSlug: 'about', arms: [{ key: 'b', weight: 1, overrides: { title: 'x' } }, { key: 'control', weight: 1, overrides: {} }] },
  ];
  const repo = { siteId: 's1', running: async () => running } as unknown as ExperimentRepository;
  const headers = (visitor?: string) => new Headers(visitor ? { 'x-lumi-visitor': visitor } : {});

  it('assigns only with analytics consent and a well-formed visitor id; otherwise serves control uncounted', async () => {
    const assigned = await resolveDeliveryExperiments({ repo, cache: undefined, headers: headers('visitor-123'), slug: 'home', analyticsConsent: true });
    expect(assigned.token).toBe('cta:b,hero:b');
    expect(assigned.assignments.map((a) => a.experiment.key)).toEqual(['cta', 'hero']);

    const noConsent = await resolveDeliveryExperiments({ repo, cache: undefined, headers: headers('visitor-123'), slug: 'home', analyticsConsent: false });
    expect(noConsent.token).toBe('cta:_,hero:_');
    expect(noConsent.assignments.every((a) => !a.assigned && a.arm === 'control')).toBe(true);

    const badVisitor = await resolveDeliveryExperiments({ repo, cache: undefined, headers: headers('x'), slug: 'home', analyticsConsent: true });
    expect(badVisitor.token).toBe('cta:_,hero:_');

    const elsewhere = await resolveDeliveryExperiments({ repo: { siteId: 's1', running: async () => [running[0]!] } as unknown as ExperimentRepository, cache: undefined, headers: headers('visitor-123'), slug: 'pricing', analyticsConsent: true });
    expect(elsewhere.active).toBe(false);
  });

  it('caches the running list per site', async () => {
    let calls = 0;
    const counting = { siteId: 's2', running: async () => (calls++, running) } as unknown as ExperimentRepository;
    const cache = new MemoryCacheProvider();
    await resolveDeliveryExperiments({ repo: counting, cache, headers: headers(), slug: 'home', analyticsConsent: false });
    await resolveDeliveryExperiments({ repo: counting, cache, headers: headers(), slug: 'home', analyticsConsent: false });
    expect(calls).toBe(1);
    expect(await cache.get(runningCacheKey('s2'))).toBeTruthy();
  });

  it('applies arms to the page and its items and lists only what touched the page', async () => {
    const exps = await resolveDeliveryExperiments({ repo, cache: undefined, headers: headers('visitor-123'), slug: 'home', analyticsConsent: true });
    const page = applyPageExperiment({ id: 'page_home', title: 'Home', slug: 'home', layoutConfig: {} }, exps);
    expect(page.title).toBe('Home B');
    const payload = { sections: [{ data: { items: [{ id: 'item_1', label: 'Start', status: 'published' }, { id: 'item_2', label: 'Other' }] } }] };
    const applied = applyItemExperiments(payload, exps, 'page_home');
    expect(payload.sections[0]!.data.items[0]).toMatchObject({ label: 'Try it', status: 'published' });
    expect(payload.sections[0]!.data.items[1]).toMatchObject({ label: 'Other' });
    expect(applied).toEqual([
      { key: 'cta', arm: 'b' },
      { key: 'hero', arm: 'b' },
    ]);
    expect(experimentsHeaderValue(applied)).toBe('cta=b,hero=b');

    const without = { sections: [{ data: { items: [{ id: 'item_9' }] } }] };
    expect(applyItemExperiments(without, exps, 'page_home')).toEqual([{ key: 'hero', arm: 'b' }]);
    expect(experimentsHeaderValue([])).toBeNull();
  });
});
