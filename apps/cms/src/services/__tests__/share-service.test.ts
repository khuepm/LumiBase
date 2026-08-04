import type { Database } from '@lumibase/database';
import type { CacheProvider } from '@lumibase/runtime';
import { describe, expect, it } from 'vitest';
import { ShareService, ShareServiceError, hashShareToken } from '../share-service';

const SITE_ID = 'site_1';
const ROLE_ID = 'role_share';
const TOKEN = 'share-token';

const now = new Date('2026-06-05T08:00:00.000Z');

function shareRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'share_1',
    siteId: SITE_ID,
    collection: 'posts',
    itemId: 'item_visible',
    roleId: ROLE_ID,
    tokenHash: 'hash',
    passwordHash: null,
    validFrom: null,
    validUntil: null,
    maxUses: null,
    usedCount: 0,
    revokedAt: null,
    revokedBy: null,
    createdBy: 'user_1',
    lastUsedAt: null,
    createdAt: now,
    ...overrides,
  };
}

const roleRow = {
  id: ROLE_ID,
  siteId: SITE_ID,
  key: 'public_posts',
  systemKey: null,
  name: 'Public posts',
  description: null,
  icon: null,
  parentId: null,
  adminAccess: false,
  appAccess: false,
  createdAt: now,
};

const policyRow = {
  id: 'policy_share_read',
  siteId: SITE_ID,
  key: 'share_read',
  name: 'Share read',
  description: null,
  icon: null,
  adminAccess: false,
  appAccess: false,
  enforceTfa: false,
  ipAllow: [],
  ipDeny: [],
  validFrom: null,
  validUntil: null,
  rules: {},
  createdAt: now,
};

const permissionRow = {
  id: 'perm_share_read_posts',
  siteId: SITE_ID,
  policyId: 'policy_share_read',
  collection: 'posts',
  action: 'read',
  permissions: { status: { _eq: 'published' } },
  validation: {},
  presets: {},
  fields: ['*'],
};

const creatorPermissionRow = {
  ...permissionRow,
  id: 'perm_creator_read_posts',
  fields: ['title', 'status'],
};

const userRow = {
  id: 'user_1',
  externalId: null,
  email: 'creator@example.com',
  firstName: null,
  lastName: null,
  status: 'active',
  preferences: {},
  tfa: {},
  isBootstrap: false,
  lastSeenAt: null,
  createdAt: now,
  updatedAt: now,
};

const collectionRow = {
  id: 'collection_posts',
  siteId: SITE_ID,
  name: 'posts',
  singleton: false,
  displayTemplate: null,
  sortField: null,
  archiveField: null,
  archiveValue: null,
  meta: {},
  createdAt: now,
  updatedAt: now,
};

const visibleItemRow = {
  id: 'item_visible',
  siteId: SITE_ID,
  collectionId: 'collection_posts',
  status: 'published',
  sort: 0,
  userCreated: null,
  userUpdated: null,
  data: { title: 'Visible', status: 'published', secret: 'hidden' },
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
};

