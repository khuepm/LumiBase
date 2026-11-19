/**
 * Access to the delivery page builder (`/api/v1/pages`, #986).
 *
 * Pages are served publicly by `GET /api/v1/deliver/page/:site_id/:slug`, so
 * writing one is publishing. The router used to accept any principal that got
 * past the Studio access wall; it now asks the permission service the same
 * question every other surface asks, on the reserved pseudo-collection
 * `lumibase_pages`:
 *
 *   - Site admins bypass, as everywhere else.
 *   - Everyone else needs a `lumibase_pages::<action>` grant. User collections
 *     cannot take the `lumibase_` prefix (schema-service), so a content
 *     collection named `pages` never grants page-builder access by accident.
 *   - The grant's row rule is evaluated against `{ id, slug, title }`, which is
 *     how a policy confines an editor to part of the site:
 *       { "slug": { "_starts_with": "landing/" } }
 *
 * Field whitelists and presets on a `lumibase_pages` permission are not
 * applied: a page has three editable fields and the row rule is the boundary.
 */
import type { Context } from 'hono';
import type { PolicyRule } from '@lumibase/contracts';
import type { AppEnv } from '../env';
import { isSiteAdmin } from '../middleware/site-admin';
import { buildRequestPermissionContext, permissionServiceForRequest } from './item-service-factory';
import { evaluate, type MagicContext } from './permission-dsl';

/** Reserved permission collection for the page builder. */
export const PAGES_PERMISSION_COLLECTION = 'lumibase_pages';

export type PagesAction = 'read' | 'create' | 'update' | 'delete';

export interface PagesAccess {
  admin: boolean;
  /** Row rule for non-admins (`null` = unrestricted grant). */
  rule: PolicyRule | null;
  ctx: MagicContext;
}

/** The fields a `lumibase_pages` rule can test. */
export interface PageSubject {
  id?: string | null;
  slug: string;
  title: string;
}

/** Resolve the caller's access for `action`, or `null` when it has none. */
export async function resolvePagesAccess(c: Context<AppEnv>, action: PagesAction): Promise<PagesAccess | null> {
  const ctx = buildRequestPermissionContext({
    auth: c.get('auth'),
    siteId: c.get('siteId'),
    headers: requestHeaders(c),
    ip: c.get('ip') ?? c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? null,
  });
  if (await isSiteAdmin(c)) return { admin: true, rule: null, ctx };
  const perm = await permissionServiceForRequest(c).canAccess(PAGES_PERMISSION_COLLECTION, action);
  if (!perm) return null;
  return { admin: false, rule: perm.rule ?? null, ctx };
}

/** Whether `access` covers `page`. Admins and unrestricted grants always do. */
export function canActOnPage(access: PagesAccess, page: PageSubject): boolean {
  if (access.admin) return true;
  return evaluate(access.rule, { id: page.id ?? null, slug: page.slug, title: page.title }, access.ctx);
}

function requestHeaders(c: Context<AppEnv>): Record<string, string> {
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return headers;
}
