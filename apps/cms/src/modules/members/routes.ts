/**
 * Members admin surface (`/api/v1/members/*`, epic #672).
 *
 * Studio plane, site-admin only (`requireSiteAdmin`, and the prefix is in
 * `STUDIO_ACCESS_PATH_PREFIXES` so a `frontend` session can never reach it).
 * Every handler is bound to `c.get('siteId')`. Item reads/publishes for
 * "Publish & send" go through `itemServiceForRequest(c)`, so the caller's own
 * permissions apply to the item (DoD §2c).
 *
 *   GET/PATCH  /settings
 *   GET/POST   /tiers · PATCH/DELETE /tiers/:id · GET/PUT/DELETE /tiers/:id/access[/:collection]
 *   GET/POST   /segments · POST /segments/preview · GET/PATCH/DELETE /segments/:id
 *   GET/POST   /newsletters · PATCH/DELETE /newsletters/:id
 *   GET        /newsletters/:id/audience · GET/POST /newsletters/:id/sends
 *   GET        /sends/:id · POST /sends/:id/cancel
 *   GET        /sequences/templates · POST /sequences/from-template
 *   GET/POST   /sequences · GET/PATCH/DELETE /sequences/:id
 *   GET        /sequences/:id/enrollments · POST /sequences/:id/enroll
 *   POST       /signup-card/install
 *   GET/POST   / · GET/PATCH/DELETE /:id · PUT /:id/newsletters/:newsletterId
 */

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../env';
import { requireSiteAdmin } from '../../middleware/site-admin';
import { bumpPermissionVersion } from '../../services/permission-invalidation';
import { itemServiceForRequest } from '../../services/item-service-factory';
import { ItemServiceError } from '../../services/item-service';
import { SchemaService } from '../../services/schema-service';
import { EmailService } from '../../services/email/email-service';
import { patchSchema } from '../../utils/patch-schema';
import { runDetached } from '../../lib/detached';
import { AuditLogger } from '../audit/logger';
import { MemberError, memberErrorResponse } from './errors';
import { MemberService, memberCreateSchema, memberUpdateSchema } from './member-service';
import {
  cancelSend,
  composeFromItem,
  composeOptionsSchema,
  countAudience,
  createNewsletter,
  createSend,
  deleteNewsletter,
  driveSend,
  getNewsletter,
  getSend,
  listNewsletters,
  listSends,
  newsletterInputSchema,
  toSendView,
  updateNewsletter,
} from './newsletters';
import { getMemberSettings, memberSettingsSchema, updateMemberSettings } from './portal';
import {
  createSegment,
  deleteSegment,
  getSegment,
  getSegmentRow,
  listSegments,
  parseSegmentFilter,
  previewSegment,
  segmentInputSchema,
  updateSegment,
} from './segments';
import {
  SEQUENCE_TEMPLATES,
  createSequence,
  createSequenceFromTemplate,
  deleteSequence,
  enrollMember,
  getSequence,
  listEnrollments,
  listSequences,
  sequenceInputSchema,
  updateSequence,
} from './sequences';
import { installSignupCard } from './signup-card';
import { mailerFactory } from './tick';
import {
  createTier,
  deleteTier,
  grantTierAccess,
  listTierAccess,
  listTiers,
  revokeTierAccess,
  tierInputSchema,
  updateTier,
} from './tiers';

export const membersRouter = new Hono<AppEnv>();
membersRouter.use('*', requireSiteAdmin());

const memberPatch = patchSchema(memberUpdateSchema);
const tierPatch = patchSchema(tierInputSchema);
const newsletterPatch = patchSchema(newsletterInputSchema);
const sequencePatch = patchSchema(sequenceInputSchema);
const settingsPatch = patchSchema(memberSettingsSchema);
const segmentPatch = patchSchema(segmentInputSchema);

function service(c: Context<AppEnv>): MemberService {
  return new MemberService({ db: c.get('db'), siteId: c.get('siteId'), queue: c.get('runtime')?.queue });
}

async function body(c: Context<AppEnv>): Promise<unknown> {
  return c.req.json().catch(() => ({}));
}

