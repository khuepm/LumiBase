import { apiKeyPolicies, apiKeyRoles, apiKeys, policies, rolePolicies, roles, scopeSite } from '@lumibase/database';
import { and, eq, inArray } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv, AuthPrincipal } from '../env';
import { AuditLogger } from '../modules/audit/logger';
import {
  ALLOWED_ORIGINS_METADATA_KEY,
  isPublishablePrefix,
  normalizeOrigin,
  readAllowedOrigins,
  screenPolicyForPublishableKey,
} from '../services/api-key-publishable';
import { createPlaintextToken } from '../services/api-key-token';
import { buildAccessConflictReport } from '../services/access-conflict-report';
import { bumpPermissionVersion } from '../services/permission-invalidation';

export const apiKeysRouter = new Hono<AppEnv>();

const createApiKey = z.object({
  name: z.string().min(1).max(96),
  description: z.string().max(512).optional(),
  expiresAt: z.coerce.date().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
  /**
   * Mint a client-embeddable `lbk_pub_…` token instead of a secret one.
   * Defaults to false so the existing contract is unchanged.
   */
  publishable: z.boolean().optional(),
  /**
   * Origins this key may be used from in a browser. Empty/omitted = no origin
   * constraint. Only meaningful for publishable keys.
   */
  allowedOrigins: z.array(z.string()).optional(),
});

const rotateApiKey = z.object({
  expiresAt: z.coerce.date().nullable().optional(),
});

const attachRole = z.object({
  roleId: z.string().min(1),
  priority: z.number().int().optional(),
  overrideWarnings: z.boolean().optional(),
});

const attachPolicy = z.object({
  policyId: z.string().min(1),
  priority: z.number().int().optional(),
  overrideWarnings: z.boolean().optional(),
});

/** Split an operator-supplied origin list into normalised and unparseable. */
function normalizeOriginList(input: string[] | undefined): {
  valid: string[];
  invalid: string[];
} {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const entry of input ?? []) {
    const normalized = normalizeOrigin(entry);
    if (normalized) valid.push(normalized);
    else invalid.push(entry);
  }
  return { valid: Array.from(new Set(valid)), invalid };
}

/**
 * Merge the origin allowlist into a metadata blob.
 *
 * An empty list removes the key rather than storing `[]`, so "no constraint" is
 * one representation instead of two.
 */
function withAllowedOrigins(
  metadata: Record<string, unknown> | undefined,
  origins: string[],
): Record<string, unknown> {
  const next = { ...(metadata ?? {}) };
  if (origins.length > 0) next[ALLOWED_ORIGINS_METADATA_KEY] = origins;
  else delete next[ALLOWED_ORIGINS_METADATA_KEY];
  return next;
}

/**
 * Refuse attaching an elevated policy to a publishable key.
 *
 * A publishable key is shipped to clients, so `adminAccess` on it would be an
 * unauthenticated admin bypass. Returns a response to send, or null to proceed.
 */
async function screenPublishableAttachment(
  c: Context<AppEnv>,
  apiKeyId: string,
  policyIds: string[],
): Promise<Response | null> {
  if (policyIds.length === 0) return null;

  const [key] = await c
    .get('db')
    .select({ prefix: apiKeys.prefix })
    .from(apiKeys)
    .where(and(scopeSite(apiKeys.siteId, c.get('siteId')), eq(apiKeys.id, apiKeyId)))
    .limit(1);
  if (!key || !isPublishablePrefix(key.prefix)) return null;

  const rows = await c
    .get('db')
    .select({
      id: policies.id,
      name: policies.name,
      adminAccess: policies.adminAccess,
      appAccess: policies.appAccess,
    })
    .from(policies)
    .where(and(scopeSite(policies.siteId, c.get('siteId')), inArray(policies.id, policyIds)));

  const offenders = rows
    .map((row) => ({ name: row.name, flags: screenPolicyForPublishableKey(row) }))
    .filter((entry) => entry.flags.length > 0);
  if (offenders.length === 0) return null;

  return c.json(
    {
      errors: [
        {
          code: 'PUBLISHABLE_KEY_ELEVATION',
          message:
            'A publishable key is embedded in clients and must be treated as public, ' +
            `so it cannot carry ${offenders
              .map((o) => `${o.flags.join('/')} (via "${o.name}")`)
              .join(', ')}. Use a secret key held server-side instead.`,
        },
      ],
    },
    400,
  );
}

