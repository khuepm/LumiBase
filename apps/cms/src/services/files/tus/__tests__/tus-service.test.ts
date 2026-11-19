import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Database } from '@lumibase/database';
import { MemoryStorage, MemoryUploadSessionRepository } from '../../__tests__/memory-repo';
import { FileAssetError } from '../../file-asset-service';
import { sweepExpiredUploads } from '../expiry';
import { encodeUploadMetadata, parseNonNegativeInt, parseUploadMetadata, declarationFrom, SESSION_TTL_MS } from '../protocol';
import { TusService, safeKeySegment, tailKey } from '../tus-service';

const PART = 8; // tiny parts so the tail logic is exercised with small buffers
const NOW = new Date('2026-11-18T10:00:00Z');

function setup(now = () => NOW) {
  const repo = new MemoryUploadSessionRepository('site_a');
  const storage = new MemoryStorage();
  const tus = new TusService({ repo, storage, partSize: PART, now });
  return { repo, storage, tus };
}

const bytes = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) % 251);

async function create(tus: TusService, length: number) {
  return tus.create({ length, filename: 'clip final.mp4', mime: 'video/mp4', folder: null, userId: 'u1' });
}

describe('TusService (#704)', () => {
  it('stores fixed-size parts, buffers the remainder as a tail, and assembles the exact bytes', async () => {
    const { tus, storage } = setup();
    const data = bytes(30);
    const s = await create(tus, 30);
    expect(s.storageKey).toBe(`sites/site_a/uploads/${s.id}/clip_final.mp4`);

    let r = await tus.patch(s.id, 0, data.subarray(0, 5)); // < one part → all tail
    expect(r).toMatchObject({ completed: false, session: { offset: 5, tailSize: 5 } });
    expect(storage.objects.get(tailKey(s.storageKey))!.bytes.byteLength).toBe(5);

    r = await tus.patch(s.id, 5, data.subarray(5, 23)); // tail 5 + 18 = 23 → 2 parts + 7 tail
    expect(r.session).toMatchObject({ offset: 23, tailSize: 7 });
    expect((r.session.parts as unknown[]).length).toBe(2);

    r = await tus.patch(s.id, 23, data.subarray(23)); // final: 7 + 7 = 14 → 1 part + last 6
    expect(r.completed).toBe(true);
    expect(storage.partCalls.map((p) => p.size)).toEqual([8, 8, 8, 6]);
    expect([...storage.objects.get(s.storageKey)!.bytes]).toEqual([...data]);
    expect(storage.objects.has(tailKey(s.storageKey))).toBe(false);
  });

  it('survives a dropped connection: the failed PATCH commits nothing and the retry resumes from the stored offset', async () => {
    const { tus, storage, repo } = setup();
    const data = bytes(40, 7);
    const s = await create(tus, 40);
    await tus.patch(s.id, 0, data.subarray(0, 16));
    storage.failNextParts = 1;
    const err = await tus.patch(s.id, 16, data.subarray(16, 32)).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'STORAGE_ERROR', status: 503 });
    // Offset unchanged and the lease released: a client HEAD reads 16 and resumes.
    expect((await tus.active(s.id)).offset).toBe(16);
    expect((await repo.get(s.id))!.lockToken).toBeNull();
    await tus.patch(s.id, 16, data.subarray(16, 32));
    const done = await tus.patch(s.id, 32, data.subarray(32));
    expect(done.completed).toBe(true);
    expect([...storage.objects.get(s.storageKey)!.bytes]).toEqual([...data]);
  });

  it('refuses wrong offsets, overflow, and a concurrent writer', async () => {
    const { tus, repo } = setup();
    const s = await create(tus, 20);
    await expect(tus.patch(s.id, 3, bytes(4))).rejects.toMatchObject({ code: 'OFFSET_MISMATCH', status: 409, details: { offset: 0 } });
    await expect(tus.patch(s.id, 0, bytes(21))).rejects.toMatchObject({ code: 'UPLOAD_TOO_LARGE', status: 413 });
    // Someone else holds a live lease.
    await repo.claim(s.id, 0, 'other', new Date(NOW.getTime() + 60_000), NOW);
    await expect(tus.patch(s.id, 0, bytes(4))).rejects.toMatchObject({ code: 'UPLOAD_LOCKED', status: 409 });
  });

  it('reclaims a lease whose holder crashed', async () => {
    let now = NOW;
    const { tus, repo } = setup(() => now);
    const s = await create(tus, 4);
    await repo.claim(s.id, 0, 'crashed', new Date(NOW.getTime() + 60_000), NOW);
    now = new Date(NOW.getTime() + 120_000);
    expect((await tus.patch(s.id, 0, bytes(4))).completed).toBe(true);
  });

  it('handles a file smaller than one part and an exact multiple of the part size', async () => {
    const small = setup();
    const a = await create(small.tus, 3);
    expect((await small.tus.patch(a.id, 0, bytes(3))).completed).toBe(true);
    expect(small.storage.partCalls.map((p) => p.size)).toEqual([3]);

    const exact = setup();
    const b = await create(exact.tus, 16);
    await exact.tus.patch(b.id, 0, bytes(8));
    expect((await exact.tus.patch(b.id, 8, bytes(8, 3))).completed).toBe(true);
    expect(exact.storage.partCalls.map((p) => p.size)).toEqual([8, 8]);
  });

  it('terminates (aborts the multipart upload and drops the tail), and expired uploads read 410', async () => {
    let now = NOW;
    const { tus, storage } = setup(() => now);
    const s = await create(tus, 20);
    await tus.patch(s.id, 0, bytes(3));
    await tus.terminate(s.id);
    expect([...storage.multiparts.values()][0]!.aborted).toBe(true);
    expect(storage.objects.has(tailKey(s.storageKey))).toBe(false);
    await expect(tus.active(s.id)).rejects.toMatchObject({ status: 404 });

    const t = await create(tus, 20);
    now = new Date(NOW.getTime() + SESSION_TTL_MS + 1);
    await expect(tus.active(t.id)).rejects.toMatchObject({ code: 'UPLOAD_EXPIRED', status: 410 });
  });

  it('rejects empty uploads and backends without multipart', async () => {
    const { tus } = setup();
    await expect(create(tus, 0)).rejects.toBeInstanceOf(FileAssetError);
    const plain = new TusService({
      repo: new MemoryUploadSessionRepository('s'),
      storage: { put: async () => undefined, get: async () => null, delete: async () => undefined, list: async () => ({ keys: [] }) },
    });
    await expect(create(plain, 10)).rejects.toMatchObject({ code: 'RESUMABLE_UNSUPPORTED' });
  });

  it('assembles exactly the input for any chunking, with every non-final part of the fixed size (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 1, maxLength: 80 }), fc.array(fc.integer({ min: 1, max: 20 }), { minLength: 1, maxLength: 20 }), async (data, cuts) => {
        const { tus, storage } = setup();
        const s = await create(tus, data.byteLength);
        let offset = 0;
        let i = 0;
        let done = false;
        while (!done) {
          const n = Math.min(cuts[i++ % cuts.length]!, data.byteLength - offset);
          const r = await tus.patch(s.id, offset, data.subarray(offset, offset + n));
          offset += n;
          done = r.completed;
        }
        expect([...storage.objects.get(s.storageKey)!.bytes]).toEqual([...data]);
        const sizes = storage.partCalls.map((p) => p.size);
        expect(sizes.slice(0, -1).every((x) => x === PART)).toBe(true);
        expect(sizes.at(-1)!).toBeLessThanOrEqual(PART);
      }),
      { numRuns: 60 },
    );
  });
});