function audit(c: Context<AppEnv>, event: string, metadata: Record<string, unknown>, targetEmail: string | null = null) {
  return new AuditLogger({ db: c.get('db'), siteId: c.get('siteId') }).write({
    event,
    actorEmail: c.get('auth')?.email ?? null,
    targetEmail,
    ip: c.get('ip') ?? null,
    userAgent: c.get('userAgent') ?? null,
    requestId: c.get('requestId') ?? null,
    metadata,
  });
}

/** Wrap a handler so MemberError / ZodError map onto the envelope. */
/** A path parameter; the wrapper below erases Hono's path typing. */
function param(c: Context<AppEnv>, name: string): string {
  return c.req.param(name) ?? '';
}

function h(fn: (c: Context<AppEnv>) => Promise<Response>) {
  return async (c: Context<AppEnv>) => {
    try {
      return await fn(c);
    } catch (err) {
      return memberErrorResponse(c, err);
    }
  };
}

function linkBase(c: Context<AppEnv>): string {
  const configured = (c.env as unknown as Record<string, unknown> | undefined)?.LUMIBASE_PUBLIC_URL ?? process.env.LUMIBASE_PUBLIC_URL;
  return typeof configured === 'string' && configured ? configured.replace(/\/+$/, '') : new URL(c.req.url).origin;
}

// ── Settings ──────────────────────────────────────────────────────────────

membersRouter.get('/settings', h(async (c) => c.json({ data: await getMemberSettings(c.get('db'), c.get('siteId')) })));

membersRouter.patch(
  '/settings',
  h(async (c) => {
    const patch = settingsPatch.parse(await body(c));
    const data = await updateMemberSettings(c.get('db'), c.get('siteId'), patch);
    await audit(c, 'member_settings_updated', { keys: Object.keys(patch) });
    return c.json({ data });
  }),
);

// ── Tiers ─────────────────────────────────────────────────────────────────

membersRouter.get('/tiers', h(async (c) => c.json({ data: await listTiers(c.get('db'), c.get('siteId')) })));

membersRouter.post(
  '/tiers',
  h(async (c) => {
    const input = tierInputSchema.parse(await body(c));
    const data = await createTier(c.get('db'), c.get('siteId'), input);
    return c.json({ data }, 201);
  }),
);

membersRouter.patch(
  '/tiers/:id',
  h(async (c) => {
    const patch = tierPatch.parse(await body(c));
    const data = await updateTier(c.get('db'), c.get('siteId'), param(c, 'id'), patch);
    // `active` gates whether the tier policy is attached; bundles must recompile.
    await bumpPermissionVersion(c);
    return c.json({ data });
  }),
);

membersRouter.delete(
  '/tiers/:id',
  h(async (c) => {
    await deleteTier(c.get('db'), c.get('siteId'), param(c, 'id'));
    await bumpPermissionVersion(c);
    return c.json({ data: null });
  }),
);

membersRouter.get('/tiers/:id/access', h(async (c) => c.json({ data: await listTierAccess(c.get('db'), c.get('siteId'), param(c, 'id')) })));

const tierGrantSchema = z.object({
  collection: z.string().min(1).max(128),
  publishedOnly: z.boolean().optional(),
  fields: z.array(z.string().min(1).max(128)).max(200).optional(),
});

membersRouter.put(
  '/tiers/:id/access',
  h(async (c) => {
    const input = tierGrantSchema.parse(await body(c));
    const data = await grantTierAccess(c.get('db'), c.get('siteId'), param(c, 'id'), { ...input, action: 'read' });
    await bumpPermissionVersion(c);
    await audit(c, 'member_tier_access_granted', { tierId: param(c, 'id'), collection: data.collection });
    return c.json({ data });
  }),
);

membersRouter.delete(
  '/tiers/:id/access/:collection',
  h(async (c) => {
    const removed = await revokeTierAccess(c.get('db'), c.get('siteId'), param(c, 'id'), param(c, 'collection'));
    if (!removed) throw new MemberError('NOT_FOUND', 404, 'No such grant.');
    await bumpPermissionVersion(c);
    await audit(c, 'member_tier_access_revoked', { tierId: param(c, 'id'), collection: param(c, 'collection') });
    return c.json({ data: null });
  }),
);

