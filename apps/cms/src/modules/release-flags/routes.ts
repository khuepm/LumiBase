/**
 * Release-flag surface (#869). Mounted at `/api/v1/release-flags` on the
 * authenticated `api` chain (tenant → db → auth → membership → …).
 *
 *   GET  /               members: `{ key, enabled }[]` for the active site;
 *                        site admins: full state, stage, source, owner
 *   PUT  /site           site admin: `{ flags: { key: boolean | null } }`
 *   GET  /manifest       bootstrap admin: accepted manifest + pull status
 *   PUT  /manifest       bootstrap admin: submit a signed manifest envelope
 *   POST /manifest/pull  bootstrap admin: fetch from LUMIBASE_RELEASE_MANIFEST_URL now
 *
 * Instance-wide actions (the manifest) are limited to the bootstrap admin, a
 * person — never an API key — exactly like `/admin/email-identity/instance`.
 * The signature, not the caller, is what authorizes the flag values: even the
 * bootstrap admin cannot store a manifest LumiBase did not sign.
 */

import { users } from '@lumibase/database';
import { eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../env';
import { systemDbFor } from '../../middleware/db';
import { isSiteAdmin, requireSiteAdmin } from '../../middleware/site-admin';
import { AuditLogger } from '../audit/logger';
import { parseReleasePublicKeys } from './manifest';
import { releaseEnvFrom, releaseFlagStates } from './middleware';
import { RELEASE_FLAGS } from './registry';
import {
  acceptReleaseManifest,
  lastReleasePullStatus,
  loadAcceptedManifest,
  manifestUrlAllowed,
  pullReleaseManifest,
  saveSiteReleaseValues,
  type AcceptOutcome,
} from './service';

type AppContext = Context<AppEnv>;

export const releaseFlagsRouter = new Hono<AppEnv>();

const siteBodySchema = z.object({
  flags: z
    .record(z.string().min(1).max(200), z.boolean().nullable())
    .refine((value) => Object.keys(value).length > 0, 'At least one flag is required.')
    .refine((value) => Object.keys(value).length <= 100, 'At most 100 flags per request.'),
});

function validationError(c: AppContext, issues: Array<{ message: string; path: PropertyKey[] }>) {
  return c.json(
    { errors: issues.map((i) => ({ code: 'VALIDATION', message: i.message, path: i.path.map(String) })) },
    400,
  );
}

async function audit(c: AppContext, event: string, metadata: Record<string, unknown>) {
  const auth = c.get('auth');
  await new AuditLogger({ db: c.get('db'), siteId: c.get('siteId') }).write({
    event,
    actorEmail: auth?.email ?? null,
    ip: c.get('ip') ?? null,
    userAgent: c.get('userAgent') ?? null,
    requestId: c.get('requestId') ?? null,
    metadata,
  });
}

/** The bootstrap admin, as a person (API keys and anonymous callers never qualify). */
async function isBootstrapAdmin(c: AppContext): Promise<boolean> {
  const auth = c.get('auth');
  if (!auth?.userId || auth.apiKeyId || auth.type === 'api_key' || auth.type === 'anonymous') return false;
  const [actor] = await systemDbFor(c)
    .select({ bootstrap: users.isBootstrap })
    .from(users)
    .where(eq(users.id, auth.userId))
    .limit(1);
  return actor?.bootstrap === true;
}

function forbidden(c: AppContext) {
  return c.json(
    { errors: [{ code: 'FORBIDDEN', message: 'Only the bootstrap admin can manage the release manifest.' }] },
    403,
  );
}

releaseFlagsRouter.get('/', async (c) => {
  const states = await releaseFlagStates(c);
  if (!(await isSiteAdmin(c))) {
    return c.json({ data: [...states.values()].map((s) => ({ key: s.key, enabled: s.enabled })) });
  }
  const data = [...states.values()].map((state) => {
    const def = RELEASE_FLAGS.get(state.key)!;
    return {
      ...state,
      description: def.description,
      siteToggle: def.siteToggle,
      siteDefault: def.siteDefault,
      owner: def.owner,
      removeBy: def.removeBy,
    };
  });
  return c.json({ data });
});

releaseFlagsRouter.put('/site', requireSiteAdmin(), async (c) => {
  const parsed = siteBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return validationError(c, parsed.error.issues);

  const problems: Array<{ code: string; message: string; key: string }> = [];
  for (const key of Object.keys(parsed.data.flags)) {
    const def = RELEASE_FLAGS.get(key);
    if (!def) problems.push({ code: 'UNKNOWN_FLAG', message: `No release flag "${key}".`, key });
    else if (!def.siteToggle) {
      problems.push({ code: 'NOT_SITE_TOGGLE', message: `"${key}" cannot be switched per site.`, key });
    }
  }
  if (problems.length) return c.json({ errors: problems }, 400);

  const siteId = c.get('siteId');
  const stored = await saveSiteReleaseValues(c.get('db'), c.get('runtime')?.cache, siteId, parsed.data.flags);
  await audit(c, 'release_flags.site_updated', { changes: parsed.data.flags });
  c.set('releaseFlags', undefined);
  const states = await releaseFlagStates(c);
  return c.json({
    data: {
      stored,
      flags: Object.keys(parsed.data.flags).map((key) => states.get(key)),
    },
  });
});

releaseFlagsRouter.get('/manifest', async (c) => {
  if (!(await isBootstrapAdmin(c))) return forbidden(c);
  const env = releaseEnvFrom(c);
  const manifest = await loadAcceptedManifest(systemDbFor(c));
  return c.json({
    data: {
      configuration: {
        trustedKeyIds: Object.keys(parseReleasePublicKeys(env.LUMIBASE_RELEASE_PUBLIC_KEYS)),
        pullConfigured: manifestUrlAllowed(env.LUMIBASE_RELEASE_MANIFEST_URL) !== null,
        instanceId: env.LUMIBASE_INSTANCE_ID?.trim() || null,
      },
      manifest: manifest
        ? {
            keyId: manifest.envelope.keyId,
            issuedAt: manifest.issuedAt,
            acceptedAt: manifest.acceptedAt,
            source: manifest.source,
            flags: manifest.flags,
          }
        : null,
      lastPull: lastReleasePullStatus(),
    },
  });
});

const REJECTION_STATUS: Record<Exclude<AcceptOutcome, { ok: true }>['reason'], 400 | 409 | 422> = {
  MALFORMED_ENVELOPE: 400,
  MALFORMED_PAYLOAD: 422,
  UNKNOWN_KEY: 422,
  BAD_SIGNATURE: 422,
  NOT_YET_VALID: 422,
  EXPIRED: 422,
  WRONG_AUDIENCE: 422,
  STALE: 409,
  KEYS_NOT_CONFIGURED: 409,
};

releaseFlagsRouter.put('/manifest', async (c) => {
  if (!(await isBootstrapAdmin(c))) return forbidden(c);
  const body = await c.req.json().catch(() => null);
  const outcome = await acceptReleaseManifest({
    systemDb: systemDbFor(c),
    env: releaseEnvFrom(c),
    input: body,
    source: 'push',
    actorUserId: c.get('auth')?.userId ?? null,
  });
  if (!outcome.ok) {
    await audit(c, 'release_flags.manifest_rejected', { reason: outcome.reason });
    return c.json(
      { errors: [{ code: 'MANIFEST_REJECTED', reason: outcome.reason, message: `Manifest rejected: ${outcome.reason}.` }] },
      REJECTION_STATUS[outcome.reason],
    );
  }
  if (!outcome.unchanged) {
    await audit(c, 'release_flags.manifest_accepted', {
      keyId: outcome.manifest.envelope.keyId,
      issuedAt: outcome.manifest.issuedAt,
      flags: outcome.manifest.flags,
      source: 'push',
    });
  }
  return c.json({
    data: {
      accepted: true,
      unchanged: outcome.unchanged,
      issuedAt: outcome.manifest.issuedAt,
      flags: outcome.manifest.flags,
      unknownKeys: outcome.unknownKeys,
    },
  });
});

releaseFlagsRouter.post('/manifest/pull', async (c) => {
  if (!(await isBootstrapAdmin(c))) return forbidden(c);
  const env = releaseEnvFrom(c);
  if (!manifestUrlAllowed(env.LUMIBASE_RELEASE_MANIFEST_URL)) {
    return c.json(
      {
        errors: [{
          code: 'PULL_NOT_CONFIGURED',
          message: 'Set LUMIBASE_RELEASE_MANIFEST_URL to an https:// URL to enable pulling.',
        }],
      },
      409,
    );
  }
  const outcome = await pullReleaseManifest({ systemDb: systemDbFor(c), env });
  if (!outcome.ok) {
    return c.json({ errors: [{ code: 'PULL_FAILED', reason: outcome.reason, message: `Pull failed: ${outcome.reason}.` }] }, 502);
  }
  if (!outcome.unchanged) {
    await audit(c, 'release_flags.manifest_accepted', { issuedAt: outcome.issuedAt, source: 'pull' });
  }
  return c.json({ data: outcome });
});
