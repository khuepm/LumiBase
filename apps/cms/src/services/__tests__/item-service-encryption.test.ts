import { describe, it, expect, vi } from 'vitest';
import { ItemService } from '../item-service';
import type { Database } from '@lumibase/database';
import { CryptoService } from '../crypto-service';

const ENCRYPTION_KEY = 'v8/w2R+g2g/v8/w2R+g2g/v8/w2R+g2g/v8/w2R+g2g=';
const siteId = 'test-site';

// Instead of trying to mock the entire Drizzle builder which is complex, we will test the internal method:
// ItemService.prototype['processCrypto'] which does the heavy lifting.
// Since it's private, we can bypass TypeScript privacy by casting to `any`.
// This is perfectly valid in unit/integration testing of complex services.

// We need a minimal mock of SchemaService first to provide the schema compile info.
vi.mock('../schema-service', () => {
  return {
    SchemaService: vi.fn().mockImplementation(() => {
      return {
        getCompiled: vi.fn().mockImplementation(async (collectionName) => {
          if (collectionName === 'secure_table') {
            return {
              fields: [
                { name: 'id', type: 'uuid' },
                { name: 'public_field', type: 'string' },
                { name: 'secret_field', type: 'string', encrypted: true }
              ]
            };
          }
          return { fields: [] };
        })
      };
    })
  };
});

describe('ItemService Encryption (Integration with CryptoService)', () => {

  it('should encrypt sensitive fields defined in schema', async () => {
    // We only provide a dummy DB since we're calling processCrypto directly
    const mockDb = {} as Database;
    const service = new ItemService({ db: mockDb, siteId, encryptionKey: ENCRYPTION_KEY });

    const inputData = {
      public_field: 'visible_data',
      secret_field: 'hidden_data'
    };

    // internal = true (for encrypt before saving)
    const processed = await (service as any).processCrypto('secure_table', inputData, 'encrypt', true);

    expect(processed.public_field).toBe('visible_data');
    expect(processed.secret_field).not.toBe('hidden_data');
    expect(typeof processed.secret_field).toBe('string');
  });

  it('should decrypt sensitive fields when internal = true (e.g. evaluating before update)', async () => {
    const mockDb = {} as Database;
    const service = new ItemService({ db: mockDb, siteId, encryptionKey: ENCRYPTION_KEY });
    const cryptoService = new CryptoService(ENCRYPTION_KEY);
    const encryptedSecret = await cryptoService.encrypt('hidden_data');

    const dbRowData = {
      public_field: 'visible_data',
      secret_field: encryptedSecret
    };

    const processed = await (service as any).processCrypto('secure_table', dbRowData, 'decrypt', true);

    expect(processed.public_field).toBe('visible_data');
    expect(processed.secret_field).toBe('hidden_data');
  });

  it('should decrypt sensitive fields when internal = false AND user has read_decrypted perm', async () => {
    const mockDb = {} as Database;
    const service = new ItemService({ db: mockDb, siteId, encryptionKey: ENCRYPTION_KEY });

    // Mock perm() to allow read_decrypted
    vi.spyOn(service as any, 'perm').mockResolvedValue({ fields: ['*'], validation: {} });

    const cryptoService = new CryptoService(ENCRYPTION_KEY);
    const encryptedSecret = await cryptoService.encrypt('top_secret_info');

    const dbRowData = {
      public_field: 'visible_data',
      secret_field: encryptedSecret
    };

    const processed = await (service as any).processCrypto('secure_table', dbRowData, 'decrypt', false);

    expect(processed.public_field).toBe('visible_data');
    expect(processed.secret_field).toBe('top_secret_info');
  });

  it('should mask sensitive fields with *** when internal = false AND user lacks read_decrypted perm', async () => {
    const mockDb = {} as Database;
    const service = new ItemService({ db: mockDb, siteId, encryptionKey: ENCRYPTION_KEY });

    // Mock perm() to return null (deny) for read_decrypted
    vi.spyOn(service as any, 'perm').mockImplementation(async (collection, action) => {
       if (action === 'read_decrypted') return null; // denied
       return { fields: ['*'], validation: {} };
    });

    const cryptoService = new CryptoService(ENCRYPTION_KEY);
    const encryptedSecret = await cryptoService.encrypt('top_secret_info');

    const dbRowData = {
      public_field: 'visible_data',
      secret_field: encryptedSecret
    };

    const processed = await (service as any).processCrypto('secure_table', dbRowData, 'decrypt', false);

    expect(processed.public_field).toBe('visible_data');
    expect(processed.secret_field).toBe('***');
  });

  it('should mask sensitive fields with *** when perm check throws an error (e.g. forbidden)', async () => {
    const mockDb = {} as Database;
    const service = new ItemService({ db: mockDb, siteId, encryptionKey: ENCRYPTION_KEY });

    vi.spyOn(service as any, 'perm').mockImplementation(async () => {
       throw new Error('Forbidden');
    });

    const cryptoService = new CryptoService(ENCRYPTION_KEY);
    const encryptedSecret = await cryptoService.encrypt('top_secret_info');

    const dbRowData = {
      public_field: 'visible_data',
      secret_field: encryptedSecret
    };

    const processed = await (service as any).processCrypto('secure_table', dbRowData, 'decrypt', false);

    expect(processed.public_field).toBe('visible_data');
    expect(processed.secret_field).toBe('***');
  });
});