async function apiKeyAttachments(c: Context<AppEnv>, apiKeyId: string): Promise<{
  roles: Array<{ roleId: string; priority: number }>;
  policies: Array<{ policyId: string; priority: number }>;
}> {
  const [roleRows, policyRows] = await Promise.all([
    c
      .get('db')
      .select({ roleId: apiKeyRoles.roleId, priority: apiKeyRoles.priority })
      .from(apiKeyRoles)
      .where(and(eq(apiKeyRoles.siteId, c.get('siteId')), eq(apiKeyRoles.apiKeyId, apiKeyId))),
    c
      .get('db')
      .select({ policyId: apiKeyPolicies.policyId, priority: apiKeyPolicies.priority })
      .from(apiKeyPolicies)
      .where(and(eq(apiKeyPolicies.siteId, c.get('siteId')), eq(apiKeyPolicies.apiKeyId, apiKeyId))),
  ]);
  return {
    roles: roleRows,
    policies: policyRows,
  };
}

async function publicApiKey(c: Context<AppEnv>, row: typeof apiKeys.$inferSelect): Promise<Record<string, unknown>> {
  const attachments = await apiKeyAttachments(c, row.id);
  return {
    id: row.id,
    siteId: row.siteId,
    name: row.name,
    description: row.description,
    prefix: row.prefix,
    createdBy: row.createdBy,
    rotatedAt: row.rotatedAt,
    rotatedBy: row.rotatedBy,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    revokedBy: row.revokedBy,
    lastUsedAt: row.lastUsedAt,
    lastUsedIp: row.lastUsedIp,
    lastUsedUserAgent: row.lastUsedUserAgent,
    metadata: row.metadata,
    /** Derived from the prefix, so it always matches the token in the wild. */
    publishable: isPublishablePrefix(row.prefix),
    allowedOrigins: readAllowedOrigins(row.metadata),
    createdAt: row.createdAt,
    roles: attachments.roles,
    policies: attachments.policies,
  };
}

function requireUserPrincipal(c: Context<AppEnv>): (AuthPrincipal & { userId: string }) | null {
  const auth = c.get('auth');
  if (auth?.type === 'api_key' || !auth?.userId) {
    return null;
  }
  return auth as AuthPrincipal & { userId: string };
}

async function writeApiKeyAudit(
  c: Context<AppEnv>,
  event: 'api_key_created' | 'api_key_rotated' | 'api_key_revoked',
  auth: AuthPrincipal & { userId: string },
  row: typeof apiKeys.$inferSelect,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await new AuditLogger({ db: c.get('db'), siteId: c.get('siteId') }).write({
    event,
    actorEmail: auth.email ?? null,
    ip: c.get('ip') ?? null,
    userAgent: c.get('userAgent') ?? null,
    requestId: c.get('requestId') ?? null,
    metadata: {
      apiKeyId: row.id,
      apiKeyName: row.name,
      prefix: row.prefix,
      siteId: row.siteId,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      ...extra,
    },
  });
}

async function ensureApiKeyExists(c: Context<AppEnv>, id: string): Promise<boolean> {
  const [row] = await c
    .get('db')
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(and(scopeSite(apiKeys.siteId, c.get('siteId')), eq(apiKeys.id, id)))
    .limit(1);
  return !!row;
}

async function ensureRoleExists(c: Context<AppEnv>, id: string): Promise<boolean> {
  const [row] = await c
    .get('db')
    .select({ id: roles.id })
    .from(roles)
    .where(and(scopeSite(roles.siteId, c.get('siteId')), eq(roles.id, id)))
    .limit(1);
  return !!row;
}

async function ensurePolicyExists(c: Context<AppEnv>, id: string): Promise<boolean> {
  const [row] = await c
    .get('db')
    .select({ id: policies.id })
    .from(policies)
    .where(and(scopeSite(policies.siteId, c.get('siteId')), eq(policies.id, id)))
    .limit(1);
  return !!row;
}

async function auditWarningOverride(
  c: Context<AppEnv>,
  auth: AuthPrincipal & { userId: string },
  metadata: Record<string, unknown>,
): Promise<void> {
  await new AuditLogger({ db: c.get('db'), siteId: c.get('siteId') }).write({
    event: 'access_policy_warning_overridden',
    actorEmail: auth.email ?? null,
    ip: c.get('ip') ?? null,
    userAgent: c.get('userAgent') ?? null,
    requestId: c.get('requestId') ?? null,
    metadata,
  });
}