describe('expiry sweeper (#704)', () => {
  it('aborts each expired session once and cleans its storage', async () => {
    let now = NOW;
    const { tus, storage, repo } = setup(() => now);
    const a = await create(tus, 20);
    await tus.patch(a.id, 0, bytes(3));
    now = new Date(NOW.getTime() + SESSION_TTL_MS + 1);
    const findExpired = async (at: Date) => [...repo.rows.values()].filter((r) => r.status === 'active' && r.expiresAt < at).map((r) => ({ ...r }));
    const abort = async (_site: string, id: string) => (await repo.get(id))?.status === 'active' && !!(await repo.finish(id, { status: 'aborted' }));
    const deps = { db: {} as Database, storage, now: () => now, findExpired, abort };
    expect(await sweepExpiredUploads(deps)).toEqual({ expired: 1 });
    expect([...storage.multiparts.values()][0]!.aborted).toBe(true);
    expect(storage.objects.has(tailKey(a.storageKey))).toBe(false);
    expect(await sweepExpiredUploads(deps)).toEqual({ expired: 0 });
  });
});

describe('protocol helpers', () => {
  it('round-trips Upload-Metadata (UTF-8, empty values) and rejects malformed headers', () => {
    const header = encodeUploadMetadata({ filename: 'Ảnh đẹp.jpg', filetype: 'image/jpeg' }) + ',is_confidential';
    expect(parseUploadMetadata(header)).toEqual({ filename: 'Ảnh đẹp.jpg', filetype: 'image/jpeg', is_confidential: '' });
    expect(parseUploadMetadata('filename !!!')).toBeNull();
    expect(parseUploadMetadata('a YQ==,a YQ==')).toBeNull();
    expect(parseUploadMetadata(undefined)).toEqual({});
    expect(declarationFrom({ filename: 'a.png', filetype: 'image/PNG; charset=x', folder: 'f1' })).toEqual({ filename: 'a.png', mime: 'image/png', folder: 'f1' });
    expect(declarationFrom({ filename: 'a.png' })).toBeNull();
    expect(parseNonNegativeInt('42')).toBe(42);
    expect(parseNonNegativeInt('-1')).toBeNull();
    expect(parseNonNegativeInt('1e3')).toBeNull();
    expect(safeKeySegment('../../etc/pass wd')).toBe('pass_wd');
    expect(safeKeySegment('...')).toBe('upload');
  });
});
