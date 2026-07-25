import { describe, expect, it } from 'vitest';
import type { CompiledPermission } from '../../services/permission-service';
import { readableCollections } from '../studio-grant';

/**
 * Studio ticket allowlist derivation (realtime-subscriptions Req 2.1/2.2 —
 * subscribe read-gate). The DB-dependent part (PermissionService.bundle) has
 * its own coverage; this locks the bundle → allowlist mapping.
 */

const perm = {} as CompiledPermission;

describe('readableCollections', () => {
  it('admin bypass → wildcard', () => {
    expect(readableCollections({ admin: true, byKey: {} })).toEqual(['*']);
  });

  it('collects exactly the collections with a read grant', () => {
    expect(
      readableCollections({
        admin: false,
        byKey: {
          'posts::read': perm,
          'posts::update': perm,
          'pages::read': perm,
          'salaries::update': perm, // update-only → NOT subscribable
        },
      }),
    ).toEqual(['pages', 'posts']);
  });

  it('read_decrypted alone does not grant a subscription', () => {
    expect(readableCollections({ admin: false, byKey: { 'secrets::read_decrypted': perm } })).toEqual([]);
  });

  it('no grants → empty allowlist (fail-closed at the hub)', () => {
    expect(readableCollections({ admin: false, byKey: {} })).toEqual([]);
  });
});
