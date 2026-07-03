import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { Database } from '@lumibase/database';
import type { AppEnv } from '../../env';
import { meRouter } from '../auth';

/**
 * Unit tests for `GET`/`PATCH /api/v1/me/preferences`.
 *
 * Focus on handler behaviour (the DB is a fluent shim, like the
 * `me-admin-path` test): GET returns the stored blob, PATCH validates +
 * shallow-merges into the existing preferences and writes back. The
 * keybindings section is the motivating use case.
 */

interface FakeDbState {
  preferences: Record<string, unknown>;
  lastSet: Record<string, unknown> | null;
  userId: string | null;
}

function makeFakeDb(initial: { preferences: Record<string, unknown> }): {
  db: Database;
  state: FakeDbState;
} {
  const state: FakeDbState = {
    preferences: initial.preferences,
    lastSet: null,
    userId: 'usr_test',
  };

  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    limit: () =>
      Promise.resolve(
        state.userId ? [{ preferences: state.preferences }] : [],
      ),
  };

  const db = {
    select: () => selectChain,
    update: () => ({
      set: (vals: Record<string, unknown>) => {
        state.lastSet = vals;
        return { where: () => Promise.resolve([]) };
      },
    }),
  } as unknown as Database;

  return { db, state };
}

function buildApp(db: Database): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', db);
    c.set('auth', {
      userId: 'usr_test',
      email: 'admin@example.com',
      roles: ['admin'],
      raw: {},
    } as never);
    await next();
  });
  app.route('/api/v1/me', meRouter);
  return app;
}

describe('GET /api/v1/me/preferences', () => {
  it('returns the stored preferences blob', async () => {
    const { db } = makeFakeDb({
      preferences: { keybindings: { 'editor.save': 'mod+shift+s' } },
    });
    const res = await buildApp(db).request('/api/v1/me/preferences');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { keybindings: { 'editor.save': 'mod+shift+s' } },
    });
  });

  it('returns {} when the row has no preferences', async () => {
    const { db } = makeFakeDb({ preferences: {} });
    const res = await buildApp(db).request('/api/v1/me/preferences');
    expect(await res.json()).toEqual({ data: {} });
  });
});

describe('PATCH /api/v1/me/preferences', () => {
  it('shallow-merges the patch into existing preferences', async () => {
    const { db, state } = makeFakeDb({
      preferences: { language: 'en', keybindings: { 'editor.save': 'mod+s' } },
    });
    const res = await buildApp(db).request('/api/v1/me/preferences', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keybindings: { 'palette.open': 'mod+k' } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    // language preserved; keybindings section replaced wholesale.
    expect(body.data).toEqual({
      language: 'en',
      keybindings: { 'palette.open': 'mod+k' },
    });
    expect((state.lastSet?.preferences as Record<string, unknown>)).toEqual(
      body.data,
    );
  });

  it('rejects an invalid chord with a 400', async () => {
    const { db } = makeFakeDb({ preferences: {} });
    const res = await buildApp(db).request('/api/v1/me/preferences', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keybindings: { 'editor.save': 'not a chord!!' } }),
    });
    expect(res.status).toBe(400);
  });

  // save-default-preference (Req 1, 2): the saveAction key rides the same
  // endpoint — validated enum, merged without dropping other sections.
  it('accepts and merges a valid saveAction (Req 1.2)', async () => {
    const { db, state } = makeFakeDb({ preferences: { language: 'vi' } });
    const res = await buildApp(db).request('/api/v1/me/preferences', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ saveAction: 'return' }),
    });
    expect(res.status).toBe(200);
    expect(state.lastSet?.preferences).toEqual({ language: 'vi', saveAction: 'return' });
  });

  it('rejects an invalid saveAction enum with 400 (Req 2.2)', async () => {
    const { db } = makeFakeDb({ preferences: {} });
    const res = await buildApp(db).request('/api/v1/me/preferences', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ saveAction: 'bogus' }),
    });
    expect(res.status).toBe(400);
  });

  it('accepts saveAction: null to fall back to the site default (Req 7.2)', async () => {
    const { db, state } = makeFakeDb({ preferences: { saveAction: 'return' } });
    const res = await buildApp(db).request('/api/v1/me/preferences', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ saveAction: null }),
    });
    expect(res.status).toBe(200);
    // Stored as null — resolveSaveAction treats null as "not configured".
    expect((state.lastSet?.preferences as Record<string, unknown>).saveAction).toBeNull();
  });
});
