/**
 * Admin-plane change audit (#988).
 *
 * Every successful mutating request (POST / PUT / PATCH / DELETE) to a route
 * that changes what the site serves, who can do what, or what code runs is
 * recorded as one `admin_change` row in the audit log: extensions, pages,
 * flows, webhooks, settings, schema, roles / policies / permissions, users,
 * domains, API keys, file-upload settings, deployments, and so on.
 *
 * It is a middleware, not a call in each route, on purpose: a new admin route
 * under a covered prefix is audited without anyone remembering to add it, and
 * `admin-change-audit.coverage.test.ts` fails when a control-plane or Studio
 * management prefix is neither covered here nor excluded with a reason.
 *
 * What is recorded — and what is not:
 *   - who (user id + email, or API key id), from where (IP, User-Agent), the
 *     request id, the method, the path, the resource prefix and the first id
 *     segment after it, and the response status;
 *   - the NAMES of the top-level JSON fields the request sent (`changedFields`),
 *     never their values. Webhook secrets, API key material, provider keys and
 *     passwords travel in these bodies; field names are enough to see what an
 *     actor touched, and nothing secret can leak into the trail;
 *   - query strings are never recorded (signed-upload tokens ride there).
 *
 * Denied and failed requests are not recorded here: the guards already audit
 * their denials (`control_plane_access_denied`, …) and a failed write changed
 * nothing. The write is detached from the response (`runDetached`) and the
 * logger never throws, so auditing can neither slow down nor break the change
 * it records.
 *
 * Agent-executed control-plane skills do not pass through these routes; the
 * harness records them with the same event (`via: 'agent'`), see
 * `AISecureHarness.runSkill`.
 */
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env';
import { runDetached } from '../lib/detached';
import { AuditLogger } from '../modules/audit/logger';

export const ADMIN_CHANGE_EVENT = 'admin_change';

/**
 * Prefixes whose mutations are admin-plane changes. Matched as `prefix` or
 * `prefix/…`. Keep sorted; the coverage test enforces that every control-plane
 * and Studio management prefix appears here or in
 * {@link ADMIN_CHANGE_AUDIT_EXCLUSIONS}.
 */
export const ADMIN_CHANGE_AUDIT_PREFIXES = [
  '/api/v1/access',
  '/api/v1/admin',
  '/api/v1/agent',
  '/api/v1/ai/automation',
  '/api/v1/api-keys',
  '/api/v1/cdc',
  '/api/v1/collections',
  '/api/v1/config',
  '/api/v1/deployments',
  '/api/v1/domains',
  '/api/v1/email',
  '/api/v1/extensions',
  '/api/v1/files/folders',
  '/api/v1/files/presigned-url',
  '/api/v1/files/settings',
  '/api/v1/firebase-sync',
  '/api/v1/flows',
  '/api/v1/integrations/git',
  '/api/v1/locale-generation',
  '/api/v1/marketplace',
  '/api/v1/materialize',
  '/api/v1/openapi',
  '/api/v1/pages',
  '/api/v1/permissions',
  '/api/v1/policies',
  '/api/v1/presets',
  '/api/v1/relations',
  '/api/v1/release-flags',
  '/api/v1/retention',
  '/api/v1/roles',
  '/api/v1/scim-tokens',
  '/api/v1/settings',
  '/api/v1/shares',
  '/api/v1/site',
  '/api/v1/teams',
  '/api/v1/transform-presets',
  '/api/v1/translations',
  '/api/v1/users',
  '/api/v1/utils/cache',
  '/api/v1/webhooks',
] as const;

/**
 * Control-plane / Studio prefixes deliberately NOT audited as admin changes,
 * each with the reason. The coverage test reads this map.
 */
export const ADMIN_CHANGE_AUDIT_EXCLUSIONS: Readonly<Record<string, string>> = {
  '/api/v1/realtime': 'Mints short-lived subscription tickets; stores no configuration.',
  '/api/v1/typegen': 'Read-only type generation; has no mutating route.',
};

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_BODY_BYTES = 64 * 1024;
const MAX_FIELDS = 50;
const MAX_FIELD_NAME = 64;

/** The covered prefix `path` falls under, or `null`. Longest match wins. */
export function adminChangePrefix(path: string): string | null {
  let match: string | null = null;
  for (const prefix of ADMIN_CHANGE_AUDIT_PREFIXES) {
    if ((path === prefix || path.startsWith(`${prefix}/`)) && (!match || prefix.length > match.length)) {
      match = prefix;
    }
  }
  return match;
}

/** Top-level field names of a JSON object body, capped; `[]` for anything else. */
export function changedFieldNames(body: unknown): string[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  return Object.keys(body)
    .filter((key) => key.length > 0 && key.length <= MAX_FIELD_NAME)
    .slice(0, MAX_FIELDS);
}

export const withAdminChangeAudit = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (!MUTATING_METHODS.has(method)) return next();
  const path = c.req.path;
  const prefix = adminChangePrefix(path);
  if (!prefix) return next();

  // Field names must be read before the handler consumes the body. A clone
  // tees the stream, so the handler still reads the original untouched.
  const changedFields = await readFieldNames(c.req.raw);

  await next();

  const status = c.res.status;
  if (status >= 400) return;

  const auth = c.get('auth');
  const siteId = c.get('siteId') ?? null;
  const db = c.get('db');
  if (!db) return;

  const rest = path.slice(prefix.length).split('/').filter(Boolean);
  runDetached(
    c,
    new AuditLogger({ db, siteId }).write({
      event: ADMIN_CHANGE_EVENT,
      actorEmail: auth?.email ?? null,
      ip: c.get('ip') ?? c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? null,
      userAgent: c.get('userAgent') ?? c.req.header('user-agent') ?? null,
      requestId: c.get('requestId') ?? null,
      metadata: {
        via: 'api',
        method,
        path,
        resource: prefix.slice('/api/v1/'.length),
        resourceId: rest[0] ?? null,
        status,
        principalType: auth?.type ?? (auth?.apiKeyId ? 'api_key' : 'user'),
        userId: auth?.userId ?? null,
        apiKeyId: auth?.apiKeyId ?? null,
        changedFields,
      },
    }),
  );
};

async function readFieldNames(request: Request): Promise<string[]> {
  const type = request.headers.get('content-type') ?? '';
  if (!type.toLowerCase().includes('application/json')) return [];
  const length = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return [];
  try {
    const text = await request.clone().text();
    if (text.length === 0 || text.length > MAX_BODY_BYTES) return [];
    return changedFieldNames(JSON.parse(text));
  } catch {
    return [];
  }
}
