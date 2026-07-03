import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env';
import { AuditLogger } from '../modules/audit/logger';

type SecurityGuardEvent =
  | 'control_plane_access_denied'
  | 'file_upload_policy_denied'
  | 'mcp_control_plane_skill_denied';

export async function auditSecurityGuardDenied(
  c: Parameters<MiddlewareHandler<AppEnv>>[0],
  event: SecurityGuardEvent,
  metadata: Record<string, unknown>,
): Promise<void> {
  const db = safeGetDb(c);
  if (!db) return;

  const auth = safeGetAuth(c);
  await new AuditLogger({ db, siteId: safeGetSiteId(c) }).write({
    event,
    actorEmail: auth?.email ?? null,
    ip: safeGetStringVar(c, 'ip') ?? c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? null,
    userAgent: safeGetStringVar(c, 'userAgent') ?? c.req.header('user-agent') ?? null,
    requestId: safeGetStringVar(c, 'requestId') ?? null,
    metadata,
  });
}

function safeGetAuth(c: Parameters<MiddlewareHandler<AppEnv>>[0]): AppEnv['Variables']['auth'] | undefined {
  try {
    return c.get('auth');
  } catch {
    return undefined;
  }
}

function safeGetDb(c: Parameters<MiddlewareHandler<AppEnv>>[0]): AppEnv['Variables']['db'] | undefined {
  try {
    return c.get('db');
  } catch {
    return undefined;
  }
}

function safeGetSiteId(c: Parameters<MiddlewareHandler<AppEnv>>[0]): string | null {
  try {
    return c.get('siteId') ?? null;
  } catch {
    return null;
  }
}

function safeGetStringVar(c: Parameters<MiddlewareHandler<AppEnv>>[0], key: 'ip' | 'userAgent' | 'requestId'): string | null {
  try {
    return c.get(key) ?? null;
  } catch {
    return null;
  }
}