apiKeysRouter.use('*', async (c, next) => {
  if (!requireUserPrincipal(c)) {
    return c.json(
      { errors: [{ code: 'FORBIDDEN', message: 'API keys can only be managed by user principals.' }] },
      403,
    );
  }
  return next();
});

apiKeysRouter.get('/', async (c) => {
  const rows = await c
    .get('db')
    .select()
    .from(apiKeys)
    .where(scopeSite(apiKeys.siteId, c.get('siteId')));
  const data = await Promise.all(rows.map((row) => publicApiKey(c, row)));
  return c.json({ data });
});

apiKeysRouter.post('/', async (c) => {
  const auth = requireUserPrincipal(c);
  if (!auth) {
    return c.json(
      { errors: [{ code: 'FORBIDDEN', message: 'API keys can only be managed by user principals.' }] },
      403,
    );
  }

  const parsed = createApiKey.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }

  const origins = normalizeOriginList(parsed.data.allowedOrigins);
  if (origins.invalid.length > 0) {
    return c.json(
      {
        errors: [
          {
            code: 'VALIDATION',
            message: `Unparseable origin(s): ${origins.invalid.join(', ')}. Use a full origin such as https://example.com.`,
          },
        ],
      },
      400,
    );
  }

  const token = await createPlaintextToken({ publishable: parsed.data.publishable });
  const [row] = await c
    .get('db')
    .insert(apiKeys)
    .values({
      siteId: c.get('siteId'),
      name: parsed.data.name,
      description: parsed.data.description,
      prefix: token.prefix,
      tokenHash: token.tokenHash,
      createdBy: auth.userId,
      expiresAt: parsed.data.expiresAt ?? null,
      metadata: withAllowedOrigins(parsed.data.metadata, origins.valid),
    })
    .returning();

  if (!row) return c.json({ errors: [{ code: 'CREATE_FAILED', message: 'Failed to create API key.' }] }, 500);
  await writeApiKeyAudit(c, 'api_key_created', auth, row);
  return c.json({ data: { ...(await publicApiKey(c, row)), token: token.token } }, 201);
});

apiKeysRouter.get('/:id', async (c) => {
  const [row] = await c
    .get('db')
    .select()
    .from(apiKeys)
    .where(and(scopeSite(apiKeys.siteId, c.get('siteId')), eq(apiKeys.id, c.req.param('id'))))
    .limit(1);
  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND', message: 'API key not found.' }] }, 404);
  return c.json({ data: await publicApiKey(c, row) });
});

/**
 * Replace a key's origin allowlist.
 *
 * Separate from create so an operator can tighten (or open up) a live key
 * without rotating the token — the whole point of the allowlist is that it is
 * adjustable without redeploying whatever ships the key.
 */
apiKeysRouter.patch('/:id/allowed-origins', async (c) => {
  const auth = requireUserPrincipal(c);
  if (!auth) {
    return c.json(
      { errors: [{ code: 'FORBIDDEN', message: 'API keys can only be managed by user principals.' }] },
      403,
    );
  }

  const parsed = z
    .object({ allowedOrigins: z.array(z.string()) })
    .safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }

  const origins = normalizeOriginList(parsed.data.allowedOrigins);
  if (origins.invalid.length > 0) {
    return c.json(
      {
        errors: [
          {
            code: 'VALIDATION',
            message: `Unparseable origin(s): ${origins.invalid.join(', ')}. Use a full origin such as https://example.com.`,
          },
        ],
      },
      400,
    );
  }

  const [before] = await c
    .get('db')
    .select()
    .from(apiKeys)
    .where(and(scopeSite(apiKeys.siteId, c.get('siteId')), eq(apiKeys.id, c.req.param('id'))))
    .limit(1);
  if (!before) return c.json({ errors: [{ code: 'NOT_FOUND', message: 'API key not found.' }] }, 404);

  const [row] = await c
    .get('db')
    .update(apiKeys)
    .set({
      metadata: withAllowedOrigins(before.metadata as Record<string, unknown>, origins.valid),
    })
    .where(and(scopeSite(apiKeys.siteId, c.get('siteId')), eq(apiKeys.id, c.req.param('id'))))
    .returning();
  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND', message: 'API key not found.' }] }, 404);

  await new AuditLogger({ db: c.get('db'), siteId: c.get('siteId') }).write({
    event: 'api_key_origins_updated',
    actorEmail: auth.email ?? null,
    ip: c.get('ip') ?? null,
    userAgent: c.get('userAgent') ?? null,
    requestId: c.get('requestId') ?? null,
    metadata: {
      apiKeyId: row.id,
      prefix: row.prefix,
      previous: readAllowedOrigins(before.metadata),
      next: origins.valid,
    },
  });

  return c.json({ data: await publicApiKey(c, row) });
});

