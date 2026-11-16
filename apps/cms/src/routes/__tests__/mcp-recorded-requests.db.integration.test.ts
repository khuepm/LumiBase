import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CdcSubscriptionCreateSchema,
  CdcSubscriptionPatchSchema,
} from '@lumibase/contracts';
import {
  cdcSubscriptions,
  collections,
  fields,
  items,
  policies,
  sites,
  userPolicies,
  users,
  type Database,
} from '@lumibase/database';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { AppEnv } from '../../env';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
import { createCdcFeedRouter } from '../../modules/cdc/change-feed/routes';
import { mapCacheProvider } from '../../test-utils/cache-provider';
import { collectionsRouter, schemaInputSchema } from '../collections';

/**
 * #716 review: a real tool → REST regression for the stdio MCP server.
 *
 * `packages/mcp-server/src/__tests__/tool-schema-fidelity.test.ts` (§6) calls
 * the REGISTERED stdio tools (`apply_schema`, `diff_schema`,
 * `create_cdc_subscription`, `update_cdc_subscription`) through the MCP SDK
 * client and pins the exact `{method, path, body}` each sends in
 * `golden/mcp-recorded-requests.json`. This file replays those requests,
 * unmodified and in order, against the real routes. The two packages do not
 * depend on each other, so the golden is the seam; CI fails on either side if
 * it drifts (`toMatchFileSnapshot` never writes under `CI=true`).
 *
 * - Without a database: every recorded body survives the route's own Zod with
 *   no key stripped (the original bug: `encrypted`/`classification` vanished).
 * - With `DATABASE_URL`: the routes run over PostgreSQL with a real admin
 *   policy, and the persisted rows are asserted — the PII field is stored
 *   encrypted and classified, `migrationPlan` alone passes the risky-change
 *   guard, and `status` pauses then resumes a subscription whose `kind` stays.
 */

interface RecordedRequest {
  label: string;
  tool: string;
  method: string;
  path: string;
  body: Record<string, unknown>;
}

const GOLDEN = fileURLToPath(
  new URL('../../../../../packages/mcp-server/src/__tests__/fidelity/golden/mcp-recorded-requests.json', import.meta.url),
);
const RECORDED = JSON.parse(readFileSync(GOLDEN, 'utf8')) as RecordedRequest[];

/** The Zod object each route's handler parses the body with. */
function routeSchema(req: RecordedRequest): z.ZodType {
  if (req.method === 'PUT' && /^\/collections\/[^/]+\/schema$/.test(req.path)) return schemaInputSchema;
  if (req.method === 'POST' && req.path === '/collections/diff') return schemaInputSchema;
  if (req.method === 'POST' && req.path === '/cdc/subscriptions') return CdcSubscriptionCreateSchema;
  if (req.method === 'PATCH' && /^\/cdc\/subscriptions\/[^/]+$/.test(req.path)) return CdcSubscriptionPatchSchema;
  throw new Error(`no route schema for ${req.method} ${req.path}`);
}

const byTool = (tool: string) => RECORDED.filter((r) => r.tool === tool);

