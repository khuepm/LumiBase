import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  collections,
  fields,
  items,
  localeGenerationJobs,
  settings,
  sites,
  translationMemory,
  translationSuggestions,
  translations,
  type Database,
} from '@lumibase/database';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
import { ItemService } from '../item-service';
import type { MtProvider } from '../translation-memory';
import {
  LocaleGenerationError,
  cancelLocaleJob,
  createLocaleJob,
  decideSuggestion,
  driveLocaleJob,
  getLocaleJob,
  listSuggestions,
  resumeLocaleJob,
  runLocaleJobStep,
  runLocaleJobTick,
  type LocaleJobDeps,
  type ReviewItemAccess,
} from '../locale-generation-service';

/**
 * Locale generator (#714) against REAL PostgreSQL. The MT provider is an
 * in-memory fake (no network): it upper-cases and counts calls, so "did MT
 * run" and "did TM short-circuit it" are observable.
 */

const SITE = 'site_locgen_a';
const OTHER = 'site_locgen_b';

describe.skipIf(!hasDbIntegrationUrl)('locale generator — DB integration', () => {
  let db: Database;
  let mtCalls: string[];
  let failOn: string | null;

  const fake: MtProvider = {
    name: 'fake',
    translate: async ({ text, to }) => {
      mtCalls.push(text);
      if (failOn && text === failOn) throw new Error('provider exploded');
      return `${to}:${text.toUpperCase()}`;
    },
  };
  const deps = (): LocaleJobDeps => ({
    db,
    providers: new Map([['fake', fake]]),
    defaultProvider: 'fake',
    config: { chunkSize: 2, leaseMs: 60_000, maxCollections: 5 },
  });
  const access = (siteId = SITE): ReviewItemAccess => {
    const svc = new ItemService({ db, siteId });
    return { detail: (c, id) => svc.detail(c, id), patch: (c, id, p) => svc.patch(c, id, p) };
  };

  async function seedSite(siteId: string) {
    const [posts] = await db.insert(collections).values({ siteId, name: 'posts' }).returning();
    const [tags] = await db.insert(collections).values({ siteId, name: 'tags' }).returning();
    await db.insert(fields).values([
      { siteId, collectionId: posts!.id, name: 'title', type: 'json', interface: 'translatable-text' },
      { siteId, collectionId: posts!.id, name: 'body', type: 'json', interface: 'translatable-text' },
      { siteId, collectionId: posts!.id, name: 'slug', type: 'string', interface: 'input' },
      { siteId, collectionId: tags!.id, name: 'label', type: 'string', interface: 'input' },
    ]);
    const post = (id: string, data: Record<string, unknown>) => ({ id: `${siteId}_${id}`, siteId, collectionId: posts!.id, data });
    await db.insert(items).values([
      post('p1', { title: { en: 'Hello', vi: 'Xin chào' }, body: { en: 'World' }, slug: 'hello' }),
      post('p2', { title: { en: 'Already', ja: '既に' }, body: { en: '' } }),
      post('p3', { title: { en: 'Third' }, body: 'not a map' }),
    ]);
    await db.insert(translations).values([
      { siteId, language: 'en', namespace: 'ui', key: 'save', value: 'Save' },
      { siteId, language: 'en', namespace: 'ui', key: 'cancel', value: 'Cancel' },
      { siteId, language: 'ja', namespace: 'ui', key: 'cancel', value: 'キャンセル' },
      { siteId, language: 'en', namespace: 'emails', key: 'hi', value: 'Hi' },
    ]);
  }

  beforeAll(async () => {
    db = await connectDbIntegration('locale-generation');
  });
  const cleanup = () => db.delete(sites).where(sql`${sites.id} IN (${SITE}, ${OTHER})`);
  afterAll(async () => {
    if (db) await cleanup().catch(() => undefined);
  });
  beforeEach(async () => {
    mtCalls = [];
    failOn = null;
    await cleanup();
    const org = sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`;
    await db.insert(sites).values([
      { organizationId: org, id: SITE, name: 'Locgen A' },
      { organizationId: org, id: OTHER, name: 'Locgen B' },
    ]);
    await seedSite(SITE);
    await seedSite(OTHER);
    // A human-approved TM entry for "Hello" short-circuits MT.
    await db.insert(translationMemory).values({ siteId: SITE, sourceLang: 'en', targetLang: 'ja', sourceText: 'Hello', targetText: 'こんにちは' });
  });

  it('validates the request and scaffolds the locale setting', async () => {
    await expect(createLocaleJob(db, SITE, { locale: 'ja', sourceLocale: 'ja', collections: [], includeUi: true }, null)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(createLocaleJob(db, SITE, { locale: 'JA!', sourceLocale: 'en', collections: [], includeUi: true }, null)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(createLocaleJob(db, SITE, { locale: 'ja', sourceLocale: 'en', collections: ['tags'], includeUi: false }, null)).rejects.toMatchObject({ code: 'NO_TRANSLATABLE_FIELDS' });
    await expect(createLocaleJob(db, SITE, { locale: 'ja', sourceLocale: 'en', collections: [], includeUi: false }, null)).rejects.toBeInstanceOf(LocaleGenerationError);

    const job = await createLocaleJob(db, SITE, { locale: 'pt-BR', sourceLocale: 'en', collections: ['posts'], includeUi: true }, null);
    expect(job.status).toBe('queued');
    const [row] = await db.select().from(settings).where(and(eq(settings.siteId, SITE), eq(settings.key, 'locales')));
    expect((row!.value as { supported: string[] }).supported).toEqual(['en', 'vi', 'pt-BR']);
    await expect(createLocaleJob(db, SITE, { locale: 'pt-BR', sourceLocale: 'en', collections: ['posts'], includeUi: true }, null)).rejects.toMatchObject({ code: 'JOB_ACTIVE', status: 409 });
    // The other site is untouched.
    expect(await db.select().from(settings).where(eq(settings.siteId, OTHER))).toEqual([]);
  });

  it('turns every missing value into a suggestion — TM first, MT otherwise — and writes no content', async () => {
    const job = await createLocaleJob(db, SITE, { locale: 'ja', sourceLocale: 'en', collections: ['posts'], includeUi: true }, null);
    expect(await driveLocaleJob(deps(), job.id, 30_000)).toBe('done');

    const view = await getLocaleJob(db, SITE, job.id);
    expect(view.status).toBe('succeeded');
    expect(view.counters).toMatchObject({ items: 3, suggestions: 4, fromTm: 1, fromMt: 3, failed: 0 });
    expect(view.review).toEqual({ pending: 4 });

    const { rows, total } = await listSuggestions(db, SITE, { locale: 'ja', limit: 50, offset: 0 });
    expect(total).toBe(4);
    const byKey = Object.fromEntries(rows.map((r) => [r.targetKey, r]));
    expect(byKey[`item:posts:${SITE}_p1:title`]).toMatchObject({ suggestedText: 'こんにちは', origin: 'tm', provider: null });
    expect(byKey[`item:posts:${SITE}_p1:body`]).toMatchObject({ suggestedText: 'ja:WORLD', origin: 'mt', provider: 'fake' });
    expect(byKey[`item:posts:${SITE}_p3:title`]).toMatchObject({ suggestedText: 'ja:THIRD' });
    expect(byKey['ui:ui:save']).toMatchObject({ kind: 'ui', suggestedText: 'ja:SAVE' });
    // Already translated (p2 title, ui cancel), empty source, non-map and other namespaces are not queued.
    expect(mtCalls.sort()).toEqual(['Save', 'Third', 'World']);

    // HITL: content is unchanged until review.
    const [p1] = await db.select().from(items).where(eq(items.id, `${SITE}_p1`));
    expect((p1!.data as { title: Record<string, string> }).title).toEqual({ en: 'Hello', vi: 'Xin chào' });
    // Tenant isolation.
    expect((await listSuggestions(db, OTHER, { limit: 50, offset: 0 })).total).toBe(0);

    // Re-running never queues the same value twice.
    const again = await createLocaleJob(db, SITE, { locale: 'ja', sourceLocale: 'en', collections: ['posts'], includeUi: true }, null);
    await driveLocaleJob(deps(), again.id, 30_000);
    expect((await getLocaleJob(db, SITE, again.id)).counters).toMatchObject({ suggestions: 0 });
    expect((await listSuggestions(db, SITE, { locale: 'ja', limit: 50, offset: 0 })).total).toBe(4);
  });

  it('resumes from its cursor after an expired lease, and honours cancel', async () => {
    const job = await createLocaleJob(db, SITE, { locale: 'ja', sourceLocale: 'en', collections: ['posts'], includeUi: false }, null);
    expect(await runLocaleJobStep(deps(), job.id)).toBe('progressed');
    // Simulate a worker that died holding the lease.
    await db.update(localeGenerationJobs).set({ leaseOwner: 'dead', leaseUntil: new Date(Date.now() + 60_000) }).where(eq(localeGenerationJobs.id, job.id));
    expect(await runLocaleJobStep(deps(), job.id)).toBe('busy');
    await db.update(localeGenerationJobs).set({ leaseUntil: new Date(Date.now() - 1000) }).where(eq(localeGenerationJobs.id, job.id));
    const { resumed } = await runLocaleJobTick(deps(), { budgetMs: 30_000 });
    expect(resumed).toBe(1);
    const view = await getLocaleJob(db, SITE, job.id);
    expect(view.status).toBe('succeeded');
    expect(view.counters.items).toBe(3); // each item processed exactly once

    const second = await createLocaleJob(db, SITE, { locale: 'fr', sourceLocale: 'en', collections: ['posts'], includeUi: true }, null);
    await cancelLocaleJob(db, SITE, second.id);
    expect(await runLocaleJobStep(deps(), second.id)).toBe('done');
    expect((await getLocaleJob(db, SITE, second.id)).status).toBe('cancelled');
    const resumedJob = await resumeLocaleJob(db, SITE, second.id);
    expect(resumedJob.status).toBe('queued');
    await driveLocaleJob(deps(), second.id, 30_000);
    expect((await getLocaleJob(db, SITE, second.id)).status).toBe('succeeded');
    await expect(cancelLocaleJob(db, OTHER, second.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a provider failure is counted, the job still finishes, and an unknown provider fails it', async () => {
    failOn = 'World';
    const job = await createLocaleJob(db, SITE, { locale: 'ja', sourceLocale: 'en', collections: ['posts'], includeUi: false }, null);
    await driveLocaleJob(deps(), job.id, 30_000);
    const view = await getLocaleJob(db, SITE, job.id);
    expect(view).toMatchObject({ status: 'succeeded', counters: { failed: 1 } });
    expect(view.message).toContain('provider exploded');

    const bad = await createLocaleJob(db, SITE, { locale: 'de', sourceLocale: 'en', collections: ['posts'], includeUi: false, provider: 'deepl' }, null);
    await driveLocaleJob(deps(), bad.id, 30_000);
    expect(await getLocaleJob(db, SITE, bad.id)).toMatchObject({ status: 'failed', message: 'MT provider not available: deepl' });
  });

  it('approval writes through the item service, learns TM; stale and refused writes do not', async () => {
    const job = await createLocaleJob(db, SITE, { locale: 'ja', sourceLocale: 'en', collections: ['posts'], includeUi: true }, null);
    await driveLocaleJob(deps(), job.id, 30_000);
    const { rows } = await listSuggestions(db, SITE, { locale: 'ja', limit: 50, offset: 0 });
    const by = (key: string) => rows.find((r) => r.targetKey === key)!;

    // Edited approval.
    const body = by(`item:posts:${SITE}_p1:body`);
    expect(await decideSuggestion(db, SITE, body.id, { decision: 'approve', text: '世界' }, { userId: null }, access())).toEqual({ id: body.id, status: 'approved' });
    const [p1] = await db.select().from(items).where(eq(items.id, `${SITE}_p1`));
    expect((p1!.data as { body: Record<string, string> }).body).toEqual({ en: 'World', ja: '世界' });
    expect((p1!.data as { slug: string }).slug).toBe('hello');
    const learned = await db.select().from(translationMemory).where(and(eq(translationMemory.siteId, SITE), eq(translationMemory.sourceText, 'World')));
    expect(learned).toEqual([expect.objectContaining({ targetText: '世界', source: 'human', quality: 100 })]);
    await expect(decideSuggestion(db, SITE, body.id, { decision: 'approve' }, { userId: null }, access())).rejects.toMatchObject({ code: 'ALREADY_DECIDED' });

    // Source changed after the suggestion → stale, content untouched.
    await db.update(items).set({ data: { title: { en: 'Hello again' } } }).where(eq(items.id, `${SITE}_p1`));
    const title = by(`item:posts:${SITE}_p1:title`);
    expect(await decideSuggestion(db, SITE, title.id, { decision: 'approve' }, { userId: null }, access())).toMatchObject({ status: 'stale' });

    // A refused write leaves the suggestion pending.
    const third = by(`item:posts:${SITE}_p3:title`);
    const refusing: ReviewItemAccess = { ...access(), patch: async () => { throw Object.assign(new Error('Forbidden field'), { code: 'FORBIDDEN' }); } };
    await expect(decideSuggestion(db, SITE, third.id, { decision: 'approve' }, { userId: null }, refusing)).rejects.toThrow('Forbidden field');
    const [stillPending] = await db.select().from(translationSuggestions).where(eq(translationSuggestions.id, third.id));
    expect(stillPending!.status).toBe('pending');
    expect(await decideSuggestion(db, SITE, third.id, { decision: 'reject' }, { userId: null }, access())).toMatchObject({ status: 'rejected' });

    // UI string approval upserts the translations row.
    const ui = by('ui:ui:save');
    await decideSuggestion(db, SITE, ui.id, { decision: 'approve' }, { userId: null }, access());
    const [saved] = await db.select().from(translations).where(and(eq(translations.siteId, SITE), eq(translations.language, 'ja'), eq(translations.key, 'save')));
    expect(saved!.value).toBe('ja:SAVE');

    // Another site cannot decide this site's suggestion.
    await expect(decideSuggestion(db, OTHER, ui.id, { decision: 'reject' }, { userId: null }, access(OTHER))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await getLocaleJob(db, SITE, job.id)).review).toEqual({ approved: 2, stale: 1, rejected: 1 });
  });
});
