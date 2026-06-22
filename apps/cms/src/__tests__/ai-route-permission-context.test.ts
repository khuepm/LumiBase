import { describe, expect, it } from 'vitest';
import { buildAiItemPermissionContext } from '../routes/ai';

describe('AI route item permission context', () => {
  it('preserves the authenticated principal for ItemService RBAC checks', () => {
    const ctx = buildAiItemPermissionContext({
      auth: {
        userId: 'user-1',
        email: 'editor@example.com',
        roles: ['items:update'],
        apiKey: { id: 'key-1' },
        raw: { organizationId: 'org-1' },
      },
      siteId: 'site-1',
      headers: { 'user-agent': 'vitest', authorization: 'Bearer redacted' },
      ip: '203.0.113.10',
    });

    expect(ctx).toMatchObject({
      userId: 'user-1',
      siteId: 'site-1',
      roleId: null,
      ip: '203.0.113.10',
      headers: { 'user-agent': 'vitest', authorization: 'Bearer redacted' },
      apiKey: { id: 'key-1' },
      user: {
        id: 'user-1',
        email: 'editor@example.com',
        roles: ['items:update'],
        organizationId: 'org-1',
      },
    });
  });

  it('uses null-safe defaults without dropping the site-scoped permission context', () => {
    const ctx = buildAiItemPermissionContext({
      auth: { roles: [], raw: {} },
      siteId: 'site-2',
      headers: {},
      ip: null,
    });

    expect(ctx).toEqual({
      userId: null,
      siteId: 'site-2',
      roleId: null,
      user: { id: null, email: null, roles: [] },
      ip: null,
      headers: {},
      apiKey: null,
    });
  });
});
