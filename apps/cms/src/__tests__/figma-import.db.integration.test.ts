import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { agentToolSecrets, collections, fields, sites, type Database } from '@lumibase/database';
import { MemoryCacheProvider, type KeyProvider } from '@lumibase/runtime';
import type { AppEnv } from '../env';
import { ItemService } from '../services/item-service';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { HERO_FRAME, nodesResponse } from '../modules/figma/__tests__/fixtures';

vi.mock('../middleware/site-admin', () => ({
  requireSiteAdmin: () => async (_c: unknown, next: () => Promise<void>) => next(),
  isSiteAdmin: async () => true,
}));

const { figmaRouter, figmaDeps } = await import('../modules/figma/routes');

/**
 * Figma frame → working block on real PostgreSQL (#758): the token is stored
 * encrypted and never returned; preview writes nothing; import creates the
 * hidden block-template collection with mapped fields and display template,
 * adds it to a page's `blocks` field, and the ItemService then accepts an
 * item that uses the new block with its mapped fields.
 */

const SITE = 'site_figma_it';
const TOKEN = 'figd_test_token_0123456789abcdef';
const URL = 'https://www.figma.com/design/AbCdEf123456/Landing?node-id=12-34';

const keys: KeyProvider = {
  getActiveKey: async () => ({ keyId: 'v1', key: Buffer.alloc(32, 7).toString('base64') }),
  getKey: async () => Buffer.alloc(32, 7).toString('base64'),
  listKeys: async () => [{ keyId: 'v1', status: 'active', algo: 'AES-GCM' }],
};

