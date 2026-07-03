import { describe, it, expect, vi } from 'vitest';
import { assertClassificationEncryptable, SchemaServiceError } from '../schema-service';
import { ItemService } from '../item-service';
import { CryptoService } from '../crypto-service';
import type { Database } from '@lumibase/database';

describe('assertClassificationEncryptable (Req 5.2)', () => {
  it('rejects pii/phi without encryption (422)', () => {
    for (const classification of ['pii', 'phi'] as const) {
      try {
        assertClassificationEncryptable(classification, false);
        throw new Error('expected to throw');
      } catch (e) {
        expect(e).toBeInstanceOf(SchemaServiceError);
        expect((e as SchemaServiceError).code).toBe('CLASSIFICATION_REQUIRES_ENCRYPTION');
        expect((e as SchemaServiceError).status).toBe(422);
      }
    }
  });

  it('allows pii/phi when encrypted, and none/internal regardless', () => {
    expect(() => assertClassificationEncryptable('pii', true)).not.toThrow();
    expect(() => assertClassificationEncryptable('phi', true)).not.toThrow();
    expect(() => assertClassificationEncryptable('none', false)).not.toThrow();
    expect(() => assertClassificationEncryptable('internal', false)).not.toThrow();
    expect(() => assertClassificationEncryptable(undefined, undefined)).not.toThrow();
  });
});

const ENCRYPTION_KEY = 'v8/w2R+g2g/v8/w2R+g2g/v8/w2R+g2g/v8/w2R+g2g=';

vi.mock('../schema-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../schema-service')>();
  return {
    ...actual,
    SchemaService: vi.fn().mockImplementation(() => ({
      getCompiled: vi.fn().mockResolvedValue({
        fields: [
          { name: 'name', type: 'string' },
          { name: 'ssn', type: 'string', encrypted: true, classification: 'phi' },
        ],
      }),
    })),
  };
});

describe('Field_Access_Log on decrypted pii/phi reads (Req 6.1)', () => {
  it('writes an access-log row when a phi field is decrypted for an actor', async () => {
    const inserted: unknown[] = [];
    const mockDb = {
      insert: () => ({ values: async (v: unknown) => inserted.push(v) }),
    } as unknown as Database;

    const service = new ItemService({
      db: mockDb,
      siteId: 'site1',
      userId: 'user-1',
      encryptionKey: ENCRYPTION_KEY,
    });
    vi.spyOn(service as any, 'perm').mockResolvedValue({ fields: ['*'], validation: {} });

    const ssn = await CryptoService.fromKey(ENCRYPTION_KEY).encrypt('123-45-6789', {
      siteId: 'site1',
      collection: 'patients',
      field: 'ssn',
      recordId: 'rec-1',
    });

    const out = await (service as any).processCrypto(
      'patients',
      { name: 'Jane', ssn },
      'decrypt',
      'rec-1',
      false,
    );

    expect(out.ssn).toBe('123-45-6789');
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      siteId: 'site1',
      collection: 'patients',
      fields: ['ssn'],
      recordIds: ['rec-1'],
      action: 'read_decrypted',
      actor: 'user-1',
    });
  });

  it('does not log when the field is masked (no read_decrypted)', async () => {
    const inserted: unknown[] = [];
    const mockDb = {
      insert: () => ({ values: async (v: unknown) => inserted.push(v) }),
    } as unknown as Database;

    const service = new ItemService({
      db: mockDb,
      siteId: 'site1',
      encryptionKey: ENCRYPTION_KEY,
    });
    vi.spyOn(service as any, 'perm').mockResolvedValue(null);

    const out = await (service as any).processCrypto(
      'patients',
      { name: 'Jane', ssn: 'v0:whatever' },
      'decrypt',
      'rec-1',
      false,
    );

    expect(out.ssn).toBe('***');
    expect(inserted).toHaveLength(0);
  });
});
