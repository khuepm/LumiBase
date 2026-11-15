import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  buildStudioIntentPath,
  buildStudioIntentUrl,
  parseStudioIntent,
  studioIntentRoute,
  type StudioIntent,
} from '@lumibase/contracts/intents';

const q = (s: string) => new URLSearchParams(s);

describe('parseStudioIntent — validation', () => {
  it('accepts a full edit intent', () => {
    const r = parseStudioIntent('edit', q('collection=posts&id=p1&locale=vi&field=title&site=site_2&v=1'));
    expect(r).toEqual({
      ok: true,
      intent: { v: 1, action: 'edit', collection: 'posts', id: 'p1', locale: 'vi', field: 'title', site: 'site_2' },
    });
  });

  it.each([
    ['delete', 'collection=posts&id=p1', 'unknown_action'],
    ['edit', 'collection=posts', 'missing_param'],
    ['edit', 'id=p1', 'missing_param'],
    ['create', 'collection=posts&id=p1', 'forbidden_param'],
    ['open', 'collection=posts&field=title', 'forbidden_param'],
    ['edit', 'collection=posts&id=p1&evil=1', 'unknown_param'],
    ['edit', 'collection=posts&id=p1&id=p2', 'duplicate_param'],
    ['edit', 'collection=posts&id=p1&v=2', 'unsupported_version'],
    ['edit', 'collection=po/sts&id=p1', 'invalid_param'],
    ['edit', 'collection=posts&id=../x', 'invalid_param'],
    ['edit', 'collection=posts&id=new', 'invalid_param'],
    ['edit', 'collection=posts&id=reviews', 'invalid_param'],
    ['edit', 'collection=posts&id=p1&locale=<script>', 'invalid_param'],
    ['edit', 'collection=posts&id=p1&field=a.b', 'invalid_param'],
    ['edit', 'collection=posts&id=p1&site=a b', 'invalid_param'],
  ])('%s ?%s → %s', (action, qs, code) => {
    const r = parseStudioIntent(action, q(qs));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.code)).toContain(code);
  });

  it('tolerates utm_* tracking params', () => {
    expect(parseStudioIntent('open', q('collection=posts&utm_source=slack')).ok).toBe(true);
  });

  it('accepts a plain record as the param source', () => {
    expect(parseStudioIntent('open', { collection: 'posts', id: undefined }).ok).toBe(true);
  });
});

describe('studioIntentRoute — resolution matrix', () => {
  const base = { v: 1 as const, collection: 'posts' };
  it.each<[StudioIntent, string, Record<string, string>]>([
    [{ ...base, action: 'open' }, '/content/posts', {}],
    [{ ...base, action: 'open', id: 'p1' }, '/content/posts/p1', {}],
    [{ ...base, action: 'open', id: 'p1', locale: 'vi' }, '/content/posts/p1', { locale: 'vi' }],
    [{ ...base, action: 'edit', id: 'p1', field: 'title' }, '/content/posts/p1', { field: 'title' }],
    [
      { ...base, action: 'edit', id: 'p1', locale: 'pt-BR', field: 'body' },
      '/content/posts/p1',
      { locale: 'pt-BR', field: 'body' },
    ],
    [{ ...base, action: 'create' }, '/content/posts/new', {}],
    [{ ...base, action: 'create', field: 'title' }, '/content/posts/new', { field: 'title' }],
    [{ ...base, action: 'open', locale: 'vi' }, '/content/posts', {}],
  ])('%j → %s', (intent, pathname, search) => {
    expect(studioIntentRoute(intent)).toEqual({ pathname, search });
  });
});

describe('builders', () => {
  it('emits canonical param order and omits the default version', () => {
    expect(
      buildStudioIntentPath({ action: 'edit', site: 's1', field: 'title', id: 'p1', collection: 'posts', locale: 'vi' }),
    ).toBe('/intent/edit?collection=posts&id=p1&locale=vi&field=title&site=s1');
  });

  it('refuses to mint a link Studio would refuse', () => {
    expect(() => buildStudioIntentPath({ action: 'edit', collection: 'posts' })).toThrow(/id: missing_param/);
    expect(() => buildStudioIntentPath({ action: 'edit', collection: 'posts', id: 'a/b' })).toThrow();
  });

  it('builds absolute URLs with the admin path and drops any base path', () => {
    expect(
      buildStudioIntentUrl(
        { action: 'edit', collection: 'posts', id: 'p1' },
        { studioUrl: 'https://cms.example.com/ignored?x=1', adminPath: 'lumi-7f3a9c' },
      ),
    ).toBe('https://cms.example.com/lumi-7f3a9c/intent/edit?collection=posts&id=p1');
  });

  it('rejects non-http origins and malformed admin paths', () => {
    const intent = { action: 'open' as const, collection: 'posts' };
    expect(() => buildStudioIntentUrl(intent, { studioUrl: 'javascript:alert(1)' })).toThrow();
    expect(() => buildStudioIntentUrl(intent, { studioUrl: 'not a url' })).toThrow();
    expect(() => buildStudioIntentUrl(intent, { studioUrl: 'https://x.test', adminPath: '/../evil' })).toThrow();
  });

  it('property: every built path parses back to the same intent', () => {
    const ident = fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,20}$/);
    const id = fc.stringMatching(/^[A-Za-z0-9_-]{1,30}$/).filter((s) => s !== 'new' && s !== 'reviews');
    fc.assert(
      fc.property(
        ident,
        id,
        fc.option(fc.constantFrom('en', 'vi', 'pt-BR', 'zh-Hant-TW'), { nil: undefined }),
        fc.option(ident, { nil: undefined }),
        fc.option(fc.stringMatching(/^[A-Za-z0-9_-]{1,20}$/), { nil: undefined }),
        (collection, itemId, locale, field, site) => {
          const input = { action: 'edit' as const, collection, id: itemId, locale, field, site };
          const path = buildStudioIntentPath(input);
          const [pathname, qs] = path.split('?');
          expect(pathname).toBe('/intent/edit');
          const parsed = parseStudioIntent('edit', new URLSearchParams(qs));
          expect(parsed.ok).toBe(true);
          if (parsed.ok) {
            expect(parsed.intent).toEqual(
              Object.fromEntries(Object.entries({ v: 1, ...input }).filter(([, v]) => v !== undefined)),
            );
          }
        },
      ),
    );
  });
});