describe.skipIf(!hasDbIntegrationUrl)('Figma import (real PostgreSQL)', () => {
  let db: Database;
  const seenTokens: string[] = [];

  const app = () => {
    const a = new Hono<AppEnv>();
    a.use('*', async (c, next) => {
      c.set('db', db as never);
      c.set('siteId', SITE);
      c.set('auth', { userId: null, roles: ['admin'], raw: {} } as unknown as AppEnv['Variables']['auth']);
      c.set('runtime', { cache: new MemoryCacheProvider(), keys, queue: { enqueue: async () => undefined } } as unknown as AppEnv['Variables']['runtime']);
      await next();
    });
    a.route('/api/v1/integrations/figma', figmaRouter);
    return a;
  };
  const call = (path: string, method: string, body?: unknown) =>
    app().request(`/api/v1/integrations/figma${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  beforeAll(async () => {
    db = await connectDbIntegration('figma-import');
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.insert(sites).values({
      organizationId: sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`,
      id: SITE,
      name: 'Figma IT',
    });
    const [pagesCol] = await db.insert(collections).values({ siteId: SITE, name: 'landing_pages' }).returning();
    await db.insert(fields).values([
      { siteId: SITE, collectionId: pagesCol!.id, name: 'title', type: 'string', interface: 'input' },
      { siteId: SITE, collectionId: pagesCol!.id, name: 'sections', type: 'blocks', interface: 'blocks', options: { allowedBlocks: [] } },
    ]);
    figmaDeps.fetch = async (_url, init) => {
      seenTokens.push(new Headers(init?.headers).get('x-figma-token') ?? '');
      return new Response(JSON.stringify(nodesResponse(HERO_FRAME)), { status: 200 });
    };
  });

  afterAll(async () => {
    figmaDeps.fetch = undefined;
    if (db) await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
  });

  it('refuses to read Figma before a token is stored, then stores it encrypted and never returns it', async () => {
    expect(await (await call('', 'GET')).json()).toEqual({ data: { hasToken: false } });
    const noToken = await call('/preview', 'POST', { url: URL });
    expect(noToken.status).toBe(422);
    expect((await call('/token', 'PUT', { token: 'short' })).status).toBe(400);
    const put = await call('/token', 'PUT', { token: TOKEN });
    expect(await put.json()).toEqual({ data: { hasToken: true } });
    const [row] = await db.select().from(agentToolSecrets).where(and(eq(agentToolSecrets.siteId, SITE), eq(agentToolSecrets.name, 'FIGMA_TOKEN')));
    expect(row!.ciphertext).not.toContain(TOKEN);
    expect(JSON.stringify(await (await call('', 'GET')).json())).not.toContain(TOKEN);
  });

  it('previews a frame without writing anything', async () => {
    const res = await call('/preview', 'POST', { url: URL });
    const body = (await res.json()) as { data: { collection: string; fields: Array<{ name: string }>; theme: { light: Record<string, string> }; source: unknown } };
    expect(res.status).toBe(200);
    expect(body.data.collection).toBe('block_hero_card');
    expect(body.data.fields.map((f) => f.name)).toEqual(['background', 'title', 'body_copy', 'label', 'label_url']);
    expect(body.data.theme.light['--primary']).toBe('243.4 75.4% 58.6%');
    expect(body.data.source).toEqual({ fileKey: 'AbCdEf123456', nodeId: '12:34' });
    expect(seenTokens.at(-1)).toBe(TOKEN);
    expect(await db.select().from(collections).where(and(eq(collections.siteId, SITE), eq(collections.name, 'block_hero_card')))).toEqual([]);
  });

  it('imports one frame into a working block with mapped fields', async () => {
    const res = await call('/import', 'POST', { url: URL, addToBlocksField: { collection: 'landing_pages', field: 'sections' } });
    expect(res.status, await res.clone().text()).toBe(201);
    expect(((await res.json()) as { data: { addedToBlocksField: string } }).data.addedToBlocksField).toBe('landing_pages.sections');

    const [col] = await db.select().from(collections).where(and(eq(collections.siteId, SITE), eq(collections.name, 'block_hero_card')));
    expect(col).toMatchObject({ hidden: true, label: 'Hero Card', displayTemplate: '{{title}}' });
    expect((col!.meta as { figma: { fileKey: string; nodeId: string } }).figma).toMatchObject({ fileKey: 'AbCdEf123456', nodeId: '12:34' });
    const blockFields = await db.select().from(fields).where(and(eq(fields.siteId, SITE), eq(fields.collectionId, col!.id)));
    expect(Object.fromEntries(blockFields.map((f) => [f.name, f.interface]))).toEqual({
      background: 'file',
      title: 'input',
      body_copy: 'input-multiline',
      label: 'input',
      label_url: 'input',
    });

    // The block is usable: an item with it validates and round-trips.
    const items = new ItemService({ db, siteId: SITE });
    const created = await items.create('landing_pages', {
      data: {
        title: 'Home',
        sections: [{ type: 'block_hero_card', data: { title: 'Ship content faster', body_copy: 'Long text', label: 'Get started', label_url: '/start' } }],
      },
    });
    expect((created.data as { sections: Array<{ type: string; data: { label_url: string } }> }).sections[0]).toMatchObject({
      type: 'block_hero_card',
      data: { label_url: '/start' },
    });
    // Unknown fields of the block are rejected like any block data.
    await expect(
      items.create('landing_pages', { data: { title: 'x', sections: [{ type: 'block_hero_card', data: { nope: 1 } }] } }),
    ).rejects.toThrow();
  });

  it('refuses to overwrite an existing collection and validates the blocks target', async () => {
    expect((await call('/import', 'POST', { url: URL })).status).toBe(409);
    const badTarget = await call('/import', 'POST', { url: URL, collection: 'hero_two', addToBlocksField: { collection: 'landing_pages', field: 'title' } });
    expect(badTarget.status).toBe(404);
    expect(await db.select().from(collections).where(and(eq(collections.siteId, SITE), eq(collections.name, 'hero_two')))).toEqual([]);
    expect((await call('/preview', 'POST', { url: 'https://evil.example/design/AbCdEf123456?node-id=1-2' })).status).toBe(400);
  });

  it('deletes the token', async () => {
    expect(await (await call('/token', 'DELETE')).json()).toEqual({ data: { hasToken: false } });
    expect((await call('/preview', 'POST', { url: URL })).status).toBe(422);
  });
});
