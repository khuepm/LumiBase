import { afterEach, describe, expect, it, vi } from 'vitest';
import { requireSchemaPermission } from '../schema-permissions';
import { PermissionService, type CompiledPermission } from '../../services/permission-service';

describe('schema route permissions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('denies schema actions without explicit schema permission', async () => {
    vi.spyOn(PermissionService.prototype, 'canAccess').mockResolvedValue(null);

    const denied = await requireSchemaPermission(fakeContext(), 'schema:update');

    expect(denied?.status).toBe(403);
    expect(PermissionService.prototype.canAccess).toHaveBeenCalledWith('schema', 'schema:update');
    await expect(denied?.json()).resolves.toEqual({
      errors: [{ code: 'FORBIDDEN', message: 'Action "schema:update" is not allowed.' }],
    });
  });

  it('allows schema actions with matching schema permission', async () => {
    vi.spyOn(PermissionService.prototype, 'canAccess').mockResolvedValue({
      collection: 'schema',
      action: 'schema:read',
      rule: null,
      fields: ['*'],
      presets: {},
      validation: {},
      sources: [{ policyId: 'policy_schema_manager', policyName: 'Schema Manager' }],
    } satisfies CompiledPermission);

    await expect(requireSchemaPermission(fakeContext(), 'schema:read')).resolves.toBeNull();
  });
});

function fakeContext() {
  const headers = new Headers({ 'user-agent': 'vitest' });
  return {
    get(key: string) {
      const values: Record<string, unknown> = {
        auth: { userId: 'user-1', email: 'admin@example.test', roles: [], raw: {} },
        db: {},
        runtime: {},
        siteId: 'site-1',
        ip: '127.0.0.1',
      };
      return values[key];
    },
    req: {
      raw: { headers },
      header(name: string) {
        return headers.get(name) ?? undefined;
      },
    },
    json(body: unknown, status: number) {
      return Response.json(body, { status });
    },
  } as never;
}
