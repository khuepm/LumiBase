import { users, userSites, scopeSite } from '@lumibase/database';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import type { AppEnv } from '../env';
import { requireSiteAdmin } from '../middleware/site-admin';
import { sendTeammateInvite } from '../modules/email/invite';
import {
  grantSubscriberRead,
  revokeSubscriberRead,
  listSubscriberRead,
} from '../services/auth/subscriber-access';

export const usersRouter = new Hono<AppEnv>();
usersRouter.use('*', requireSiteAdmin());

// List users belonging to the active site
usersRouter.get('/', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  
  const data = await db
    .select({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      avatar: users.avatar,
      status: users.status,
      lastSeenAt: users.lastSeenAt,
      roleId: userSites.roleId,
      joinedAt: userSites.joinedAt,
    })
    .from(users)
    .innerJoin(userSites, eq(users.id, userSites.userId))
    .where(eq(userSites.siteId, siteId));

  return c.json({ data });
});

// ── Subscriber content access ───────────────────────────────────────────
// Grant/revoke what self-service frontend subscribers can READ. The
// `subscriber` role is empty by default (ADR-010); these endpoints attach
// `read` permissions to it via the shared subscriber policy. Registered
// before `/:id` so the static path isn't captured by the param route.

// List collections subscribers can currently read.
usersRouter.get('/subscriber-access', async (c) => {
  const data = await listSubscriberRead(c.get('db'), c.get('siteId'));
  return c.json({ data });
});

const subscriberAccessSchema = z.object({
  collection: z.string().min(1),
  publishedOnly: z.boolean().optional(),
  fields: z.array(z.string()).optional(),
});

// Grant (or update) subscriber read on a collection.
usersRouter.post('/subscriber-access', async (c) => {
  const body = await c.req.json();
  const input = subscriberAccessSchema.parse(body);
  const grant = await grantSubscriberRead(c.get('db'), c.get('siteId'), input);
  return c.json({ data: grant });
});

// Revoke subscriber read on a collection.
usersRouter.delete('/subscriber-access/:collection', async (c) => {
  const collection = c.req.param('collection');
  const removed = await revokeSubscriberRead(c.get('db'), c.get('siteId'), collection);
  if (!removed) {
    return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  }
  return c.json({ data: { collection, removed: true } });
});

// Get a specific user in the active site
usersRouter.get('/:id', async (c) => {
  const id = c.req.param('id');
  const siteId = c.get('siteId');
  const db = c.get('db');

  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      avatar: users.avatar,
      status: users.status,
      lastSeenAt: users.lastSeenAt,
      roleId: userSites.roleId,
      joinedAt: userSites.joinedAt,
    })
    .from(users)
    .innerJoin(userSites, eq(users.id, userSites.userId))
    .where(and(eq(userSites.siteId, siteId), eq(users.id, id)))
    .limit(1);

  if (!row) {
    return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  }

  return c.json({ data: row });
});

// Invite user
const inviteSchema = z.object({
  email: z.string().email(),
  roleId: z.string().optional(),
});

usersRouter.post('/invite', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const body = await c.req.json();
  const input = inviteSchema.parse(body);

  // Check if user exists globally by email
  let [existingUser] = await db.select().from(users).where(eq(users.email, input.email)).limit(1);

  if (!existingUser) {
    const dummyLogtoId = `shadow_${nanoid()}`;
    const [newUser] = await db.insert(users).values({
      email: input.email,
      externalId: dummyLogtoId,
      status: 'invited',
    }).returning();
    existingUser = newUser!;
  }

  if (!existingUser) {
    return c.json({ errors: [{ code: 'INTERNAL_ERROR' }] }, 500);
  }

  // Bind to site
  await db.insert(userSites).values({
    userId: existingUser.id,
    siteId,
    roleId: input.roleId,
  }).onConflictDoNothing(); // If already in site, do nothing

  // Best-effort invite email — sent AFTER the binding so a mail failure can't
  // affect the invite itself. Detached via waitUntil on Workers; the helper
  // never throws, so a fire-and-forget on Node is safe too.
  const inviteEmail = sendTeammateInvite({
    db,
    siteId,
    env: c.env,
    email: input.email,
    invitedBy: c.get('auth')?.email ?? undefined,
  });
  if (c.executionCtx?.waitUntil) {
    c.executionCtx.waitUntil(inviteEmail);
  } else {
    void inviteEmail;
  }

  return c.json({ data: existingUser });
});

// Update user inside site (mainly role mapping)
const updateUserSchema = z.object({
  roleId: z.string().nullable().optional(),
  status: z.string().optional(), // active, suspended, etc.
});

usersRouter.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const siteId = c.get('siteId');
  const db = c.get('db');
  const body = await c.req.json();
  const input = updateUserSchema.parse(body);

  // Validate the user is in this site
  const [membership] = await db.select().from(userSites).where(and(eq(userSites.siteId, siteId), eq(userSites.userId, id))).limit(1);
  if (!membership) {
    return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  }

  if (input.roleId !== undefined) {
    await db.update(userSites)
      .set({ roleId: input.roleId })
      .where(and(eq(userSites.siteId, siteId), eq(userSites.userId, id)));
  }

  if (input.status !== undefined) {
    await db.update(users)
      .set({ status: input.status, updatedAt: new Date() })
      .where(eq(users.id, id));
  }

  return c.json({ data: { id } });
});

// Remove user from site
usersRouter.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const siteId = c.get('siteId');
  const db = c.get('db');

  const [row] = await db.delete(userSites)
    .where(and(eq(userSites.siteId, siteId), eq(userSites.userId, id)))
    .returning();

  if (!row) {
    return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  }

  return c.json({ data: null });
});

// Impersonate user
usersRouter.post('/:id/impersonate', async (c) => {
  const id = c.req.param('id');
  const siteId = c.get('siteId');
  const db = c.get('db');

  // Verify the user is in the site
  const [row] = await db.select().from(userSites).where(and(eq(userSites.siteId, siteId), eq(userSites.userId, id))).limit(1);
  if (!row) {
    return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  }

  // Generate an impersonation token (mock implementation)
  const token = `impersonate_${nanoid()}`;
  return c.json({ data: { token } });
});
