import { describe, it, expect, vi } from 'vitest';
import { rewrapBatch } from '../rewrap-worker';
import { CryptoService } from '../crypto-service';
import { EnvKeyProvider } from '@lumibase/runtime';
import { items, collections } from '@lumibase/database';
import type { Database } from '@lumibase/database';

const KEY_V0 = Buffer.alloc(32, 1).toString('base64');
const KEY_V1 = Buffer.alloc(32, 2).toString('base64');

// SchemaService is constructed inside rewrapBatch; stub getCompiled.
vi.mock('../schema-service', () => ({
  SchemaService: vi.fn().mockImplementation(function () {
    return {
      getCompiled: vi.fn().mockResolvedValue({
        fields: [
          { name: 'name', encrypted: false },
          { name: 'ssn', encrypted: true },
        ],
      }),
    };
  }),
}));

function makeDb(itemRows: Record<string, unknown>[]) {
  const updates: { id: unknown; data: Record<string, unknown> }[] = [];
  let itemSelectDone = false;
  const db = {
    select() {
      let table: unknown;
      const b: Record<string, unknown> = {
        from(t: unknown) { table = t; return b; },
        where() { return b; },
        orderBy() { return b; },
        limit() {
          if (table === items) {
            if (itemSelectDone) return Promise.resolve([]);
            itemSelectDone = true;
            return Promise.resolve(itemRows);
          }
          if (table === collections) return Promise.resolve([{ name: 'patients' }]);
          return Promise.resolve([]);
        },
      };
      return b;
    },
    update() {
      return {
        set(data: Record<string, unknown>) {
          return { where: () => { updates.push({ id: 'captured', data: data.data as Record<string, unknown> }); return Promise.resolve(undefined); } };
        },
      };
    },
  };
  return { db: db as unknown as Database, updates };
}

describe('rewrapBatch (Req 3.6)', () => {
  it('re-encrypts retired-key ciphertext onto the active key', async () => {
    const ctx = { siteId: 's1', collection: 'patients', field: 'ssn', recordId: 'i1' };
    // Ciphertext written under v0 while v0 was active.
    const oldKeys = new EnvKeyProvider(new Map([['v0', KEY_V0], ['v1', KEY_V1]]), 'v0');
    const v0Cipher = await new CryptoService(oldKeys).encrypt('123-45-6789', ctx);
    expect(v0Cipher.startsWith('v0:')).toBe(true);

    const { db, updates } = makeDb([{ id: 'i1', collectionId: 'c1', data: { name: 'Jane', ssn: v0Cipher } }]);
    // Now v1 is active.
    const keyProvider = new EnvKeyProvider(new Map([['v0', KEY_V0], ['v1', KEY_V1]]), 'v1');

    const res = await rewrapBatch({ db, siteId: 's1', keyProvider }, { batchSize: 100 });
    expect(res.scanned).toBe(1);
    expect(res.rewrapped).toBe(1);
    expect(res.nextCursor).toBeNull();

    const newCipher = updates[0]!.data.ssn as string;
    expect(newCipher.startsWith('v1:')).toBe(true);
    // Re-encrypted value still decrypts to the original under v1.
    expect(await new CryptoService(keyProvider).decrypt(newCipher, ctx)).toBe('123-45-6789');
  });

  it('skips ciphertext already on the active key (idempotent)', async () => {
    const ctx = { siteId: 's1', collection: 'patients', field: 'ssn', recordId: 'i1' };
    const keyProvider = new EnvKeyProvider(new Map([['v1', KEY_V1]]), 'v1');
    const v1Cipher = await new CryptoService(keyProvider).encrypt('x', ctx);

    const { db, updates } = makeDb([{ id: 'i1', collectionId: 'c1', data: { ssn: v1Cipher } }]);
    const res = await rewrapBatch({ db, siteId: 's1', keyProvider }, { batchSize: 100 });
    expect(res.rewrapped).toBe(0);
    expect(updates).toHaveLength(0);
  });
});
