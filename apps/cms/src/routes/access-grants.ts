import { collections, scopeSite } from '@lumibase/database';
import { and, asc, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { AuditLogger } from '../modules/audit/logger';
import { requireSiteAdmin } from '../middleware/site-admin';
import {
  PUBLIC_REALM,
  isPublicAccessEnabled,
} from '../services/auth/public-access';
import {
  disablePublicAccess,
  enablePublicAccess,
  invalidatePublicRoleCache,
} from '../services/auth/public-role';
import { SUBSCRIBER_REALM } from '../services/auth/subscriber-access';
import {
  GRANT_ACTIONS,
  RealmAccessError,
  type GrantAction,
  type RealmDefinition,
  grantRealmAccess,
  listRealmAccess,
  revokeRealmAccess,
} from '../services/auth/realm-access';
import { bumpPermissionVersion } from '../services/permission-invalidation';

/**
 * /access/grants — the non-staff permission picker's backend.
 *
 * One surface for both non-staff realms so an operator can answer "what can a
 * visitor reach?" in a single call instead of reasoning across the raw
 * role/policy editor:
 *
 *   GET    /access/grants                             picker state (both realms)
 *   POST   /access/grants/:realm/enable               provision the realm
 *   POST   /access/grants/:realm/disable              tear the realm down
 *   POST   /access/grants/:realm                      grant (collection, action)
 *   DELETE /access/grants/:realm/:collection/:action  revoke
 *
 * Mounted on `/api/v1/access` alongside `accessRouter`. Hono matches by method
 * + exact leaf path and every path here begins `/grants`, which is disjoint
 * from that router's `/export`, `/import` and `/conflicts/check` — the same
 * coexistence the public setup/recovery routers rely on. Being under
 * `/api/v1/access` also means `withStudioAccess` already covers it.
 *
 * The realm services own the least-privilege screens (which actions a realm
 * may hold, whether a row scope is expressible); this router only maps their
 * typed errors onto HTTP and keeps the audit trail.
 */

export const accessGrantsRouter = new Hono<AppEnv>();

accessGrantsRouter.use('*', requireSiteAdmin());

const REALMS: Record<string, RealmDefinition> = {
  [PUBLIC_REALM.key]: PUBLIC_REALM,
  [SUBSCRIBER_REALM.key]: SUBSCRIBER_REALM,
};

/** Human-facing copy for the picker. Kept server-side so both the Studio UI
 *  and any other client describe a realm the same way. */
const REALM_LABELS: Record<string, { label: string; summary: string }> = {
  [PUBLIC_REALM.key]: {
    label: 'Public (anonymous)',
    summary:
      'Anyone on the internet, with no credential. Read-only, and only for ' +
      'collections granted here.',
  },
  [SUBSCRIBER_REALM.key]: {
    label: 'Subscriber (registered)',
    summary:
      'Visitors who registered and signed in on your frontend. Cannot reach ' +
      'Studio. May hold scoped writes.',
  },
};

const grantSchema = z.object({
  collection: z.string().min(1).max(64),
  action: z.enum(GRANT_ACTIONS).optional(),
  publishedOnly: z.boolean().optional(),
  ownOnly: z.boolean().optional(),
  fields: z.array(z.string()).optional(),
});

function resolveRealm(key: string | undefined): RealmDefinition | null {
  if (!key) return null;
  return REALMS[key] ?? null;
}

const unknownRealm = (key: string | undefined) => ({
  errors: [
    {
      code: 'UNKNOWN_REALM',
      message: `Unknown realm '${key ?? ''}'. Expected one of: ${Object.keys(REALMS).join(', ')}.`,
    },
  ],
});

/** Map a realm-service refusal onto its HTTP status. */
function realmErrorStatus(code: RealmAccessError['code']): 400 | 409 {
  return code === 'COLLECTION_REQUIRED' ? 400 : 409;
}

async function audit(
  c: Context<AppEnv>,
  event: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await new AuditLogger({ db: c.get('db'), siteId: c.get('siteId') }).write({
    event,
    actorEmail: c.get('auth')?.email ?? null,
    ip: c.get('ip') ?? null,
    userAgent: c.get('userAgent') ?? null,
    requestId: c.get('requestId') ?? null,
    metadata,
  });
}

/**
 * Everything the picker needs in one round trip: the site's grantable
 * collections and, per realm, what it may be granted plus what it already has.
 */
accessGrantsRouter.get('/grants', async (c) => {
  const db = c.get('db');
  const siteId = c.get('siteId');

  const [collectionRows, publicEnabled, publicGrants, subscriberGrants] = await Promise.all([
    db
      .select({ name: collections.name, label: collections.label })
      .from(collections)
      .where(
        and(
          scopeSite(collections.siteId, siteId),
          // System and hidden collections are infrastructure, not content an
          // operator would publish to visitors.
          eq(collections.system, false),
          eq(collections.hidden, false),
        ),
      )
      .orderBy(asc(collections.name)),
    isPublicAccessEnabled(db, siteId),
    listRealmAccess(db, siteId, PUBLIC_REALM),
    listRealmAccess(db, siteId, SUBSCRIBER_REALM),
  ]);

  return c.json({
    data: {
      collections: collectionRows,
      realms: [
        {
          key: PUBLIC_REALM.key,
          ...REALM_LABELS[PUBLIC_REALM.key],
          allowedActions: PUBLIC_REALM.allowedActions,
          supportsOwnOnly: PUBLIC_REALM.supportsOwnOnly,
          /** Public access is opt-in; the realm exists only once enabled. */
          togglable: true,
          enabled: publicEnabled,
          grants: publicGrants,
        },
        {
          key: SUBSCRIBER_REALM.key,
          ...REALM_LABELS[SUBSCRIBER_REALM.key],
          allowedActions: SUBSCRIBER_REALM.allowedActions,
          supportsOwnOnly: SUBSCRIBER_REALM.supportsOwnOnly,
          // Provisioned on first registration, not operator-toggled.
          togglable: false,
          enabled: true,
          grants: subscriberGrants,
        },
      ],
    },
  });
});

accessGrantsRouter.post('/grants/:realm/enable', async (c) => {
  const realm = resolveRealm(c.req.param('realm'));
  if (!realm) return c.json(unknownRealm(c.req.param('realm')), 404);
  if (realm.key !== PUBLIC_REALM.key) {
    return c.json(
      {
        errors: [
          {
            code: 'REALM_NOT_TOGGLABLE',
            message: `The ${realm.key} realm is provisioned on demand and cannot be toggled.`,
          },
        ],
      },
      400,
    );
  }

  const siteId = c.get('siteId');
  const ids = await enablePublicAccess(c.get('db'), siteId);
  // The anonymous hot path reads a cached role pointer — drop it so the very
  // next unauthenticated request sees the realm rather than waiting out a TTL.
  await invalidatePublicRoleCache(c.get('runtime')?.cache, siteId);
  await bumpPermissionVersion(c, siteId);
  await audit(c, 'public_access_enabled', { ...ids });

  return c.json({ data: { enabled: true, ...ids } });
});

accessGrantsRouter.post('/grants/:realm/disable', async (c) => {
  const realm = resolveRealm(c.req.param('realm'));
  if (!realm) return c.json(unknownRealm(c.req.param('realm')), 404);
  if (realm.key !== PUBLIC_REALM.key) {
    return c.json(
      {
        errors: [
          {
            code: 'REALM_NOT_TOGGLABLE',
            message: `The ${realm.key} realm is provisioned on demand and cannot be toggled.`,
          },
        ],
      },
      400,
    );
  }

  const siteId = c.get('siteId');
  const removed = await disablePublicAccess(c.get('db'), siteId);
  await invalidatePublicRoleCache(c.get('runtime')?.cache, siteId);
  await bumpPermissionVersion(c, siteId);
  await audit(c, 'public_access_disabled', { removed });

  return c.json({ data: { enabled: false, removed } });
});

accessGrantsRouter.post('/grants/:realm', async (c) => {
  const realm = resolveRealm(c.req.param('realm'));
  if (!realm) return c.json(unknownRealm(c.req.param('realm')), 404);

  const parsed = grantSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      { errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) },
      400,
    );
  }

  const siteId = c.get('siteId');
  try {
    const grant = await grantRealmAccess(c.get('db'), siteId, realm, parsed.data);
    if (realm.key === PUBLIC_REALM.key) {
      // A first grant provisions the realm, so the cached "is public enabled"
      // pointer can be stale here too.
      await invalidatePublicRoleCache(c.get('runtime')?.cache, siteId);
    }
    await bumpPermissionVersion(c, siteId);
    await audit(c, 'realm_access_granted', { realm: realm.key, ...grant });
    return c.json({ data: grant });
  } catch (error) {
    if (error instanceof RealmAccessError) {
      return c.json(
        { errors: [{ code: error.code, message: error.message }] },
        realmErrorStatus(error.code),
      );
    }
    throw error;
  }
});

accessGrantsRouter.delete('/grants/:realm/:collection/:action', async (c) => {
  const realm = resolveRealm(c.req.param('realm'));
  if (!realm) return c.json(unknownRealm(c.req.param('realm')), 404);

  const action = c.req.param('action') as GrantAction;
  if (!(GRANT_ACTIONS as readonly string[]).includes(action)) {
    return c.json(
      {
        errors: [
          {
            code: 'VALIDATION',
            message: `Unknown action '${action}'. Expected one of: ${GRANT_ACTIONS.join(', ')}.`,
          },
        ],
      },
      400,
    );
  }

  const siteId = c.get('siteId');
  const collection = c.req.param('collection');
  const removed = await revokeRealmAccess(c.get('db'), siteId, realm, collection, action);
  if (!removed) {
    return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Grant not found.' }] }, 404);
  }

  await bumpPermissionVersion(c, siteId);
  await audit(c, 'realm_access_revoked', { realm: realm.key, collection, action });

  return c.json({ data: { realm: realm.key, collection, action, removed: true } });
});