// ── Segments ──────────────────────────────────────────────────────────────

membersRouter.get('/segments', h(async (c) => c.json({ data: await listSegments(c.get('db'), c.get('siteId')) })));

membersRouter.post(
  '/segments/preview',
  h(async (c) => {
    const { filter, limit } = z.object({ filter: z.unknown(), limit: z.number().int().optional() }).parse(await body(c));
    return c.json({ data: await previewSegment(c.get('db'), c.get('siteId'), filter, limit) });
  }),
);

membersRouter.post(
  '/segments',
  h(async (c) => {
    const input = segmentInputSchema.parse(await body(c));
    const data = await createSegment(c.get('db'), c.get('siteId'), input, c.get('auth')?.userId ?? null);
    return c.json({ data }, 201);
  }),
);

membersRouter.get('/segments/:id', h(async (c) => c.json({ data: await getSegment(c.get('db'), c.get('siteId'), param(c, 'id')) })));

membersRouter.patch(
  '/segments/:id',
  h(async (c) => {
    const patch = segmentPatch.parse(await body(c));
    return c.json({ data: await updateSegment(c.get('db'), c.get('siteId'), param(c, 'id'), patch) });
  }),
);

membersRouter.delete(
  '/segments/:id',
  h(async (c) => {
    await deleteSegment(c.get('db'), c.get('siteId'), param(c, 'id'));
    return c.json({ data: null });
  }),
);

// ── Newsletters ───────────────────────────────────────────────────────────

membersRouter.get('/newsletters', h(async (c) => c.json({ data: await listNewsletters(c.get('db'), c.get('siteId')) })));

membersRouter.post(
  '/newsletters',
  h(async (c) => {
    const input = newsletterInputSchema.parse(await body(c));
    return c.json({ data: await createNewsletter(c.get('db'), c.get('siteId'), input) }, 201);
  }),
);

membersRouter.patch(
  '/newsletters/:id',
  h(async (c) => {
    const patch = newsletterPatch.parse(await body(c));
    return c.json({ data: await updateNewsletter(c.get('db'), c.get('siteId'), param(c, 'id'), patch) });
  }),
);

membersRouter.delete(
  '/newsletters/:id',
  h(async (c) => {
    const outcome = await deleteNewsletter(c.get('db'), c.get('siteId'), param(c, 'id'));
    return c.json({ data: { outcome } });
  }),
);

membersRouter.get(
  '/newsletters/:id/audience',
  h(async (c) => {
    const db = c.get('db');
    const siteId = c.get('siteId');
    const newsletter = await getNewsletter(db, siteId, param(c, 'id'));
    const segmentId = c.req.query('segmentId');
    const filter = segmentId ? parseSegmentFilter((await getSegmentRow(db, siteId, segmentId)).filter) : null;
    return c.json({ data: { count: await countAudience(db, siteId, newsletter, filter) } });
  }),
);

membersRouter.get('/newsletters/:id/sends', h(async (c) => c.json({ data: await listSends(c.get('db'), c.get('siteId'), param(c, 'id')) })));

const sendRequestSchema = z.object({
  collection: z.string().min(1).max(128),
  itemId: z.string().min(1).max(128),
  segmentId: z.string().min(1).max(64).nullable().optional(),
  /** "Publish & send": publish the item first (through the caller's permissions). */
  publish: z.boolean().default(false),
  compose: composeOptionsSchema.default({ subjectField: 'title', bodyField: 'content' }),
});

