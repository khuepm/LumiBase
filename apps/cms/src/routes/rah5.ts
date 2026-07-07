/**
 * RAH5 game API — first-party module (Phase 1 of rah5_v2/docs/SERVER_PLAN.md).
 *
 * Mounted at `/api/v1/rah5` inside the authenticated `api` sub-app, so every
 * route below (except `/auth/guest`, which is on the withAuth bypass list)
 * inherits the tenant → db → auth → RLS middleware chain.
 *
 * Scope (Phase 1): guest auth, bootstrap, save sync. Gacha/checkin/expedition
 * land in Phase 2; PVP match results (API-key caller) in Phase 3.
 */

import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { SignJWT } from 'jose';
import { z } from 'zod';
import {
  rah5Players,
  rah5Regions,
  rah5Saves,
  roles,
  users,
  userSites,
} from '@lumibase/database';
import type { AppEnv } from '../env';
import { hashPassword } from '../services/auth/password';
import { formatSafeError } from '@lumibase/shared/utils';

export const rah5Router = new Hono<AppEnv>();

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Same shape as routes/auth.ts signCustomJwt — HS256, 24 h. */
async function signPlayerJwt(
  payload: Record<string, unknown>,
  secret: string,
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(new TextEncoder().encode(secret));
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(input),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function err(c: any, status: number, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
}

/** Resolve the authenticated frontend user id or null. */
function playerUserId(c: any): string | null {
  const auth = c.get('auth');
  if (!auth?.userId) return null;
  return String(auth.userId);
}

/** Default region list used until an admin seeds `rah5_regions`. */
const DEFAULT_REGIONS = Array.from({ length: 20 }, (_, i) => {
  const n = i + 1;
  return {
    code: `S${n}`,
    name: n === 1 ? 'S1 - The Awakening of the Elements' : `S${n}`,
    flag: n === 20 ? 'new' : n === 19 ? 'recommend' : n <= 3 ? 'full' : '',
    status: 'open',
    order: n,
  };
});

// ─── POST /auth/guest (withAuth bypass — see middleware/auth.ts) ─────────────
//
// Guest login by device id: deterministic synthetic email, JIT user + site
// membership (seeded `member` role), then a Custom JWT the existing withAuth
// custom-JWT branch accepts. Re-login with the same deviceId returns the same
// account. No password ever leaves the server (random, unused).

const guestSchema = z.object({
  deviceId: z.string().min(8).max(128),
  name: z.string().min(1).max(24).optional(),
});

rah5Router.post('/auth/guest', async (c) => {
  const db = c.get('db');
  const siteId = c.get('siteId');
  const jwtSecret = c.env.JWT_SECRET || process.env.JWT_SECRET;
  if (!jwtSecret) {
    return err(c, 500, 'AUTH_NOT_CONFIGURED', 'JWT_SECRET missing.');
  }

  let input: z.infer<typeof guestSchema>;
  try {
    input = guestSchema.parse(await c.req.json());
  } catch {
    return err(c, 400, 'BAD_REQUEST', 'deviceId (8-128 chars) required.');
  }

  const deviceHash = (await sha256Hex(`rah5:${input.deviceId}`)).slice(0, 24);
  const email = `guest_${deviceHash}@rah5.local`;

  // Find-or-create the user.
  let [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user) {
    // Member role: dev seed only provisions `administrator`, so create the
    // non-admin, no-Studio role on demand (idempotent via systemKey lookup).
    let [memberRole] = await db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.siteId, siteId), eq(roles.systemKey, 'member')))
      .limit(1);
    if (!memberRole) {
      [memberRole] = await db
        .insert(roles)
        .values({
          siteId,
          key: 'member',
          systemKey: 'member',
          name: 'Member',
          description: 'RAH5 game player (frontend user).',
          adminAccess: false,
          appAccess: false,
        })
        .returning({ id: roles.id });
    }
    if (!memberRole) {
      return err(c, 500, 'ROLE_NOT_FOUND', 'Member role could not be provisioned.');
    }
    // Random password: guests authenticate by deviceId only.
    const randomPw = crypto.getRandomValues(new Uint8Array(24)).join('-');
    const passwordHash = await hashPassword(randomPw);
    try {
      [user] = await db
        .insert(users)
        .values({
          email,
          passwordHash,
          firstName: input.name ?? `Player_${deviceHash.slice(0, 6)}`,
          status: 'active',
        })
        .returning();
    } catch (e) {
      // Concurrent first-login race: someone else inserted — re-read.
      console.warn('[rah5/guest] insert race:', formatSafeError(e));
      [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    }
    if (!user) return err(c, 500, 'REGISTRATION_FAILED', 'Failed to create guest user.');
    await db
      .insert(userSites)
      .values({ userId: user.id, siteId, roleId: memberRole.id })
      .onConflictDoNothing();
  }
  if (user.status !== 'active') {
    return err(c, 403, 'FORBIDDEN', 'Account is not active.');
  }

  // Ensure the player profile row exists.
  const displayName = input.name ?? user.firstName ?? `Player_${deviceHash.slice(0, 6)}`;
  await db
    .insert(rah5Players)
    .values({ siteId, userId: user.id, name: displayName })
    .onConflictDoNothing();

  const token = await signPlayerJwt(
    { userId: user.id, siteId, email: user.email },
    jwtSecret,
  );

  const [player] = await db
    .select()
    .from(rah5Players)
    .where(and(eq(rah5Players.siteId, siteId), eq(rah5Players.userId, user.id)))
    .limit(1);

  return c.json({
    data: {
      token,
      player: player
        ? { id: player.id, name: player.name, avatar: player.avatar, vip: player.vip, elo: player.elo }
        : null,
    },
  });
});