describe('#716 recorded stdio MCP requests vs the REST route schemas', () => {
  it('the golden covers the tools the review named', () => {
    expect(byTool('apply_schema').length).toBeGreaterThanOrEqual(2);
    expect(byTool('diff_schema').length).toBeGreaterThanOrEqual(1);
    expect(byTool('update_cdc_subscription').map((r) => r.body['status'])).toEqual(['paused', 'active']);
  });

  it.each(RECORDED.map((r) => [r.label, r] as const))('%s: the route keeps every key the tool sent', (_label, req) => {
    const parsed = routeSchema(req).safeParse(req.body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(parsed.data).toMatchObject(req.body);
  });

  it('the first apply_schema really carries the security-sensitive field keys', () => {
    const email = (byTool('apply_schema')[0]!.body['fields'] as Array<Record<string, unknown>>).find((f) => f['name'] === 'email');
    expect(email).toMatchObject({ encrypted: true, classification: 'pii', length: 320, rawEnabled: false });
    expect(email).toHaveProperty('validation');
    expect(email).toHaveProperty('displayOptions');
  });
});

const SITE = 'mcp716_replay_site';
const USER = 'mcp716_replay_user';
const POLICY = 'mcp716_replay_admin';
const COLLECTION = 'mcp716_customers';

describe.skipIf(!hasDbIntegrationUrl)('#716 recorded stdio MCP requests replayed against the real routes (DB)', () => {
  let db: Database;

  const app = () => {
    const hono = new Hono<AppEnv>();
    hono.use('*', async (c, next) => {
      c.set('db', db);
      c.set('siteId', SITE as never);
      c.set('auth', { userId: USER, roles: [], raw: {} } as never);
      c.set('runtime', { cache: mapCacheProvider(), queue: { enqueue: async () => undefined } } as never);
      await next();
    });
    hono.route('/collections', collectionsRouter);
    hono.route('/cdc', createCdcFeedRouter());
    return hono;
  };

  const send = (method: string, path: string, body: unknown) =>
    app().request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const cleanup = async () => {
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.delete(users).where(eq(users.id, USER));
  };

  beforeAll(async () => {
    db = await connectDbIntegration('mcp-recorded-requests');
  });

  beforeEach(async () => {
    await cleanup();
    await db.insert(sites).values({
      organizationId: sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`,
      id: SITE,
      name: SITE,
    });
    await db.insert(users).values({ id: USER, email: 'mcp716-replay@example.test' });
    await db.insert(policies).values({ id: POLICY, siteId: SITE, name: POLICY, adminAccess: true });
    await db.insert(userPolicies).values({ userId: USER, siteId: SITE, policyId: POLICY });
  });

  afterAll(async () => {
    if (db) await cleanup();
  });

  async function field(name: string) {
    const [row] = await db
      .select()
      .from(fields)
      .innerJoin(collections, eq(fields.collectionId, collections.id))
      .where(and(eq(fields.siteId, SITE), eq(collections.name, COLLECTION), eq(fields.name, name)));
    return row?.lumibase_fields;
  }

  it('replays every recorded request in order and persists what the agent asked for', async () => {
    const [createSchema, diff, migrate] = [
      byTool('apply_schema')[0]!,
      byTool('diff_schema')[0]!,
      byTool('apply_schema')[1]!,
    ];

    // 1. apply_schema creates the collection with an encrypted PII field.
    let res = await send(createSchema.method, createSchema.path, createSchema.body);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await field('email')).toMatchObject({
      encrypted: true,
      classification: 'pii',
      length: 320,
      required: true,
      rawEnabled: false,
      width: 'half',
      displayOptions: { mask: true },
      validation: { _and: [{ email: { _regex: '^.+@.+$' } }] },
    });
    expect(await field('total')).toMatchObject({ type: 'decimal', precision: 12, scale: 2 });

    // 2. diff_schema previews the classification and precision/scale changes.
    res = await send(diff.method, diff.path, diff.body);
    expect(res.status, await res.clone().text()).toBe(200);
    const preview = ((await res.json()) as { data: { fields: { changed: Array<{ name: string; changes: string[] }> } } }).data;
    expect(preview.fields.changed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'email', changes: ['classification'] }),
        expect.objectContaining({ name: 'total', changes: ['precision', 'scale'] }),
      ]),
    );
    expect(await field('email')).toMatchObject({ classification: 'pii' }); // a preview writes nothing

    // 3. migrationPlan is what lets the populated type change through.
    const [coll] = await db.select().from(collections).where(and(eq(collections.siteId, SITE), eq(collections.name, COLLECTION)));
    await db.insert(items).values({ siteId: SITE, collectionId: coll!.id, data: { total: 12.5 } });
    const withoutPlan = {
      ...migrate.body,
      fields: (migrate.body['fields'] as Array<Record<string, unknown>>).map(({ migrationPlan: _plan, ...f }) => f),
    };
    res = await send(migrate.method, migrate.path, withoutPlan);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe('FIELD_MIGRATION_REQUIRED');
    res = await send(migrate.method, migrate.path, migrate.body);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await field('total')).toMatchObject({ type: 'integer' });
    expect(await field('email')).toMatchObject({ encrypted: true, classification: 'pii' });

    // 4. CDC: create, then pause and resume through update_cdc_subscription.
    const [create] = byTool('create_cdc_subscription');
    res = await send(create!.method, create!.path, create!.body);
    expect(res.status, await res.clone().text()).toBe(201);
    const subscriptionId = ((await res.json()) as { data: { id: string } }).data.id;
    const subscription = async () =>
      (await db.select().from(cdcSubscriptions).where(eq(cdcSubscriptions.id, subscriptionId)))[0]!;

    const [pause, resume] = byTool('update_cdc_subscription');
    res = await send(pause!.method, pause!.path.replace('{subscriptionId}', subscriptionId), pause!.body);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await subscription()).toMatchObject({ status: 'paused', kind: 'pull' });

    res = await send(resume!.method, resume!.path.replace('{subscriptionId}', subscriptionId), resume!.body);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await subscription()).toMatchObject({ status: 'active', kind: 'pull', name: 'mcp716_pull_renamed', webhookId: null });
  });
});