apiKeysRouter.post('/:id/rotate', async (c) => {
  const auth = requireUserPrincipal(c);
  if (!auth) {
    return c.json(
      { errors: [{ code: 'FORBIDDEN', message: 'API keys can only be managed by user principals.' }] },
      403,
    );
  }

  const parsed = rotateApiKey.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }

  const [before] = await c
    .get('db')
    .select()
    .from(apiKeys)
    .where(and(scopeSite(apiKeys.siteId, c.get('siteId')), eq(apiKeys.id, c.req.param('id'))))
    .limit(1);
  if (!before) return c.json({ errors: [{ code: 'NOT_FOUND', message: 'API key not found.' }] }, 404);

  // Rotation mints a fresh token, and the prefix is what marks a key as
  // publishable — so it must be carried across or a rotated publishable key
  // would silently come back as a secret one (dropping its origin allowlist
  // enforcement along with it).
  const token = await createPlaintextToken({ publishable: isPublishablePrefix(before.prefix) });

  const nextExpiresAt = Object.prototype.hasOwnProperty.call(parsed.data, 'expiresAt')
    ? parsed.data.expiresAt ?? null
    : undefined;
  const [row] = await c
    .get('db')
    .update(apiKeys)
    .set({
      prefix: token.prefix,
      tokenHash: token.tokenHash,
      rotatedAt: new Date(),
      rotatedBy: auth.userId,
      revokedAt: null,
      revokedBy: null,
      expiresAt: nextExpiresAt,
    })
    .where(and(scopeSite(apiKeys.siteId, c.get('siteId')), eq(apiKeys.id, c.req.param('id'))))
    .returning();

  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND', message: 'API key not found.' }] }, 404);
  await writeApiKeyAudit(c, 'api_key_rotated', auth, row, {
    previousPrefix: before.prefix,
    newPrefix: row.prefix,
  });
  await bumpPermissionVersion(c);
  return c.json({ data: { ...(await publicApiKey(c, row)), token: token.token } });
});

apiKeysRouter.post('/:id/revoke', async (c) => {
  const auth = requireUserPrincipal(c);
  if (!auth) {
    return c.json(
      { errors: [{ code: 'FORBIDDEN', message: 'API keys can only be managed by user principals.' }] },
      403,
    );
  }

  const [row] = await c
    .get('db')
    .update(apiKeys)
    .set({
      revokedAt: new Date(),
      revokedBy: auth.userId,
    })
    .where(and(scopeSite(apiKeys.siteId, c.get('siteId')), eq(apiKeys.id, c.req.param('id'))))
    .returning();

  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND', message: 'API key not found.' }] }, 404);
  await writeApiKeyAudit(c, 'api_key_revoked', auth, row);
  await bumpPermissionVersion(c);
  return c.json({ data: await publicApiKey(c, row) });
});