// ─── GET /bootstrap ──────────────────────────────────────────────────────────

rah5Router.get('/bootstrap', async (c) => {
  const userId = playerUserId(c);
  if (!userId) return err(c, 401, 'UNAUTHENTICATED', 'Player token required.');
  const db = c.get('db');
  const siteId = c.get('siteId');

  const [player] = await db
    .select()
    .from(rah5Players)
    .where(and(eq(rah5Players.siteId, siteId), eq(rah5Players.userId, userId)))
    .limit(1);
  if (!player) return err(c, 404, 'PLAYER_NOT_FOUND', 'Call /auth/guest first.');

  const [save] = await db
    .select({ data: rah5Saves.data, rev: rah5Saves.rev })
    .from(rah5Saves)
    .where(and(eq(rah5Saves.siteId, siteId), eq(rah5Saves.userId, userId)))
    .limit(1);

  let regions = await db
    .select({
      code: rah5Regions.code,
      name: rah5Regions.name,
      flag: rah5Regions.flag,
      status: rah5Regions.status,
      order: rah5Regions.order,
    })
    .from(rah5Regions)
    .where(eq(rah5Regions.siteId, siteId))
    .orderBy(rah5Regions.order);
  if (regions.length === 0) regions = DEFAULT_REGIONS;

  return c.json({
    data: {
      player: { id: player.id, name: player.name, avatar: player.avatar, vip: player.vip, elo: player.elo },
      save: save ?? null, // null → client offers local-save import (§10)
      regions,
      serverTime: Date.now(),
    },
  });
});

// ─── PUT /save ───────────────────────────────────────────────────────────────
//
// Optimistic concurrency: the client sends the rev it read. First write for a
// user must carry rev=0. A stale rev returns 409 with the current rev so the
// client can re-bootstrap and merge.

const saveSchema = z.object({
  rev: z.number().int().min(0),
  data: z.record(z.unknown()),
  requestId: z.string().min(8).max(64),
});

rah5Router.put('/save', async (c) => {
  const userId = playerUserId(c);
  if (!userId) return err(c, 401, 'UNAUTHENTICATED', 'Player token required.');
  const db = c.get('db');
  const siteId = c.get('siteId');

  let input: z.infer<typeof saveSchema>;
  try {
    input = saveSchema.parse(await c.req.json());
  } catch {
    return err(c, 400, 'BAD_REQUEST', 'rev, data, requestId required.');
  }

  const [existing] = await db
    .select({ id: rah5Saves.id, rev: rah5Saves.rev })
    .from(rah5Saves)
    .where(and(eq(rah5Saves.siteId, siteId), eq(rah5Saves.userId, userId)))
    .limit(1);

  if (!existing) {
    if (input.rev !== 0) {
      return err(c, 409, 'REV_CONFLICT', 'No save on server; first write must use rev=0.');
    }
    await db.insert(rah5Saves).values({
      siteId,
      userId,
      data: input.data,
      rev: 1,
    });
    return c.json({ data: { rev: 1 } });
  }

  // Guarded update — WHERE rev = client rev makes the bump atomic.
  const updated = await db
    .update(rah5Saves)
    .set({
      data: input.data,
      rev: sql`${rah5Saves.rev} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(rah5Saves.id, existing.id),
        eq(rah5Saves.rev, input.rev),
      ),
    )
    .returning({ rev: rah5Saves.rev });

  if (updated.length === 0) {
    const [current] = await db
      .select({ rev: rah5Saves.rev })
      .from(rah5Saves)
      .where(eq(rah5Saves.id, existing.id))
      .limit(1);
    return c.json(
      { error: { code: 'REV_CONFLICT', message: 'Save was updated elsewhere.' }, rev: current?.rev },
      409,
    );
  }

  return c.json({ data: { rev: updated[0]!.rev } });
});
