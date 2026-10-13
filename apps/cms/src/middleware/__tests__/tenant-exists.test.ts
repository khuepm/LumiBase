import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { withTenantExists } from '../tenant-exists';

/** Stand-in for the cache's tombstone envelope. */
const NEGATIVE = Symbol('negative');

/**
 * Unit tests for `withTenantExists`.
 *
 * `withTenant` shape-checks `X-Lumi-Site` but deliberately never verifies the
 * site exists (see `identifier-guard.ts`). This middleware closes that gap
 * before `withAuth` — the first middleware to write an audit row carrying
 * `siteId` — so an unverified id can never reach `audit_log.site_id` and
 * violate its FK to `sites.id`.
 */

interface Opts {
  readonly siteId?: string;
  readonly known?: string[];
  readonly dbThrows?: boolean;
}

/**
 * Minimal Drizzle stand-in answering `select().from(sites).where().limit()`.
 *
 * It counts lookups rather than decoding the `eq()` condition: the middleware
 * only ever asks about the one site id on the context, so the count is what
 * the cache assertions actually care about, and it does not couple the test to
 * drizzle's internal SQL-chunk representation.
 */
function makeDb(known: string[], siteId: string | undefined, dbThrows = false) {
  const lookups: string[] = [];
  const db = {
    select() {
      return {
        from() {
          return {
            where() {
              lookups.push(siteId ?? '');
              return {
                limit() {
                  if (dbThrows) return Promise.reject(new Error('db down'));
                  return Promise.resolve(
                    siteId !== undefined && known.includes(siteId) ? [{ id: siteId }] : [],
                  );
                },
              };
            },
          };
        },
      };
    },
  };
  return { db: db as never, lookups };
}

function buildApp(opts: Opts & { cacheImpl?: Map<string, unknown> }) {
  const { db, lookups } = makeDb(opts.known ?? [], opts.siteId, opts.dbThrows);
  const store = opts.cacheImpl;
  // Mirrors the four-state CacheProvider surface the service actually uses:
  // `getEntry` (hit / negative / miss) plus `set` and `setNegative`.
  const cache = store
    ? {
        getEntry: vi.fn(async (k: string) => {
          if (!store.has(k)) return { state: 'miss' as const };
          const v = store.get(k);
          return v === NEGATIVE
            ? { state: 'negative' as const }
            : { state: 'hit' as const, value: v };
        }),
        set: vi.fn(async (k: string, v: unknown) => {
          store.set(k, v);
        }),
        setNegative: vi.fn(async (k: string) => {
          store.set(k, NEGATIVE);
        }),
        delete: vi.fn(async (k: string) => {
          store.delete(k);
        }),
      }
    : undefined;

  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    if (opts.siteId !== undefined) c.set('siteId', opts.siteId);
    c.set('db', db);
    if (cache) c.set('runtime', { cache } as never);
    await next();
  });
  app.use('*', withTenantExists());
  app.get('/probe', (c) => c.json({ ok: true, siteId: c.get('siteId') ?? null }));

  return { app, lookups, cache };
}

describe('withTenantExists', () => {
  it('passes a request through when the site exists', async () => {
    const { app } = buildApp({ siteId: 'real-site', known: ['real-site'] });
    const res = await app.request('/probe');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, siteId: 'real-site' });
  });

  it('rejects an unknown site id with 404 before any handler runs', async () => {
    // The reported crash: `X-Lumi-Site: some-other-site` survived `withTenant`
    // and reached the audit write. It must be stopped here instead.
    const { app } = buildApp({ siteId: 'some-other-site', known: ['real-site'] });
    const res = await app.request('/probe');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      errors: [{ code: 'TENANT_NOT_FOUND', message: 'Unknown site.' }],
    });
  });

  it('caches the negative verdict so a bad-id flood is not a query per request', async () => {
    const store = new Map<string, unknown>();
    const { app, lookups } = buildApp({
      siteId: 'some-other-site',
      known: ['real-site'],
      cacheImpl: store,
    });

    for (let i = 0; i < 5; i++) {
      expect((await app.request('/probe')).status).toBe(404);
    }

    expect(lookups).toEqual(['some-other-site']); // one lookup, four cache hits
  });

  it('caches the positive verdict too', async () => {
    const store = new Map<string, unknown>();
    const { app, lookups } = buildApp({
      siteId: 'real-site',
      known: ['real-site'],
      cacheImpl: store,
    });

    for (let i = 0; i < 3; i++) {
      expect((await app.request('/probe')).status).toBe(200);
    }

    expect(lookups).toEqual(['real-site']);
  });

  it('fails open when the existence lookup itself errors', async () => {
    // This guard must not become an availability dependency: a broken DB should
    // fail on the request's real query, not turn every request into a bogus 404.
    const { app } = buildApp({ siteId: 'real-site', known: ['real-site'], dbThrows: true });

    expect((await app.request('/probe')).status).toBe(200);
  });

  it('is a no-op when no siteId was resolved', async () => {
    const { app, lookups } = buildApp({ known: ['real-site'] });

    expect((await app.request('/probe')).status).toBe(200);
    expect(lookups).toEqual([]);
  });
});
