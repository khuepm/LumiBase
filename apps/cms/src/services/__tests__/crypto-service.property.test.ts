import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { CryptoService, DecryptionError } from '../crypto-service';

const TEST_KEY = Buffer.alloc(32, 3).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 4).toString('base64');

const ctxArb = fc.record({
  siteId: fc.string({ minLength: 1, maxLength: 12 }),
  collection: fc.string({ minLength: 1, maxLength: 12 }),
  field: fc.string({ minLength: 1, maxLength: 12 }),
  recordId: fc.string({ minLength: 1, maxLength: 12 }),
});

// JSON-serialisable values the field encoder must round-trip.
const valueArb = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.boolean(),
  fc.record({ a: fc.string(), b: fc.integer() }),
  fc.array(fc.string()),
);

describe('CryptoService property tests', () => {
  it('decrypt(encrypt(x)) === x for any context', async () => {
    await fc.assert(
      fc.asyncProperty(ctxArb, valueArb, async (ctx, value) => {
        const svc = CryptoService.fromKey(TEST_KEY);
        const ct = await svc.encrypt(value, ctx);
        expect(await svc.decrypt(ct, ctx)).toEqual(value);
      }),
      { numRuns: 60 },
    );
  });

  it('rejects decryption when any AAD component differs', async () => {
    await fc.assert(
      fc.asyncProperty(
        ctxArb,
        valueArb,
        fc.constantFrom('siteId', 'collection', 'field', 'recordId'),
        async (ctx, value, mutate) => {
          const svc = CryptoService.fromKey(TEST_KEY);
          const ct = await svc.encrypt(value, ctx);
          const tampered = { ...ctx, [mutate]: `${ctx[mutate as keyof typeof ctx]}X` };
          await expect(svc.decrypt(ct, tampered)).rejects.toBeInstanceOf(DecryptionError);
        },
      ),
      { numRuns: 40 },
    );
  });

  it('rejects decryption with a different key', async () => {
    await fc.assert(
      fc.asyncProperty(ctxArb, valueArb, async (ctx, value) => {
        const ct = await CryptoService.fromKey(TEST_KEY).encrypt(value, ctx);
        await expect(CryptoService.fromKey(OTHER_KEY).decrypt(ct, ctx)).rejects.toBeInstanceOf(
          DecryptionError,
        );
      }),
      { numRuns: 40 },
    );
  });
});