function fieldRow(name: string) {
  return {
    id: `field_${name}`,
    siteId: SITE_ID,
    collectionId: 'collection_posts',
    name,
    type: 'string',
    interface: 'input',
    display: null,
    options: {},
    displayOptions: {},
    validation: { rules: [] },
    conditions: [],
    translations: {},
    required: false,
    readonly: false,
    hidden: false,
    encrypted: false,
    versioned: false,
    rawEnabled: true,
    width: 'full',
    group: null,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function makeDb(results: unknown[][]): { db: Database; state: { updates: number } } {
  let selectIndex = 0;
  const state = { updates: 0 };
  const selectFluent = {
    from: () => selectFluent,
    innerJoin: () => selectFluent,
    where: () => selectFluent,
    orderBy: () => Promise.resolve(results[selectIndex++] ?? []),
    limit: () => Promise.resolve(results[selectIndex++] ?? []),
    then: (resolve: (value: unknown) => void, reject: (reason?: unknown) => void) =>
      Promise.resolve(results[selectIndex++] ?? []).then(resolve, reject),
  };
  const updateFluent = {
    set: () => updateFluent,
    where: () => {
      state.updates += 1;
      return Promise.resolve([]);
    },
    returning: () => Promise.resolve([]),
  };
  return {
    state,
    db: {
      select: () => selectFluent,
      update: () => updateFluent,
    } as unknown as Database,
  };
}

function successfulReadResults(overrides: { share?: Record<string, unknown>; itemRows?: unknown[] } = {}) {
  return [
    [shareRow({ tokenHash: 'ignored', ...overrides.share })],
    [roleRow],
    [{ policyId: 'policy_share_read', priority: 100 }],
    [policyRow],
    [permissionRow],
    [userRow],
    [roleRow],
    [],
    [{ policyId: 'policy_share_read', priority: 100 }],
    [],
    [policyRow],
    [creatorPermissionRow],
    [collectionRow],
    overrides.itemRows ?? [visibleItemRow],
    [collectionRow],
    [collectionRow],
    [fieldRow('title'), fieldRow('status'), fieldRow('secret')],
  ];
}

function makePermissionCache(entries: Record<string, unknown>): CacheProvider {
  return {
    get: async (key: string) => entries[key] ?? null,
    set: async () => undefined,
    delete: async () => undefined,
    increment: async () => 1,
    getEntry: async (key: string) => {
      const v = entries[key];
      return v === undefined ? { state: 'miss' as const } : { state: 'hit' as const, value: v };
    },
    setNegative: async () => undefined,
    invalidateByTag: async () => undefined,
  } as unknown as CacheProvider;
}

describe('ShareService create links', () => {
  it('requires the creator to have read permission before sharing', async () => {
    const cache = makePermissionCache({
      [`perm:${SITE_ID}:user_1`]: {
        admin: false,
        appAccess: false,
        tfaRequired: false,
        roles: [],
        policies: [],
        byKey: {
          'posts::share': {
            collection: 'posts',
            action: 'share',
            rule: null,
            fields: ['*'],
            presets: {},
            validation: {},
            sources: [],
          },
        },
      },
    });
    const { db } = makeDb([]);
    const promise = new ShareService({ db, cache, siteId: SITE_ID, now }).create({
      collection: 'posts',
      itemId: 'item_visible',
      roleId: ROLE_ID,
      actor: { userId: 'user_1' },
    });

    await expect(promise).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
  });
});

describe('ShareService public read links', () => {
  it('returns only rows and fields allowed by both the share role and creator read policies', async () => {
    const { db, state } = makeDb(successfulReadResults());
    const result = await new ShareService({ db, now }).read({ token: TOKEN });

    expect(result.item.data).toEqual({ title: 'Visible', status: 'published' });
    expect(state.updates).toBe(1);
  });

  it('denies rows filtered out by the share role policy', async () => {
    const { db, state } = makeDb(successfulReadResults({ itemRows: [] }));
    const promise = new ShareService({ db, now }).read({ token: TOKEN });

    await expect(promise).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect(state.updates).toBe(0);
  });

  it('denies revoked share links', async () => {
    const { db, state } = makeDb([[shareRow({ revokedAt: new Date('2026-06-05T07:00:00.000Z') })]]);
    const promise = new ShareService({ db, now }).read({ token: TOKEN });

    await expect(promise).rejects.toBeInstanceOf(ShareServiceError);
    await expect(promise).rejects.toMatchObject({ code: 'SHARE_REVOKED', status: 403 });
    expect(state.updates).toBe(0);
  });

  it('returns 401 for expired share links', async () => {
    const { db } = makeDb([[shareRow({ validUntil: new Date('2026-06-05T07:59:59.000Z') })]]);
    const promise = new ShareService({ db, now }).read({ token: TOKEN });

    await expect(promise).rejects.toMatchObject({ code: 'SHARE_EXPIRED', status: 401 });
  });

  it('denies share links after max uses is reached', async () => {
    const { db } = makeDb([[shareRow({ maxUses: 3, usedCount: 3 })]]);
    const promise = new ShareService({ db, now }).read({ token: TOKEN });

    await expect(promise).rejects.toMatchObject({ code: 'SHARE_MAX_USES_REACHED', status: 403 });
  });
});

describe('hashShareToken', () => {
  it('hashes tokens deterministically without returning the plaintext', async () => {
    const first = await hashShareToken(TOKEN);
    const second = await hashShareToken(TOKEN);

    expect(first).toBe(second);
    expect(first).not.toBe(TOKEN);
  });
});