apiKeysRouter.post('/:id/roles', async (c) => {
  const auth = requireUserPrincipal(c);
  if (!auth) {
    return c.json(
      { errors: [{ code: 'FORBIDDEN', message: 'API keys can only be managed by user principals.' }] },
      403,
    );
  }

  const parsed = attachRole.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }

  const apiKeyId = c.req.param('id');
  if (!(await ensureApiKeyExists(c, apiKeyId))) {
    return c.json({ errors: [{ code: 'NOT_FOUND', message: 'API key not found.' }] }, 404);
  }
  if (!(await ensureRoleExists(c, parsed.data.roleId))) {
    return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Role not found.' }] }, 404);
  }

  const rolePolicyRows = await c
    .get('db')
    .select({ policyId: rolePolicies.policyId })
    .from(rolePolicies)
    .where(eq(rolePolicies.roleId, parsed.data.roleId));
  const addPolicies = rolePolicyRows.map((r) => r.policyId);
  const elevation = await screenPublishableAttachment(c, apiKeyId, addPolicies);
  if (elevation) return elevation;
  const report = await buildAccessConflictReport({
    db: c.get('db'),
    siteId: c.get('siteId'),
    target: { type: 'api_key', id: apiKeyId },
    addPolicies,
  });
  if (report.conflicts.length > 0) {
    return c.json({
      errors: [{ code: 'ACCESS_POLICY_CONFLICT', message: 'Policy conflicts must be resolved before attaching.' }],
      data: report,
    }, 409);
  }
  if (report.warnings.length > 0 && !parsed.data.overrideWarnings) {
    return c.json({
      errors: [{ code: 'ACCESS_POLICY_WARNING', message: 'Policy warnings require explicit override.' }],
      data: report,
    }, 409);
  }
  if (report.warnings.length > 0) {
    await auditWarningOverride(c, auth, {
      targetType: 'api_key',
      targetId: apiKeyId,
      roleId: parsed.data.roleId,
      policyIds: addPolicies,
      warnings: report.warnings,
    });
  }

  const [row] = await c
    .get('db')
    .insert(apiKeyRoles)
    .values({
      apiKeyId,
      siteId: c.get('siteId'),
      roleId: parsed.data.roleId,
      priority: parsed.data.priority ?? 100,
    })
    .returning();
  await bumpPermissionVersion(c);
  return c.json({ data: row }, 201);
});

apiKeysRouter.delete('/:id/roles/:roleId', async (c) => {
  await c
    .get('db')
    .delete(apiKeyRoles)
    .where(
      and(
        eq(apiKeyRoles.apiKeyId, c.req.param('id')),
        eq(apiKeyRoles.siteId, c.get('siteId')),
        eq(apiKeyRoles.roleId, c.req.param('roleId')),
      ),
    );
  await bumpPermissionVersion(c);
  return c.body(null, 204);
});

apiKeysRouter.post('/:id/policies', async (c) => {
  const auth = requireUserPrincipal(c);
  if (!auth) {
    return c.json(
      { errors: [{ code: 'FORBIDDEN', message: 'API keys can only be managed by user principals.' }] },
      403,
    );
  }

  const parsed = attachPolicy.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }

  const apiKeyId = c.req.param('id');
  if (!(await ensureApiKeyExists(c, apiKeyId))) {
    return c.json({ errors: [{ code: 'NOT_FOUND', message: 'API key not found.' }] }, 404);
  }
  if (!(await ensurePolicyExists(c, parsed.data.policyId))) {
    return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Policy not found.' }] }, 404);
  }

  const elevation = await screenPublishableAttachment(c, apiKeyId, [parsed.data.policyId]);
  if (elevation) return elevation;

  const report = await buildAccessConflictReport({
    db: c.get('db'),
    siteId: c.get('siteId'),
    target: { type: 'api_key', id: apiKeyId },
    addPolicies: [parsed.data.policyId],
  });
  if (report.conflicts.length > 0) {
    return c.json({
      errors: [{ code: 'ACCESS_POLICY_CONFLICT', message: 'Policy conflicts must be resolved before attaching.' }],
      data: report,
    }, 409);
  }
  if (report.warnings.length > 0 && !parsed.data.overrideWarnings) {
    return c.json({
      errors: [{ code: 'ACCESS_POLICY_WARNING', message: 'Policy warnings require explicit override.' }],
      data: report,
    }, 409);
  }
  if (report.warnings.length > 0) {
    await auditWarningOverride(c, auth, {
      targetType: 'api_key',
      targetId: apiKeyId,
      policyId: parsed.data.policyId,
      warnings: report.warnings,
    });
  }

  const [row] = await c
    .get('db')
    .insert(apiKeyPolicies)
    .values({
      apiKeyId,
      siteId: c.get('siteId'),
      policyId: parsed.data.policyId,
      priority: parsed.data.priority ?? 100,
    })
    .returning();
  await bumpPermissionVersion(c);
  return c.json({ data: row }, 201);
});

apiKeysRouter.delete('/:id/policies/:policyId', async (c) => {
  await c
    .get('db')
    .delete(apiKeyPolicies)
    .where(
      and(
        eq(apiKeyPolicies.apiKeyId, c.req.param('id')),
        eq(apiKeyPolicies.siteId, c.get('siteId')),
        eq(apiKeyPolicies.policyId, c.req.param('policyId')),
      ),
    );
  await bumpPermissionVersion(c);
  return c.body(null, 204);
});