membersRouter.post(
  '/newsletters/:id/sends',
  h(async (c) => {
    const db = c.get('db');
    const siteId = c.get('siteId');
    const input = sendRequestSchema.parse(await body(c));
    const secret = c.env.JWT_SECRET || process.env.JWT_SECRET;
    const emailService = EmailService.fromEnv(c.env);
    if (!emailService) throw new MemberError('EMAIL_NOT_CONFIGURED', 503, 'Email is not configured on this runtime.');
    if (!secret) throw new MemberError('AUTH_NOT_CONFIGURED', 500, 'JWT_SECRET is required to sign unsubscribe links.');
    await getNewsletter(db, siteId, param(c, 'id'));

    const items = itemServiceForRequest(c);
    let item;
    try {
      if (input.publish) await items.patch(input.collection, input.itemId, { status: 'published' });
      item = await items.detail(input.collection, input.itemId);
    } catch (err) {
      if (err instanceof ItemServiceError) {
        return c.json({ errors: [{ code: err.code, message: err.message }] }, err.status as 400);
      }
      throw err;
    }
    const composed = composeFromItem({ id: String(item.id), data: (item.data ?? {}) as Record<string, unknown> }, input.compose);
    const send = await createSend(
      db,
      siteId,
      {
        newsletterId: param(c, 'id'),
        collection: input.collection,
        itemId: input.itemId,
        segmentId: input.segmentId ?? null,
        composed,
        linkBase: linkBase(c),
      },
      c.get('auth')?.userId ?? null,
    );
    await audit(c, 'newsletter_send_started', {
      sendId: send.id,
      newsletterId: send.newsletterId,
      collection: send.collection,
      itemId: send.itemId,
      segmentId: send.segmentId,
      recipients: (send.counters as { recipients?: number }).recipients ?? 0,
      published: input.publish,
    });
    // First chunks in the background of this request; the members tick
    // resumes whatever is left.
    const mailerFor = mailerFactory({ db, emailService, secret, keys: c.get('runtime')?.keys });
    runDetached(c, driveSend({ db, mailerFor }, send.id, 20_000));
    return c.json({ data: toSendView(send) }, 202);
  }),
);

membersRouter.get('/sends/:id', h(async (c) => c.json({ data: toSendView(await getSend(c.get('db'), c.get('siteId'), param(c, 'id'))) })));

membersRouter.post(
  '/sends/:id/cancel',
  h(async (c) => {
    const row = await cancelSend(c.get('db'), c.get('siteId'), param(c, 'id'));
    await audit(c, 'newsletter_send_cancelled', { sendId: row.id });
    return c.json({ data: toSendView(row) });
  }),
);

// ── Sequences ─────────────────────────────────────────────────────────────

membersRouter.get('/sequences/templates', (c) => c.json({ data: SEQUENCE_TEMPLATES }));

membersRouter.post(
  '/sequences/from-template',
  h(async (c) => {
    const input = z
      .object({
        template: z.string().min(1).max(64),
        key: z.string().regex(/^[a-z0-9][a-z0-9-_]{0,62}$/).optional(),
        segmentId: z.string().max(64).optional(),
        fromEmail: z.string().email().optional(),
        fromName: z.string().max(100).optional(),
      })
      .parse(await body(c));
    const { template, ...overrides } = input;
    return c.json({ data: await createSequenceFromTemplate(c.get('db'), c.get('siteId'), template, overrides) }, 201);
  }),
);

membersRouter.get('/sequences', h(async (c) => c.json({ data: await listSequences(c.get('db'), c.get('siteId')) })));

membersRouter.post(
  '/sequences',
  h(async (c) => {
    const input = sequenceInputSchema.parse(await body(c));
    return c.json({ data: await createSequence(c.get('db'), c.get('siteId'), input) }, 201);
  }),
);

membersRouter.get('/sequences/:id', h(async (c) => c.json({ data: await getSequence(c.get('db'), c.get('siteId'), param(c, 'id')) })));

membersRouter.patch(
  '/sequences/:id',
  h(async (c) => {
    const patch = sequencePatch.parse(await body(c));
    return c.json({ data: await updateSequence(c.get('db'), c.get('siteId'), param(c, 'id'), patch) });
  }),
);

membersRouter.delete(
  '/sequences/:id',
  h(async (c) => {
    await deleteSequence(c.get('db'), c.get('siteId'), param(c, 'id'));
    return c.json({ data: null });
  }),
);

