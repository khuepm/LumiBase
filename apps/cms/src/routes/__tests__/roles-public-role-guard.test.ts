import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { roles } from '@lumibase/database';
import type { AppEnv } from '../../env';
import { PUBLIC_SYSTEM_KEY } from '../../services/auth/public-role';

/**
 * `DELETE /roles/:id` must not be a back door onto the anonymous realm.
 *
 * "Public access is enabled" is not a flag in this design — it *is* the
 * existence of the site's `public` role (`resolvePublicRoleId` returns null
 * when the role is absent, and `withAuth` then produces no anonymous
 * principal). So deleting that role through the generic role editor turns
 * anonymous access off, but does it the wrong way:
 *
 *   - `disablePublicAccess` also removes the realm policy and its permission
 *     rows, deliberately, so a later re-enable starts from a clean slate
 *     instead of silently restoring grants the operator has since forgotten.
 *     A raw delete leaves them behind.
 *   - the `public_access_disabled` audit event is never written, so the change
 *     is invisible in the audit trail.
 *
 * `PATCH /roles/:id` and `POST /roles/:id/policies` already screen this role;
 * DELETE was the one verb that did not.
 */

vi.mock('../../services/permission-invalidation', () => ({
  bumpPermissionVersion: vi.fn(async () => undefined),
}));

function stubDb(opts: { systemKey?: string | null; deleted?: unknown[] }) {
  return {
    select() {
      let table: unknown;
      const chain: any = {
        from(t: unknown) {
          table = t;
          return chain;
        },
        innerJoin: () => chain,
        where: () => chain,
        limit: () =>
          Promise.resolve(
            table === roles && opts.systemKey !== undefined
              ? [{ systemKey: opts.systemKey }]
              : [],
          ),
        then: (resolve: (v: unknown) => void) => resolve([]),
      };
      return chain;
    },
    delete() {
      const chain: any = {
        where: () => chain,
        returning: () => Promise.resolve(opts.deleted ?? [{ id: 'role_1' }]),
        then: (resolve: (v: unknown) => void) => resolve(undefined),
      };
      return chain;
    },
  } as never;
}

async function deleteRole(opts: Parameters<typeof stubDb>[0]): Promise<Response> {
  const { rolesRouter } = await import('../roles');
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', stubDb(opts));
    c.set('siteId', 'site_1');
    c.set('runtime', { cache: undefined } as never);
    c.set('auth', { type: 'user', userId: 'u1', email: 'admin@example.test', roles: [], raw: {} });
    await next();
  });
  app.route('/', rolesRouter);
  return app.request('/role_1', { method: 'DELETE' }, {});
}

describe('DELETE /roles/:id', () => {
  it('refuses to delete the public role', async () => {
    const res = await deleteRole({ systemKey: PUBLIC_SYSTEM_KEY });

    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.errors[0].code).toBe('PUBLIC_ROLE_NOT_DELETABLE');
    // Point the operator at the endpoint that also clears grants and audits.
    expect(body.errors[0].message).toContain('/access/grants/public/disable');
  });

  it('deletes an ordinary role', async () => {
    const res = await deleteRole({ systemKey: null });
    expect(res.status).toBe(204);
  });

  it('404s an id that does not exist instead of reporting a phantom 204', async () => {
    const res = await deleteRole({ systemKey: null, deleted: [] });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ errors: [{ code: 'NOT_FOUND' }] });
  });
});
