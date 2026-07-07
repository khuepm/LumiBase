import { extensionVotes, type Database } from '@lumibase/database';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../../env';
import { marketplaceRouter } from '../marketplace';

type Row = Record<string, unknown>;

interface State {
  extensions: Row[];
  votes: Array<{ marketplaceSlug: string; userId: string }>;
}

/**
 * Stateful, table-aware mock covering the mutation chains the community routes
 * use: select/insert(onConflictDoNothing|returning)/update(set.where[.returning])/delete.
 * It is deliberately predicate-blind — tests are seeded with a single logical
 * subject so the coarse mutations (e.g. delete clears votes) behave correctly.
 */
function makeDb(state: State): Database {
  return {
    select: () => {
      let data: unknown[] = state.extensions;
      const fluent = {
        from: (table: unknown) => {
          data = table === extensionVotes ? state.votes : state.extensions;
          return fluent;
        },
        where: () => Promise.resolve(data),
      };
      return fluent;
    },
    insert: (table: unknown) => ({
      values: (vals: Row | Row[]) => {
        const arr = Array.isArray(vals) ? vals : [vals];
        return {
          onConflictDoNothing: () => {
            if (table === extensionVotes) {
              for (const v of arr) {
                const exists = state.votes.some(
                  (x) =>
                    x.userId === v.userId &&
                    x.marketplaceSlug === v.marketplaceSlug,
                );
                if (!exists)
                  state.votes.push(
                    v as { marketplaceSlug: string; userId: string },
                  );
              }
            }
            return Promise.resolve();
          },
          returning: () => {
            if (table !== extensionVotes) state.extensions.push(...arr);
            return Promise.resolve(arr);
          },
        };
      },
    }),
    update: () => ({
      set: (patch: Row) => ({
        where: () => {
          const result =
            state.extensions.length > 0
              ? [{ ...state.extensions[0], ...patch }]
              : [];
          return Object.assign(Promise.resolve(result), {
            returning: () => Promise.resolve(result),
          });
        },
      }),
    }),
    delete: () => ({
      where: () => {
        state.votes = [];
        return Promise.resolve();
      },
    }),
  } as unknown as Database;
}

function buildApp(state: State, userId: string | null) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('siteId', 'site_1');
    c.set('db', makeDb(state));
    c.set('runtime', { cache: undefined } as never);
    if (userId) c.set('auth', { userId } as never);
    await next();
  });
  app.route('/api/v1/marketplace', marketplaceRouter);
  return app;
}

const published: Row = {
  id: 'ext_1',
  siteId: null,
  name: 'SEO Toolkit',
  version: '1.0.0',
  type: 'module',
  bundleUrl: 'https://cdn.example/seo.js',
  bundleSha256: 'a'.repeat(64),
  signature: 'sig',
  signatureAlg: 'ed25519',
  publisherKeyId: 'key_1',
  publisher: 'LumiBase',
  marketplaceSlug: 'seo-toolkit',
  publishedAt: new Date('2026-06-01T00:00:00.000Z'),
  downloadCount: 5,
  submissionStatus: null,
  submittedBy: null,
};

describe('marketplace download', () => {
  it('redirects to the bundle by default', async () => {
    const app = buildApp({ extensions: [{ ...published }], votes: [] }, null);
    const res = await app.request('/api/v1/marketplace/extensions/seo-toolkit/download', {
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://cdn.example/seo.js');
  });

  it('returns bundle metadata with an incremented count when redirect=0', async () => {
    const app = buildApp({ extensions: [{ ...published }], votes: [] }, null);
    const res = await app.request(
      '/api/v1/marketplace/extensions/seo-toolkit/download?redirect=0',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({
      slug: 'seo-toolkit',
      bundleUrl: 'https://cdn.example/seo.js',
      bundleSha256: 'a'.repeat(64),
      downloadCount: 6,
    });
  });

  it('404s for an unknown slug', async () => {
    const app = buildApp({ extensions: [], votes: [] }, null);
    const res = await app.request('/api/v1/marketplace/extensions/nope/download');
    expect(res.status).toBe(404);
  });
});

describe('marketplace voting', () => {
  it('requires authentication', async () => {
    const app = buildApp({ extensions: [{ ...published }], votes: [] }, null);
    const res = await app.request('/api/v1/marketplace/extensions/seo-toolkit/vote', {
      method: 'POST',
    });
    expect(res.status).toBe(401);
  });

  it('records an upvote and reports the new tally', async () => {
    const state: State = { extensions: [{ ...published }], votes: [] };
    const app = buildApp(state, 'user_1');
    const res = await app.request('/api/v1/marketplace/extensions/seo-toolkit/vote', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { slug: 'seo-toolkit', voteCount: 1, hasVoted: true },
    });
    expect(state.votes).toHaveLength(1);
  });

  it('is idempotent for a repeat vote from the same user', async () => {
    const state: State = { extensions: [{ ...published }], votes: [] };
    const app = buildApp(state, 'user_1');
    await app.request('/api/v1/marketplace/extensions/seo-toolkit/vote', { method: 'POST' });
    const res = await app.request('/api/v1/marketplace/extensions/seo-toolkit/vote', {
      method: 'POST',
    });
    const body = (await res.json()) as { data: { voteCount: number } };
    expect(body.data.voteCount).toBe(1);
    expect(state.votes).toHaveLength(1);
  });

  it('removes a vote on DELETE', async () => {
    const state: State = {
      extensions: [{ ...published }],
      votes: [{ marketplaceSlug: 'seo-toolkit', userId: 'user_1' }],
    };
    const app = buildApp(state, 'user_1');
    const res = await app.request('/api/v1/marketplace/extensions/seo-toolkit/vote', {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { slug: 'seo-toolkit', voteCount: 0, hasVoted: false },
    });
  });

  it('404s when voting for an unpublished slug', async () => {
    const app = buildApp({ extensions: [], votes: [] }, 'user_1');
    const res = await app.request('/api/v1/marketplace/extensions/ghost/vote', {
      method: 'POST',
    });
    expect(res.status).toBe(404);
  });
});

describe('marketplace community submission', () => {
  const validBody = {
    name: 'My Widget',
    version: '0.1.0',
    type: 'panel',
    marketplaceSlug: 'my-widget',
    bundleUrl: 'https://cdn.example/my-widget.js',
    description: 'A handy widget.',
    publisher: 'Acme',
  };

  it('requires authentication', async () => {
    const app = buildApp({ extensions: [], votes: [] }, null);
    const res = await app.request('/api/v1/marketplace/submit', {
      method: 'POST',
      body: JSON.stringify(validBody),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(401);
  });

  it('creates a pending, unpublished listing', async () => {
    const state: State = { extensions: [], votes: [] };
    const app = buildApp(state, 'user_1');
    const res = await app.request('/api/v1/marketplace/submit', {
      method: 'POST',
      body: JSON.stringify(validBody),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({
      marketplaceSlug: 'my-widget',
      submissionStatus: 'pending',
      submittedBy: 'user_1',
      publishedAt: null,
    });
  });

  it('rejects a slug already live in the catalog', async () => {
    const app = buildApp({ extensions: [{ ...published, marketplaceSlug: 'my-widget' }], votes: [] }, 'user_1');
    const res = await app.request('/api/v1/marketplace/submit', {
      method: 'POST',
      body: JSON.stringify(validBody),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(409);
  });

  it('validates the payload', async () => {
    const app = buildApp({ extensions: [], votes: [] }, 'user_1');
    const res = await app.request('/api/v1/marketplace/submit', {
      method: 'POST',
      body: JSON.stringify({ ...validBody, version: 'not-semver' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(400);
  });
});