membersRouter.get(
  '/sequences/:id/enrollments',
  h(async (c) => {
    await getSequence(c.get('db'), c.get('siteId'), param(c, 'id'));
    const limit = Number(c.req.query('limit') ?? 100);
    return c.json({ data: await listEnrollments(c.get('db'), c.get('siteId'), param(c, 'id'), Number.isFinite(limit) ? limit : 100) });
  }),
);

membersRouter.post(
  '/sequences/:id/enroll',
  h(async (c) => {
    const { memberId } = z.object({ memberId: z.string().min(1).max(64) }).parse(await body(c));
    const enrolled = await enrollMember(c.get('db'), c.get('siteId'), param(c, 'id'), memberId);
    return c.json({ data: { enrolled } });
  }),
);

// ── Signup card block ─────────────────────────────────────────────────────

membersRouter.post(
  '/signup-card/install',
  h(async (c) => {
    const schema = new SchemaService({ db: c.get('db'), siteId: c.get('siteId'), cache: c.get('runtime')?.cache, queue: c.get('runtime')?.queue });
    const data = await installSignupCard(schema);
    return c.json({ data }, data.created ? 201 : 200);
  }),
);

// ── Members (dynamic `/:id` routes last) ──────────────────────────────────

membersRouter.get(
  '/',
  h(async (c) => {
    const db = c.get('db');
    const siteId = c.get('siteId');
    const segmentId = c.req.query('segmentId');
    let filter: unknown;
    if (segmentId) filter = (await getSegmentRow(db, siteId, segmentId)).filter;
    else if (c.req.query('filter')) {
      try {
        filter = JSON.parse(c.req.query('filter')!);
      } catch {
        throw new MemberError('VALIDATION', 400, 'filter must be JSON.');
      }
    }
    const num = (v: string | undefined) => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : undefined);
    const sortRaw = c.req.query('sort');
    const sort = sortRaw === 'created_at' || sortRaw === '-created_at' || sortRaw === 'email' || sortRaw === '-last_seen_at' ? sortRaw : undefined;
    const result = await service(c).list({
      limit: num(c.req.query('limit')),
      offset: num(c.req.query('offset')),
      search: c.req.query('search'),
      filter,
      sort,
    });
    return c.json(result);
  }),
);

membersRouter.post(
  '/',
  h(async (c) => {
    const input = memberCreateSchema.parse(await body(c));
    const svc = service(c);
    const row = await svc.create(input, { source: 'admin' });
    if (row.userId) await bumpPermissionVersion(c);
    await audit(c, 'member_created', { memberId: row.id, status: row.status }, row.email);
    return c.json({ data: await svc.view(row) }, 201);
  }),
);

membersRouter.get('/:id', h(async (c) => c.json({ data: await service(c).get(param(c, 'id')) })));

membersRouter.patch(
  '/:id',
  h(async (c) => {
    const patch = memberPatch.parse(await body(c));
    const svc = service(c);
    const { row, accessChanged } = await svc.update(param(c, 'id'), patch);
    if (accessChanged) await bumpPermissionVersion(c);
    if (patch.status !== undefined || patch.tierId !== undefined) {
      await audit(c, 'member_tier_changed', { memberId: row.id, status: row.status, tierId: row.tierId }, row.email);
    }
    return c.json({ data: await svc.view(row) });
  }),
);

membersRouter.delete(
  '/:id',
  h(async (c) => {
    const svc = service(c);
    const row = await svc.getRow(param(c, 'id'));
    const { accessChanged } = await svc.delete(row.id);
    if (accessChanged) await bumpPermissionVersion(c);
    await audit(c, 'member_deleted', { memberId: row.id }, row.email);
    return c.json({ data: null });
  }),
);

membersRouter.put(
  '/:id/newsletters/:newsletterId',
  h(async (c) => {
    const { subscribed } = z.object({ subscribed: z.boolean() }).parse(await body(c));
    const svc = service(c);
    await svc.setNewsletter(param(c, 'id'), param(c, 'newsletterId'), subscribed);
    return c.json({ data: await svc.get(param(c, 'id')) });
  }),
);
